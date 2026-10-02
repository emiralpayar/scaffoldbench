/**
 * Putting run progress on a stream: the redrawn live view on a terminal,
 * one line per run anywhere else (CI logs, pipes, `--plain`).
 */

import { MODEL_STOP_LABELS } from '@arena/core';
import type { RunnerEvent, TraceEvent } from '@arena/core';

import { formatDuration, formatScore, formatUsd } from './format';
import { applyRunnerEvent, applyTraceEvent, cellGlyph, outcomeOf, renderLiveFrame } from './live';
import type { LiveState } from './live';
import { GLYPH, padStart } from './style';
import type { Style } from './style';
import type { StopStage } from './stop';

export interface Reporter {
  onEvent(event: RunnerEvent): void;
  onTrace?(runId: string, event: TraceEvent): void;
  onStop(stage: StopStage): void;
  /** Draw the last state and give the terminal back. */
  finish(): void;
}

export interface OutputStream {
  write(chunk: string): boolean;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  on?(event: 'resize', listener: () => void): unknown;
  off?(event: 'resize', listener: () => void): unknown;
}

const ESC = '\u001b[';
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
// Terminals that support synchronized output draw a frame at once instead of
// line by line; the rest ignore the sequence.
const BEGIN_SYNC = `${ESC}?2026h`;
const END_SYNC = `${ESC}?2026l`;
const FRAME_MS = 100;

/**
 * Redraws the live frame in place, ten times a second. Each frame moves the
 * cursor back to the top of the previous one, rewrites every line and clears
 * whatever the previous frame had below. Lines are clipped to the terminal's
 * width so none wraps, which would throw the line count off.
 */
export class LiveReporter implements Reporter {
  readonly #state: LiveState;
  readonly #stream: OutputStream;
  readonly #style: Style;
  readonly #now: () => number;
  #drawn = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #finished = false;
  readonly #onResize = () => this.#draw();
  readonly #restore = () => this.#stream.write(SHOW_CURSOR);

  constructor(state: LiveState, stream: OutputStream, style: Style, now: () => number = Date.now) {
    this.#state = state;
    this.#stream = stream;
    this.#style = style;
    this.#now = now;
    stream.write(HIDE_CURSOR);
    process.once('exit', this.#restore);
    stream.on?.('resize', this.#onResize);
    this.#timer = setInterval(() => this.#draw(), FRAME_MS);
    this.#timer.unref?.();
    this.#draw();
  }

  onEvent(event: RunnerEvent): void {
    applyRunnerEvent(this.#state, event, this.#now());
  }

  onTrace(runId: string, event: TraceEvent): void {
    applyTraceEvent(this.#state, runId, event);
  }

  onStop(stage: StopStage): void {
    this.#state.stage = stage;
    this.#draw();
  }

  finish(): void {
    if (this.#finished) return;
    this.#state.stage = 'finished';
    this.#draw(false);
    this.#finished = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#stream.off?.('resize', this.#onResize);
    process.off('exit', this.#restore);
    this.#stream.write(SHOW_CURSOR);
  }

  #draw(live = true): void {
    if (this.#finished) return;
    const lines = renderLiveFrame(this.#state, {
      width: (this.#stream.columns ?? 100) - 1,
      height: this.#stream.rows ?? 30,
      now: this.#now(),
      style: this.#style,
      live,
    });
    const up = this.#drawn > 0 ? `${ESC}${this.#drawn}F` : '';
    const body = lines.map((line) => `${ESC}2K${line}`).join('\n');
    this.#stream.write(`${BEGIN_SYNC}${up}${body}\n${ESC}J${END_SYNC}`);
    this.#drawn = lines.length;
  }
}

/**
 * One line per finished run, for logs. Every line can be read on its own:
 * position, outcome glyph, run id, score, cost, latency and why it failed.
 */
export class PlainReporter implements Reporter {
  readonly #stream: OutputStream;
  readonly #style: Style;
  readonly #state: LiveState;
  #done = 0;

  constructor(state: LiveState, stream: OutputStream, style: Style) {
    this.#state = state;
    this.#stream = stream;
    this.#style = style;
  }

  #line(text: string): void {
    this.#stream.write(`${text}\n`);
  }

  #counter(total: number): string {
    return `[${padStart(String(this.#done), String(total).length)}/${total}]`;
  }

  onEvent(event: RunnerEvent): void {
    const style = this.#style;
    applyRunnerEvent(this.#state, event, Date.now());
    switch (event.type) {
      case 'run-end': {
        this.#done += 1;
        const record = event.record;
        const outcome = outcomeOf(record);
        const glyph = cellGlyph({ kind: 'done', outcome }, 0, style);
        let why = record.failureMode === 'none' ? '' : record.failureMode;
        if (record.failureMode === 'model_stop') {
          const reasons = [...new Set((record.modelStops ?? []).map((stop) => MODEL_STOP_LABELS[stop.reason]))];
          why = `model_stop${reasons.length > 0 ? `: ${reasons.join(', ')}` : ''}`;
        }
        if (outcome === 'integrity') {
          const failed = record.integrity?.checks.filter((check) => !check.ok).map((check) => check.id) ?? [];
          why = `${record.failureMode}; integrity failed: ${failed.join(', ')}`;
        } else if (outcome === 'api_error') {
          why = `api_error: ${(record.error ?? '').split('\n')[0]}`;
        }
        const retried = (record.attempts ?? 1) > 1 ? ` (attempt ${record.attempts})` : '';
        this.#line(
          `${this.#counter(event.total)} ${glyph} ${record.runId}  ` +
            `${formatScore(record.score)}  ${padStart(formatUsd(record.costUsd + record.judgeCostUsd), 8)}  ` +
            `${padStart(formatDuration(record.latencyMs), 7)}` +
            (why ? `  ${outcome === 'pass' || outcome === 'partial' || outcome === 'fail' ? why : style.bad(why)}` : '') +
            retried,
        );
        return;
      }
      case 'run-retry':
        this.#line(
          style.warn(
            `${GLYPH.retry} ${event.runId}: attempt ${event.attempt} failed at the API (${event.error.split('\n')[0]}); ` +
              `retrying in ${formatDuration(event.delayMs)}`,
          ),
        );
        return;
      case 'run-interrupted':
        this.#done += 1;
        this.#line(style.dim(`${GLYPH.discarded} ${event.runId}: cut off by the stop and discarded`));
        return;
      case 'run-error':
        this.#done += 1;
        this.#line(style.bad(`${GLYPH.integrity} ${event.runId} produced no record: ${event.error}`));
        return;
      case 'budget-stop':
        this.#line(style.warn(`Total budget reached (${formatUsd(event.spentUsd)} settled): no new runs will start.`));
        return;
      case 'stop':
        this.#line(style.warn(event.message));
        return;
      default:
        return;
    }
  }

  onStop(stage: StopStage): void {
    if (stage === 'draining') {
      this.#line(
        this.#style.warn(
          `Stopping: no new runs will start; ${this.#state.inFlight.size} in flight will finish. Interrupt again to abort them.`,
        ),
      );
    } else if (stage === 'aborting') {
      this.#line(this.#style.warn('Aborting the runs in flight; they are discarded and run again on --resume.'));
    }
  }

  finish(): void {
    // Nothing to restore.
  }
}
