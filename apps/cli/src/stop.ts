/**
 * Stopping a run set politely, then firmly.
 *
 *   first Ctrl-C   start nothing new; the runs in flight finish and are recorded
 *   second Ctrl-C  abort the runs in flight; they are discarded
 *   third Ctrl-C   exit now
 *
 * The runner does the stopping (`drainSignal`, then `signal`) and writes the
 * manifest as `interrupted`, so the run set can be resumed. This module only
 * decides which signal a key press means.
 *
 * On a terminal, Ctrl-C is read as a key rather than left to the terminal.
 * A terminal delivers SIGINT to the whole foreground process group, which
 * includes every Claude Code subprocess the SDK has started: the runs that
 * the first Ctrl-C promises to let finish would be interrupted underneath
 * it. With the terminal's input in raw mode no SIGINT is generated at all,
 * and the key reaches only this process. SIGINT from elsewhere (`kill -INT`)
 * is handled the same way; SIGTERM and SIGHUP abort at once.
 */

export type StopStage = 'running' | 'draining' | 'aborting';

export type StopAction = 'drain' | 'abort' | 'force';

export class StopController {
  readonly drain = new AbortController();
  readonly abort = new AbortController();
  #stage: StopStage = 'running';
  #listeners: ((stage: StopStage) => void)[] = [];

  get stage(): StopStage {
    return this.#stage;
  }

  /** One Ctrl-C: drain on the first, abort on the second, force on any after. */
  press(): StopAction {
    if (this.#stage === 'running') {
      this.#set('draining');
      this.drain.abort();
      return 'drain';
    }
    if (this.#stage === 'draining') {
      this.abortNow();
      return 'abort';
    }
    return 'force';
  }

  /** Abort the runs in flight without the polite first step. */
  abortNow(): void {
    if (this.#stage === 'aborting') return;
    this.#set('aborting');
    this.drain.abort();
    this.abort.abort();
  }

  onChange(listener: (stage: StopStage) => void): void {
    this.#listeners.push(listener);
  }

  #set(stage: StopStage): void {
    this.#stage = stage;
    for (const listener of this.#listeners) {
      try {
        listener(stage);
      } catch {
        // A display problem must not stop the stopping.
      }
    }
  }
}

/** The part of a TTY input stream used here. */
export interface KeyInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** The part of `process` used here. */
export interface SignalSource {
  on(event: NodeJS.Signals | 'exit', listener: () => void): unknown;
  off(event: NodeJS.Signals | 'exit', listener: () => void): unknown;
}

const CTRL_C = 0x03;

export interface InterruptOptions {
  /** Keyboard input, read in raw mode when it is a TTY. */
  input?: KeyInput;
  signals: SignalSource;
  /** Called on a third Ctrl-C, after the terminal has been restored. */
  onForce: () => void;
}

/** Wire `controller` to the keyboard and to signals. Returns a function that undoes it all. */
export function installInterruptHandlers(controller: StopController, options: InterruptOptions): () => void {
  const { input, signals } = options;
  let restored = false;
  let raw = false;

  const restore = () => {
    if (restored) return;
    restored = true;
    if (input && raw) {
      input.off('data', onData);
      try {
        input.setRawMode?.(false);
      } catch {
        // The terminal may already be gone.
      }
      input.pause();
    }
    signals.off('SIGINT', onInterrupt);
    signals.off('SIGTERM', onTerminate);
    signals.off('SIGHUP', onTerminate);
    signals.off('exit', restore);
  };

  const onInterrupt = () => {
    if (controller.press() === 'force') {
      restore();
      options.onForce();
    }
  };
  const onTerminate = () => controller.abortNow();
  const onData = (chunk: Buffer | string) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    for (const byte of bytes) if (byte === CTRL_C) onInterrupt();
  };

  if (input?.isTTY && typeof input.setRawMode === 'function') {
    try {
      input.setRawMode(true);
      raw = true;
      input.on('data', onData);
      input.resume();
    } catch {
      raw = false;
    }
  }
  signals.on('SIGINT', onInterrupt);
  signals.on('SIGTERM', onTerminate);
  signals.on('SIGHUP', onTerminate);
  // Never leave a terminal in raw mode, whatever ends the process.
  signals.on('exit', restore);
  return restore;
}
