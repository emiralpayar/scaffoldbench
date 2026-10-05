/** `scaffoldbench tasks` and `scaffoldbench strategies`: what can be selected, for free. */

import { STRATEGIES } from '@scaffoldbench/strategies';
import { ALL_TASKS } from '@scaffoldbench/tasks';

import { renderTable, wrap } from '../style';
import type { CliContext } from './context';

export function listTasks(ctx: CliContext): number {
  const style = ctx.outStyle;
  const difficulty = (level: string) =>
    level === 'easy' ? style.ok(level) : level === 'medium' ? style.warn(level) : style.bad(level);
  ctx.out(`${style.bold('TASKS')} ${style.dim(`(${ALL_TASKS.length})`)}`);
  ctx.out('');
  ctx.out(
    renderTable(
      [
        { header: 'ID' },
        { header: 'CATEGORY' },
        { header: 'WORLD' },
        { header: 'DIFFICULTY' },
        { header: 'TURNS', align: 'right' },
        { header: 'TITLE' },
      ],
      ALL_TASKS.map((task) => [
        style.bold(task.id),
        task.category,
        task.world,
        difficulty(task.difficulty),
        String(task.maxTurns),
        task.title,
      ]),
      style,
      '  ',
    ),
  );
  ctx.out('');
  ctx.out(style.dim('Select with --tasks: an id, a world, a category, a glob such as airline-*, or all.'));
  return 0;
}

export function listStrategies(ctx: CliContext): number {
  const style = ctx.outStyle;
  ctx.out(`${style.bold('STRATEGIES')} ${style.dim(`(${STRATEGIES.length})`)}`);
  ctx.out('');
  for (const strategy of STRATEGIES) {
    ctx.out(`  ${style.bold(strategy.id)}  ${style.dim('—')}  ${strategy.label}`);
    for (const line of wrap(strategy.description, Math.min(96, ctx.width) - 6)) ctx.out(`      ${line}`);
    ctx.out('');
  }
  ctx.out(style.dim('Select with --strategies: a comma-separated list of ids, or all.'));
  return 0;
}
