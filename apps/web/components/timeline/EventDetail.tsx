import type { ReactNode } from 'react';

import { formatDuration, formatUsd } from '../../lib/format';
import type { TimelineCall } from '../../lib/timeline';
import { describeSubtype } from '../../lib/timeline';
import type { ViewGroup, ViewItem } from '../../lib/traceView';
import { prettyJson } from '../../lib/traceView';
import { Markdown } from '../Markdown';
import { StatusDot } from './EventList';

/**
 * Everything recorded about one selected item, or about a call when the call
 * itself is selected. Pure; the explorer decides what is selected.
 */
export function EventDetail({
  call,
  group,
  item,
}: {
  call: TimelineCall;
  group: ViewGroup;
  item?: ViewItem;
}) {
  if (!item) return <CallDetail call={call} group={group} />;

  return (
    <div className="flex flex-col gap-4">
      <p className="eyebrow flex flex-wrap items-center gap-x-2">
        <span>{call.label}</span>
        <span aria-hidden>·</span>
        <span className="num normal-case tracking-normal">{formatDuration(item.tMs)}</span>
      </p>
      <ItemBody item={item} />
    </div>
  );
}

function ItemBody({ item }: { item: ViewItem }) {
  switch (item.kind) {
    case 'prompt':
      return (
        <Section title="Prompt sent to the model">
          <pre className="detail-pre">{item.text}</pre>
        </Section>
      );
    case 'say':
      return (
        <Section title="Model">
          <Markdown source={item.text} />
        </Section>
      );
    case 'reply':
      return (
        <Section title="Closing reply">
          <Markdown source={item.text} />
        </Section>
      );
    case 'think':
      return (
        <Section title="Thinking">
          <p className="whitespace-pre-wrap text-[0.875rem] italic leading-relaxed text-ink-2">{item.text}</p>
        </Section>
      );
    case 'tool':
      return (
        <>
          <p className="font-mono text-[1rem] text-ink [overflow-wrap:anywhere]">
            {item.name}
            {item.server ? <span className="ml-2 text-[0.75rem] text-muted">on {item.server}</span> : null}
          </p>
          {item.denied ? (
            <div className="banner banner-bad">
              <p className="banner-title">Denied by the sandbox guard</p>
              <p className="banner-body">{item.denied.reason}</p>
            </div>
          ) : null}
          <Section title="Arguments">
            <pre className="detail-pre">{item.input === undefined ? '(none)' : prettyJson(item.input)}</pre>
          </Section>
          {item.result ? (
            <Section
              title={item.result.isError ? 'Answer (an error)' : 'Answer'}
              note={`${formatDuration(item.result.tMs - item.tMs)} later`}
            >
              <pre className={`detail-pre ${item.result.isError ? '!text-bad' : ''}`}>
                {item.result.text || '(empty)'}
              </pre>
            </Section>
          ) : (
            <p className="text-[0.8125rem] text-muted">No answer was recorded for this call.</p>
          )}
        </>
      );
    case 'error':
      return (
        <>
          <p className="text-[1rem] text-bad">{item.message}</p>
          <Section title="As the SDK reported it">
            <pre className="detail-pre">{item.raw}</pre>
          </Section>
        </>
      );
    case 'note':
      return <p className="whitespace-pre-wrap text-[0.875rem] text-ink-2">{item.text}</p>;
  }
}

function CallDetail({ call, group }: { call: TimelineCall; group: ViewGroup }) {
  const session = group.session;
  const denied = call.ticks.filter((tick) => tick.kind === 'denied');
  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-center gap-2 text-[1rem] font-medium text-ink">
        <StatusDot call={call} />
        {call.label}
        {call.depth > 0 ? <span className="chip-quiet">subagent</span> : null}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[0.875rem]">
        <Fact label="Ran">
          {formatDuration(call.startMs)} → {formatDuration(call.endMs)}
        </Fact>
        <Fact label="Ended">{describeSubtype(call.subtype)}</Fact>
        <Fact label="Cost">{formatUsd(call.costUsd)}</Fact>
        <Fact label="Turns">{call.turns ?? '—'}</Fact>
        <Fact label="Tool calls">{call.toolCalls}</Fact>
        <Fact label="Denied">{denied.length}</Fact>
      </dl>
      {call.serversDown.length > 0 ? (
        <div className="banner banner-bad">
          <p className="banner-title">Ran without its tools</p>
          <p className="banner-body">
            {call.serversDown.join(', ')} did not connect when the session started, so this call was shown no task
            tools and could only answer from the prompt.
          </p>
        </div>
      ) : null}
      {call.degraded ? (
        <div className="banner banner-warn">
          <p className="banner-title">The strategy fell back</p>
          <p className="banner-body">
            Instead of this call&apos;s output the architecture used a default: <code className="code-inline">{call.degraded}</code>.
          </p>
        </div>
      ) : null}
      {session ? (
        <Section title="Session at start-up">
          <ul className="flex flex-col gap-1 text-[0.8125rem]">
            {session.servers.length === 0 ? <li className="text-muted">No tool servers.</li> : null}
            {session.servers.map((server) => (
              <li key={server.name} className="flex items-center justify-between gap-3">
                <span className="font-mono text-ink-2">{server.name}</span>
                <span
                  className={
                    server.status === 'connected'
                      ? 'chip-good'
                      : call.foreignServers.includes(server.name)
                        ? 'chip-warn'
                        : 'chip-bad'
                  }
                >
                  {call.foreignServers.includes(server.name) ? `foreign · ${server.status}` : server.status}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[0.8125rem] text-ink-2">
            {session.tools.length === 0
              ? 'No task tools.'
              : `${session.tools.length} task tool${session.tools.length === 1 ? '' : 's'}: `}
            {session.tools.length > 0 ? <span className="font-mono text-[0.75rem]">{session.tools.join(', ')}</span> : null}
          </p>
          {session.harnessTools.length > 0 ? (
            <p className="mt-1 text-[0.8125rem] text-ink-2">
              Harness tools: <span className="font-mono text-[0.75rem]">{session.harnessTools.join(', ')}</span>
            </p>
          ) : null}
        </Section>
      ) : (
        <p className="text-[0.8125rem] text-muted">The session&apos;s start-up message was not recorded.</p>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow !text-[0.6875rem]">{label}</dt>
      <dd className="num mt-0.5 text-ink">{children}</dd>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h3 className="eyebrow mb-2 flex items-baseline justify-between gap-3 !text-[0.6875rem]">
        {title}
        {note ? <span className="num normal-case tracking-normal">{note}</span> : null}
      </h3>
      {children}
    </section>
  );
}
