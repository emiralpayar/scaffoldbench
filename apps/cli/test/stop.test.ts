import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { StopController, installInterruptHandlers } from '../src/stop';
import type { KeyInput } from '../src/stop';

/** A terminal's input as `installInterruptHandlers` sees it. */
class FakeKeyboard extends EventEmitter implements KeyInput {
  isTTY = true;
  raw = false;
  paused = true;
  setRawMode = (mode: boolean) => {
    this.raw = mode;
    return this;
  };
  resume = () => {
    this.paused = false;
    return this;
  };
  pause = () => {
    this.paused = true;
    return this;
  };
}

describe('StopController', () => {
  it('drains on the first press, aborts on the second, and forces after that', () => {
    const stop = new StopController();
    const stages: string[] = [];
    stop.onChange((stage) => stages.push(stage));

    expect(stop.press()).toBe('drain');
    expect(stop.drain.signal.aborted).toBe(true);
    expect(stop.abort.signal.aborted).toBe(false);

    expect(stop.press()).toBe('abort');
    expect(stop.abort.signal.aborted).toBe(true);

    expect(stop.press()).toBe('force');
    expect(stages).toEqual(['draining', 'aborting']);
  });

  it('aborts at once on a terminate, and only once', () => {
    const stop = new StopController();
    const stages: string[] = [];
    stop.onChange((stage) => stages.push(stage));
    stop.abortNow();
    stop.abortNow();
    expect(stop.drain.signal.aborted && stop.abort.signal.aborted).toBe(true);
    expect(stages).toEqual(['aborting']);
  });
});

describe('installInterruptHandlers', () => {
  it('reads Ctrl-C as a key on a terminal, so the subprocesses never see a SIGINT', () => {
    const stop = new StopController();
    const keyboard = new FakeKeyboard();
    const signals = new EventEmitter();
    const onForce = vi.fn();
    const restore = installInterruptHandlers(stop, { input: keyboard, signals, onForce });

    expect(keyboard.raw).toBe(true);
    expect(keyboard.paused).toBe(false);

    keyboard.emit('data', Buffer.from('x'));
    expect(stop.stage).toBe('running');

    keyboard.emit('data', Buffer.from([0x03]));
    expect(stop.stage).toBe('draining');
    keyboard.emit('data', '\u0003');
    expect(stop.stage).toBe('aborting');
    keyboard.emit('data', Buffer.from([0x03]));
    expect(onForce).toHaveBeenCalledTimes(1);
    // Forcing restored the terminal before handing over.
    expect(keyboard.raw).toBe(false);

    restore();
  });

  it('treats SIGINT like a key press and SIGTERM or SIGHUP as an abort', () => {
    const signals = new EventEmitter();
    const first = new StopController();
    const restoreFirst = installInterruptHandlers(first, { signals, onForce: () => undefined });
    signals.emit('SIGINT');
    expect(first.stage).toBe('draining');
    restoreFirst();

    for (const signal of ['SIGTERM', 'SIGHUP']) {
      const stop = new StopController();
      const restore = installInterruptHandlers(stop, { signals, onForce: () => undefined });
      signals.emit(signal);
      expect(stop.stage, signal).toBe('aborting');
      restore();
    }
  });

  it('puts everything back: raw mode off, input paused, every listener removed', () => {
    const stop = new StopController();
    const keyboard = new FakeKeyboard();
    const signals = new EventEmitter();
    const restore = installInterruptHandlers(stop, { input: keyboard, signals, onForce: () => undefined });
    restore();
    restore();

    expect(keyboard.raw).toBe(false);
    expect(keyboard.paused).toBe(true);
    expect(keyboard.listenerCount('data')).toBe(0);
    for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit']) expect(signals.listenerCount(event), event).toBe(0);

    signals.emit('SIGINT');
    expect(stop.stage).toBe('running');
  });

  it('restores the terminal when the process exits underneath it', () => {
    const keyboard = new FakeKeyboard();
    const signals = new EventEmitter();
    installInterruptHandlers(new StopController(), { input: keyboard, signals, onForce: () => undefined });
    signals.emit('exit');
    expect(keyboard.raw).toBe(false);
  });

  it('leaves a non-terminal input alone and still listens for signals', () => {
    const keyboard = new FakeKeyboard();
    keyboard.isTTY = false;
    const signals = new EventEmitter();
    const restore = installInterruptHandlers(new StopController(), { input: keyboard, signals, onForce: () => undefined });
    expect(keyboard.raw).toBe(false);
    expect(keyboard.listenerCount('data')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(1);
    restore();
  });
});
