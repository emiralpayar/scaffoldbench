import { describe, expect, it } from 'vitest';

import { COMMANDS, DEFAULT_JUDGE_EFFORT, parseArgs } from '../src/args';
import type { ParsedCommand, ReportArgs, RunArgs } from '../src/args';
import { commandHelp, generalHelp } from '../src/help';
import { DEFAULT_JUDGE_EFFORT as CORE_JUDGE_EFFORT } from '@arena/core';

/** Narrow a ParsedCommand to a successful `run`, failing loudly otherwise. */
function expectRun(parsed: ParsedCommand): RunArgs {
  if (!parsed.ok) throw new Error(`expected a parse success, got: ${parsed.error}`);
  if (parsed.command !== 'run') throw new Error(`expected the run command, got: ${parsed.command}`);
  return parsed.args;
}

function expectReport(parsed: ParsedCommand): ReportArgs {
  if (!parsed.ok) throw new Error(`expected a parse success, got: ${parsed.error}`);
  if (parsed.command !== 'report') throw new Error(`expected the report command, got: ${parsed.command}`);
  return parsed.args;
}

function expectError(parsed: ParsedCommand): string {
  if (parsed.ok) throw new Error(`expected a parse error, got command: ${parsed.command}`);
  return parsed.error;
}

describe('parseArgs: run', () => {
  it('applies documented defaults with an empty environment', () => {
    const args = expectRun(parseArgs(['run'], {}));

    expect(args.strategies).toEqual(['all']);
    expect(args.tasks).toEqual(['all']);
    expect(args.models).toEqual(['claude-sonnet-5-5']);
    expect(args.repeats).toBe(3);
    expect(args.effort).toBe('high');
    expect(args.concurrency).toBe(4);
    expect(args.maxCostUsd).toBe(1.0);
    expect(args.maxSeconds).toBe(600);
    expect(args.totalBudgetUsd).toBe(25);
    expect(args.judgeModel).toBe('claude-sonnet-5-5');
    expect(args.judgeEffort).toBe('medium');
    expect(args.judgeSamples).toBe(3);
    expect(args.fixtureMode).toBe('replay');
    expect(args.persist).toBe(true);
    expect(args.dryRun).toBe(false);
    expect(args.updateLatest).toBe(false);
    expect(args.plain).toBe(false);
    expect(args.runSetId).toBeUndefined();
    expect(args.resume).toBeUndefined();
    expect(args.explicit.size).toBe(0);
  });

  it('keeps the judge effort default in step with core', () => {
    expect(DEFAULT_JUDGE_EFFORT).toBe(CORE_JUDGE_EFFORT);
  });

  it('takes models, the judge and the per-run cap from the environment', () => {
    const args = expectRun(
      parseArgs(['run'], {
        ARENA_MODEL: 'claude-haiku-4-5-20251001, claude-sonnet-5-5',
        ARENA_JUDGE_MODEL: 'claude-opus-5-5',
        ARENA_MAX_COST_USD: '0.25',
      }),
    );

    expect(args.models).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-5-5']);
    expect(args.judgeModel).toBe('claude-opus-5-5');
    expect(args.maxCostUsd).toBe(0.25);
    // The environment supplies defaults; only flags are explicit.
    expect(args.explicit.size).toBe(0);
  });

  it('treats empty variables, as an empty .env line leaves them, as unset', () => {
    const args = expectRun(parseArgs(['run'], { ARENA_MODEL: '  ', ARENA_JUDGE_MODEL: '', ARENA_MAX_COST_USD: '' }));

    expect(args.models).toEqual(['claude-sonnet-5-5']);
    expect(args.judgeModel).toBe('claude-sonnet-5-5');
    expect(args.maxCostUsd).toBe(1);
  });

  it('lets an explicit flag beat the environment', () => {
    const args = expectRun(parseArgs(['run', '--model', 'claude-haiku-4-5-20251001'], { ARENA_MODEL: 'claude-sonnet-5-5' }));

    expect(args.models).toEqual(['claude-haiku-4-5-20251001']);
    expect(args.explicit.has('models')).toBe(true);
  });

  it('accumulates --models and --model into one de-duplicated list', () => {
    const args = expectRun(
      parseArgs(['run', '--models', 'a,b', '--model', 'c', '--models', 'b'], {}),
    );

    expect(args.models).toEqual(['a', 'b', 'c']);
  });

  it('reads every run flag', () => {
    const args = expectRun(
      parseArgs(
        [
          'run',
          '--strategies', 'single,plan-execute',
          '--tasks', 'airline,research',
          '--models', 'claude-sonnet-5-5,claude-opus-5-5',
          '--repeats', '5',
          '--effort', 'max',
          '--concurrency', '8',
          '--max-cost', '2.5',
          '--max-seconds', '900',
          '--total-budget', '40',
          '--judge-model', 'claude-haiku-4-5-20251001',
          '--judge-effort', 'low',
          '--judge-samples', '5',
          '--record',
          '--run-set', 'my-set',
          '--results-dir', '/tmp/somewhere',
          '--update-latest',
          '--dry-run',
          '--plain',
        ],
        {},
      ),
    );

    expect(args).toMatchObject({
      strategies: ['single', 'plan-execute'],
      tasks: ['airline', 'research'],
      models: ['claude-sonnet-5-5', 'claude-opus-5-5'],
      repeats: 5,
      effort: 'max',
      concurrency: 8,
      maxCostUsd: 2.5,
      maxSeconds: 900,
      totalBudgetUsd: 40,
      judgeModel: 'claude-haiku-4-5-20251001',
      judgeEffort: 'low',
      judgeSamples: 5,
      fixtureMode: 'record',
      runSetId: 'my-set',
      resultsDir: '/tmp/somewhere',
      persist: true,
      updateLatest: true,
      dryRun: true,
      plain: true,
    });
    expect([...args.explicit].sort()).toEqual(
      [
        'effort',
        'fixtureMode',
        'judgeEffort',
        'judgeModel',
        'judgeSamples',
        'maxCostUsd',
        'maxSeconds',
        'models',
        'repeats',
        'strategies',
        'tasks',
      ].sort(),
    );
  });

  it('accepts --flag=value as well as --flag value', () => {
    const args = expectRun(parseArgs(['run', '--repeats=7', '--effort=low', '--max-cost=$0.50'], {}));

    expect(args.repeats).toBe(7);
    expect(args.effort).toBe('low');
    expect(args.maxCostUsd).toBe(0.5);
  });

  it('refuses an empty selection instead of widening it to the whole matrix', () => {
    expect(expectError(parseArgs(['run', '--tasks', ','], {}))).toMatch(/--tasks was given but selects nothing/);
    expect(expectError(parseArgs(['run', '--tasks='], {}))).toMatch(/--tasks/);
    expect(expectError(parseArgs(['run', '--strategies', ''], {}))).toMatch(/--strategies/);
    expect(expectError(parseArgs(['run', '--models', ' , '], {}))).toMatch(/--models/);
    expect(expectError(parseArgs(['run', '--judge-model', ' '], {}))).toMatch(/--judge-model/);
  });

  it('accepts only plain decimal numbers', () => {
    for (const bad of ['1e3', '0x10', '2.5', '-1', 'lots', '0']) {
      expect(expectError(parseArgs(['run', '--repeats', bad], {})), bad).toMatch(/--repeats/);
    }
    for (const bad of ['1e3', '0x10', '-1', '0', 'free']) {
      expect(expectError(parseArgs(['run', '--max-cost', bad], {})), bad).toMatch(/--max-cost/);
    }
    expect(expectRun(parseArgs(['run', '--max-cost', '.5'], {})).maxCostUsd).toBe(0.5);
  });

  it('bounds concurrency', () => {
    expect(expectRun(parseArgs(['run', '--concurrency', '32'], {})).concurrency).toBe(32);
    expect(expectError(parseArgs(['run', '--concurrency', '33'], {}))).toMatch(/from 1 to 32/);
  });

  it('rejects a malformed budget variable instead of ignoring it', () => {
    expect(expectError(parseArgs(['run'], { ARENA_MAX_COST_USD: 'cheap' }))).toMatch(/ARENA_MAX_COST_USD/);
  });

  it('refuses a per-run cap above the total budget, since no run could start', () => {
    const error = expectError(parseArgs(['run', '--max-cost', '5', '--total-budget', '1'], {}));

    expect(error).toMatch(/\$5\.00/);
    expect(error).toMatch(/no run could start/);
  });

  it('leaves that check to the resume, which knows the run set\'s own cap', () => {
    expect(expectRun(parseArgs(['run', '--resume', 'set-1', '--total-budget', '0.25'], {})).totalBudgetUsd).toBe(0.25);
  });

  it('rejects an effort level outside the supported set', () => {
    const error = expectError(parseArgs(['run', '--effort', 'turbo'], {}));

    expect(error).toMatch(/turbo/);
    expect(error).toMatch(/low, medium, high, xhigh, max/);
  });

  it('rejects two fixture mode flags at once', () => {
    const error = expectError(parseArgs(['run', '--record', '--live'], {}));

    expect(error).toMatch(/--record/);
    expect(error).toMatch(/--live/);
  });

  it('validates run set ids before any path is built from them', () => {
    for (const bad of ['../../tmp/evil', '/abs', 'a/b', '.hidden', '']) {
      expect(expectError(parseArgs(['run', '--run-set', bad], {})), bad).toMatch(/run set id|--run-set/);
      expect(expectError(parseArgs(['run', '--resume', bad], {})), bad).toMatch(/run set id|--resume/);
    }
    expect(expectRun(parseArgs(['run', '--resume', '2026-10-02T09-14-03Z-k2p9'], {})).resume).toBe(
      '2026-10-02T09-14-03Z-k2p9',
    );
  });

  it('refuses combinations that cannot do what they say', () => {
    expect(expectError(parseArgs(['run', '--resume', 'a', '--no-persist'], {}))).toMatch(/record nothing/);
    expect(expectError(parseArgs(['run', '--update-latest', '--no-persist'], {}))).toMatch(/nothing to point at/);
    expect(expectError(parseArgs(['run', '--resume', 'a', '--run-set', 'b'], {}))).toMatch(/different run sets/);
  });

  it('suggests the flag that was probably meant', () => {
    expect(expectError(parseArgs(['run', '--strategy', 'single'], {}))).toMatch(/Did you mean --strategies\?/);
    expect(expectError(parseArgs(['run', '--repeat', '2'], {}))).toMatch(/--repeats/);
  });

  it('names the command a misplaced flag belongs to', () => {
    expect(expectError(parseArgs(['run', '--markdown'], {}))).toMatch(/belongs to "report"/);
  });

  it('explains that short flags are not a thing here', () => {
    expect(expectError(parseArgs(['run', '-n', '3'], {}))).toMatch(/spelled out in full/);
  });

  it('rejects a value flag with nothing after it', () => {
    expect(expectError(parseArgs(['run', '--models'], {}))).toMatch(/--models needs a value/);
    expect(expectError(parseArgs(['run', '--models', '--tasks', 'x'], {}))).toMatch(/--models needs a value/);
  });

  it('points a stray argument at --tasks', () => {
    expect(expectError(parseArgs(['run', 'airline-easy'], {}))).toMatch(/--tasks airline-easy/);
  });

  it('says which command an error belongs to, so the hint can name its help', () => {
    const parsed = parseArgs(['run', '--nope'], {});
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.topic).toBe('run');
  });

  it('honours $ARENA_RESULTS_DIR, and a flag over it', () => {
    expect(expectRun(parseArgs(['run'], { ARENA_RESULTS_DIR: '/tmp/r' })).resultsDir).toBe('/tmp/r');
    expect(expectRun(parseArgs(['run', '--results-dir', 'x'], { ARENA_RESULTS_DIR: '/tmp/r' })).resultsDir).toBe('x');
  });
});

