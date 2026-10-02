import type { ReactNode } from 'react';

import { formatDuration, formatUsd } from '../../lib/format';
import type { TimelineCall } from '../../lib/timeline';
import { describeSubtype } from '../../lib/timeline';
import type { SessionInfo, ViewGroup, ViewItem } from '../../lib/traceView';
import { summarizeInput } from '../../lib/traceView';
import { ClampedMarkdown } from './ClampedMarkdown';

/**
 * The deduplicated trace, one section per model call in the order the calls
 * started. Pure: the explorer owns selection and which calls are open.
 */
export interface Selection {
  key: string;
  seq?: number;
}

export function EventList({
  pairs,
  selection,
  onSelect,
  open,
  onToggle,
  renderDetail,
}: {
  pairs: { call: TimelineCall; group: ViewGroup }[];
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  open: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** The selected item's detail, shown inline below it on narrow screens. */
  renderDetail: (selection: Selection) => ReactNode;
}) {
  return (
    <ol className="flex flex-col gap-3">
      {pairs.map(({ call, group }) => {
        const expanded = open.has(call.key);
        const headSelected = selection?.key === call.key && selection.seq === undefined;
        return (
          <li
            key={call.key}
            id={`call-${call.key}`}
            className={`rounded-[12px] border bg-surface ${call.depth > 0 ? 'ml-3 sm:ml-6' : ''} ${
              call.status === 'failed' || call.serversDown.length > 0 ? 'border-bad/40' : 'border-rule'
            }`}
          >
            <div className="flex items-stretch">
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={`items-${call.key}`}
                onClick={() => onToggle(call.key)}
                className="flex w-9 shrink-0 cursor-pointer items-center justify-center rounded-l-[12px] text-muted hover:bg-sunken hover:text-ink"
                title={expanded ? 'Collapse' : 'Expand'}
              >
                <span aria-hidden className={`inline-block transition-transform ${expanded ? 'rotate-90' : ''}`}>
                  ▸
                </span>
                <span className="sr-only">{expanded ? `Collapse ${call.label}` : `Expand ${call.label}`}</span>
              </button>
              <button
                type="button"
                onClick={() => onSelect({ key: call.key })}
                aria-pressed={headSelected}
                className={`flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 pr-3 text-left ${
                  headSelected ? 'bg-sunken' : 'hover:bg-sunken/60'
                } rounded-r-[12px]`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <StatusDot call={call} />
                  <span className="text-[0.9375rem] font-medium text-ink">{call.label}</span>
                  {call.depth > 0 ? <span className="chip-quiet">subagent</span> : null}
                </span>
                <SessionChips session={group.session} call={call} />
                <span className="num ml-auto whitespace-nowrap text-[0.75rem] text-muted">
                  {formatDuration(call.startMs)} → {formatDuration(call.endMs)} · {describeSubtype(call.subtype)} ·{' '}
                  {formatUsd(call.costUsd)}
                </span>
              </button>
            </div>
            {headSelected ? <div className="border-t border-rule px-4 py-3 lg:hidden">{renderDetail({ key: call.key })}</div> : null}
            {expanded ? (
              <ol id={`items-${call.key}`} className="border-t border-rule">
                {group.items.length === 0 ? (
                  <li className="px-4 py-3 text-[0.8125rem] text-muted">This call recorded no messages.</li>
                ) : null}
                {group.items.map((item) => {
                  const selected = selection?.key === call.key && selection.seq === item.seq;
                  return (
                    <li key={item.seq} id={`event-${item.seq}`} className="border-b border-rule/70 last:border-0">
                      <button
                        type="button"
                        onClick={() => onSelect({ key: call.key, seq: item.seq })}
                        aria-pressed={selected}
                        className={`grid w-full cursor-pointer grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 px-4 py-2 text-left ${
                          selected ? 'bg-sunken [--row-bg:var(--sunken)]' : 'hover:bg-sunken/60'
                        }`}
                      >
                        <span className="num pt-0.5 text-[0.6875rem] text-muted">{formatDuration(item.tMs)}</span>
                        <ItemSummary item={item} />
                      </button>
                      {selected ? (
                        <div className="border-t border-rule bg-sunken/40 px-4 py-3 lg:hidden">
                          {renderDetail({ key: call.key, seq: item.seq })}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function StatusDot({ call }: { call: Pick<TimelineCall, 'status' | 'serversDown'> }) {
  const tone =
    call.status === 'failed' || call.serversDown.length > 0
      ? 'bg-bad'
      : call.status === 'limit'
        ? 'bg-warn'
        : call.status === 'skipped'
          ? 'bg-muted'
          : 'bg-good';
  return <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${tone}`} />;
}

export function SessionChips({ session, call }: { session: SessionInfo | undefined; call: TimelineCall }) {
  const chips: ReactNode[] = [];
  if (call.serversDown.length > 0) {
    chips.push(
      <span key="down" className="chip-bad" title={`${call.serversDown.join(', ')} did not connect`}>
        no tools · {call.serversDown.join(', ')} failed
      </span>,
    );
  } else if (session && session.tools.length > 0) {
    chips.push(
      <span key="tools" className="chip-quiet">
        {session.tools.length} tools
      </span>,
    );
  }
  if (call.foreignServers.length > 0) {
    chips.push(
      <span key="foreign" className="chip-warn" title={call.foreignServers.join(', ')}>
        +{call.foreignServers.length} foreign server{call.foreignServers.length === 1 ? '' : 's'}
      </span>,
    );
  }
  const denied = call.ticks.filter((tick) => tick.kind === 'denied').length;
  if (denied > 0) {
    chips.push(
      <span key="denied" className="chip-bad">
        {denied} denied
      </span>,
    );
  }
  if (call.degraded) {
    chips.push(
      <span key="degraded" className="chip-warn" title="The strategy fell back on a default instead of this call's output">
        fell back · {call.degraded}
      </span>,
    );
  }
  if (chips.length === 0) return null;
  return <span className="flex flex-wrap gap-1.5">{chips}</span>;
}

/** One line (or a short clamp) per item; the detail panel holds the rest. */
export function ItemSummary({ item }: { item: ViewItem }) {
  switch (item.kind) {
    case 'prompt':
      return (
        <span className="min-w-0">
          <span className="eyebrow mr-2 !text-[0.6875rem]">Prompt</span>
          <span className="line-clamp-2 text-[0.8125rem] text-muted [overflow-wrap:anywhere]">{item.text}</span>
        </span>
      );
    case 'say':
    case 'reply':
      return <ClampedMarkdown source={item.text} />;
    case 'think':
      return <span className="line-clamp-3 text-[0.8125rem] italic text-muted">{item.text}</span>;
    case 'tool': {
      const args = summarizeInput(item.input);
      return (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-mono text-[0.8125rem] text-ink [overflow-wrap:anywhere]">
            {item.name}
            <span className="text-muted">({args})</span>
          </span>
          {item.denied ? (
            <span className="chip-bad">denied by the guard</span>
          ) : item.result?.isError ? (
            <span className="chip-warn">error</span>
          ) : item.result ? (
            <span aria-label="answered" className="text-[0.75rem] text-good">
              ✓
            </span>
          ) : null}
        </span>
      );
    }
    case 'error':
      return (
        <span className="flex min-w-0 items-baseline gap-2 text-[0.8125rem] text-bad">
          <span aria-hidden>✗</span>
          {item.message}
        </span>
      );
    case 'note':
      return <span className="line-clamp-2 text-[0.8125rem] text-ink-2">{item.text}</span>;
  }
}
