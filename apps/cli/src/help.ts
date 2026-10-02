/**
 * Help text, generated from the flag tables in `args.ts` and laid out for
 * the terminal it is printed on.
 */

import { COMMANDS, commandSpec } from './args';
import type { CommandName, FlagSpec } from './args';
import { PLAIN, wrap } from './style';
import type { Style } from './style';

const ENVIRONMENT: [string, string][] = [
  ['ANTHROPIC_API_KEY', 'Billed when set; otherwise the SDK uses this machine\'s Claude Code login'],
  ['ARENA_MODEL', 'Default for --models (comma-separated)'],
  ['ARENA_JUDGE_MODEL', 'Default for --judge-model'],
  ['ARENA_MAX_COST_USD', 'Default for --max-cost'],
  ['ARENA_RESULTS_DIR', 'Default for --results-dir; the site reads it too'],
  ['NO_COLOR, FORCE_COLOR', 'Turn colour off or on'],
];

export function generalHelp(style: Style = PLAIN, width = 100): string {
  const commands = COMMANDS.filter((command) => command.name !== 'help' && command.name !== 'version');
  return [
    `${style.bold('ScaffoldBench')} ${style.dim('— does your agent scaffold pay for itself?')}`,
    '',
    style.bold('USAGE'),
    '  arena <command> [flags]',
    `  npm run arena -- <command> [flags]  ${style.dim('from a checkout')}`,
    '',
    style.bold('COMMANDS'),
    ...wrapPairs(
      [
        ...commands.map((command): [string, string] => [command.name, command.summary]),
        ['help', "arena help <command> shows a command's flags"],
        ['--version', 'Version, commit and Agent SDK'],
      ],
      width,
      style,
      false,
    ),
    '',
    style.bold('ENVIRONMENT'),
    ...wrapPairs(
      [['.env', 'Loaded from the repository root first; variables already set win'], ...ENVIRONMENT],
      width,
      style,
    ),
  ].join('\n');
}

export function commandHelp(name: CommandName, style: Style = PLAIN, width = 100): string {
  const spec = commandSpec(name);
  if (name === 'help' || name === 'version') return generalHelp(style, width);

  const lines = [`${style.bold(spec.synopsis)}`, '', `  ${spec.summary}`];
  if (spec.flags.length > 0) {
    lines.push('', style.bold('FLAGS'));
    lines.push(...flagLines(spec.flags, width, style));
  }
  if (spec.examples.length > 0) {
    lines.push('', style.bold('EXAMPLES'), ...spec.examples.map((example) => `  ${example}`));
  }
  for (const note of spec.notes ?? []) {
    lines.push('', ...wrap(note, Math.max(40, width - 4)).map((line) => `  ${line}`));
  }
  return lines.join('\n');
}

/** U+2060 WORD JOINER: not whitespace, so `wrap` keeps what it joins together. */
const JOINER = '\u2060';

function flagLines(flags: readonly FlagSpec[], width: number, style: Style): string[] {
  const label = (flag: FlagSpec) => `--${flag.name}${flag.value ? ` ${flag.value}` : ''}`;
  const labelWidth = Math.max(...flags.map((flag) => label(flag).length)) + 2;
  const textWidth = Math.max(30, width - labelWidth - 2);
  const lines: string[] = [];
  for (const flag of flags) {
    // "(default: …)" never breaks across lines: its space is a word joiner until wrapped.
    const fallback = flag.fallback !== undefined ? ` (default:${JOINER}${flag.fallback})` : '';
    const wrapped = wrap(flag.help + fallback, textWidth);
    wrapped.forEach((line, index) => {
      const prefix = index === 0 ? label(flag).padEnd(labelWidth) : ' '.repeat(labelWidth);
      const shown = line.replace(new RegExp(`\\(default:${JOINER}([^)]*)\\)$`), (_, value: string) =>
        style.dim(`(default: ${value})`),
      );
      lines.push(`  ${prefix}${shown}`);
    });
  }
  return lines;
}

function wrapPairs(pairs: readonly [string, string][], width: number, style: Style, dimText = true): string[] {
  const keyWidth = Math.max(...pairs.map(([key]) => key.length)) + 2;
  const lines: string[] = [];
  for (const [key, text] of pairs) {
    wrap(text, Math.max(30, width - keyWidth - 2)).forEach((line, index) => {
      lines.push(`  ${index === 0 ? key.padEnd(keyWidth) : ' '.repeat(keyWidth)}${dimText ? style.dim(line) : line}`);
    });
  }
  return lines;
}