describe('parseArgs: other commands', () => {
  it('parses report with a positional or flagged run set id', () => {
    expect(expectReport(parseArgs(['report', '2026-07-25T12-00-00Z-abcd', '--markdown'], {}))).toEqual({
      runSetId: '2026-07-25T12-00-00Z-abcd',
      markdown: true,
      strict: false,
    });
    expect(expectReport(parseArgs(['report', '--run-set', 'x', '--strict'], {}))).toEqual({
      runSetId: 'x',
      markdown: false,
      strict: true,
    });
  });

  it('defaults the report run set to the latest pointer', () => {
    expect(expectReport(parseArgs(['report'], {}))).toEqual({ markdown: false, strict: false });
  });

  it('refuses an unsafe report id and two different ids', () => {
    expect(expectError(parseArgs(['report', '../../etc'], {}))).toMatch(/Invalid run set id/);
    expect(expectError(parseArgs(['report', 'a', '--run-set', 'b'], {}))).toMatch(/Two different/);
  });

  it('parses doctor and its canary modes', () => {
    expect(parseArgs(['doctor'], {})).toEqual({ ok: true, command: 'doctor', args: { wiring: 'none' } });
    expect(parseArgs(['doctor', '--wiring'], {})).toEqual({ ok: true, command: 'doctor', args: { wiring: 'init' } });
    expect(parseArgs(['doctor', '--wiring-live'], {})).toEqual({
      ok: true,
      command: 'doctor',
      args: { wiring: 'live' },
    });
  });

  it('parses the discovery commands and refuses arguments to them', () => {
    expect(parseArgs(['tasks'], {})).toEqual({ ok: true, command: 'tasks' });
    expect(parseArgs(['strategies'], {})).toEqual({ ok: true, command: 'strategies' });
    expect(expectError(parseArgs(['tasks', 'airline'], {}))).toMatch(/takes no arguments/);
  });

  it('answers help in every spelling, per command', () => {
    expect(parseArgs([], {})).toEqual({ ok: true, command: 'help' });
    expect(parseArgs(['--help'], {})).toEqual({ ok: true, command: 'help' });
    expect(parseArgs(['-h'], {})).toEqual({ ok: true, command: 'help' });
    expect(parseArgs(['help'], {})).toEqual({ ok: true, command: 'help' });
    expect(parseArgs(['help', 'run'], {})).toEqual({ ok: true, command: 'help', topic: 'run' });
    expect(parseArgs(['run', '--help'], {})).toEqual({ ok: true, command: 'help', topic: 'run' });
    expect(parseArgs(['report', '-h'], {})).toEqual({ ok: true, command: 'help', topic: 'report' });
    expect(expectError(parseArgs(['help', 'rnu'], {}))).toMatch(/Did you mean run\?/);
  });

  it('answers --version in every spelling', () => {
    for (const argv of [['--version'], ['-v'], ['-V'], ['version']]) {
      expect(parseArgs(argv, {})).toEqual({ ok: true, command: 'version' });
    }
  });

  it('suggests a command for a typo', () => {
    expect(expectError(parseArgs(['reprot'], {}))).toMatch(/Did you mean report\?/);
    expect(expectError(parseArgs(['frobnicate'], {}))).toMatch(/frobnicate/);
  });
});

describe('help', () => {
  it('documents every flag of every command, with its default', () => {
    for (const command of COMMANDS) {
      const text = commandHelp(command.name);
      for (const flag of command.flags) {
        expect(text, `${command.name} --${flag.name}`).toContain(`--${flag.name}`);
        if (flag.fallback !== undefined) expect(text).toContain(`(default: ${flag.fallback})`);
      }
    }
  });

  it('never wraps past the width it was given', () => {
    for (const width of [60, 80, 100]) {
      for (const command of COMMANDS) {
        for (const line of commandHelp(command.name, undefined, width).split('\n')) {
          // Examples are commands to copy and are never broken.
          if (line.startsWith('  arena ')) continue;
          expect(line.length, `${command.name} @${width}: ${line}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it('keeps a default on one line', () => {
    expect(commandHelp('run', undefined, 70)).not.toMatch(/\(default:\s*\n/);
  });

  it('lists every command and says how to run it from a checkout', () => {
    const text = generalHelp();
    for (const name of ['run', 'report', 'doctor', 'tasks', 'strategies']) expect(text).toContain(`  ${name}`);
    expect(text).toContain('npm run arena --');
    expect(text).toContain('ARENA_RESULTS_DIR');
  });
});
