/**
 * The landing page's social card once a verified run set is published: the
 * headline result, its three numbers and a miniature of the result chart.
 * Satori draws it, so flexbox only and literal colours.
 */

import type { ResultCardData } from '../../lib/socialCard';
import { CardFrame, CardHeader, INK, INK_2, MUTED, PLANE, RULE, arch } from './SocialCard';

const CHART = { width: 480, height: 330 };

export function ResultCard(data: ResultCardData) {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
  const stats = [
    { value: `${data.scaffoldsBetter} / ${data.scaffoldContrasts}`, label: 'scaffolds beat a single agent' },
    { value: `×${data.costMin.toFixed(1)}–${data.costMax.toFixed(1)}`, label: 'the cost per task' },
    ...(data.stepGain !== null ? [{ value: `+${data.stepGain.toFixed(2)}`, label: 'score, one model up' }] : []),
  ];
  return (
    <CardFrame>
      <CardHeader host={data.host} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexDirection: 'column', width: 560 }}>
          <div style={{ display: 'flex', flexDirection: 'column', fontFamily: 'Newsreader', fontSize: 124, lineHeight: 0.98, letterSpacing: -3.5 }}>
            <span>Scale beat</span>
            <span style={{ fontStyle: 'italic' }}>scaffold.</span>
          </div>
          <div style={{ display: 'flex', marginTop: 26, fontFamily: 'Newsreader', fontSize: 26, lineHeight: 1.35, color: INK_2 }}>
            {`${data.runs} pre-registered runs of ${words[data.architectures] ?? data.architectures} agent architectures on ${data.models
              .map((m) => m.short)
              .join(', ')
              .replace(/, ([^,]*)$/, ' and $1')}.`}
          </div>
        </div>
        <MiniChart models={data.models} />
      </div>

      <div style={{ display: 'flex', borderTop: `1px solid ${RULE}`, paddingTop: 22, gap: 34 }}>
        {stats.map((stat) => (
          <div key={stat.label} style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
            <span style={{ fontFamily: 'Geist Mono', fontSize: 30, color: INK, letterSpacing: -1 }}>{stat.value}</span>
            <span style={{ fontSize: 18, color: MUTED }}>{stat.label}</span>
          </div>
        ))}
      </div>
    </CardFrame>
  );
}

function MiniChart({ models }: { models: ResultCardData['models'] }) {
  const { width, height } = CHART;
  const pad = { l: 12, r: 12, t: 16, b: 44 };
  const all = models.flatMap((m) => [m.single, ...m.scaffolds.map((s) => s.score)]);
  const lo = Math.floor((Math.min(...all) - 0.03) * 20) / 20;
  const hi = 1;
  const y = (v: number) => pad.t + ((hi - v) / (hi - lo)) * (height - pad.t - pad.b);
  const colW = (width - pad.l - pad.r) / models.length;
  const cx = (i: number) => pad.l + colW * i + colW / 2;
  const singles = models.map((m, i) => ({ x: cx(i), y: y(m.single) }));

  return (
    <div style={{ display: 'flex', position: 'relative', width, height }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {[0.6, 0.7, 0.8, 0.9, 1].filter((t) => t >= lo + 0.001).map((t) => (
          <line key={t} x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke={RULE} strokeWidth={1} />
        ))}
        {models.map((m, i) => (
          <line
            key={`ref-${m.short}`}
            x1={cx(i) - colW / 2 + 14}
            x2={cx(i) + colW / 2 - 14}
            y1={y(m.single)}
            y2={y(m.single)}
            stroke={MUTED}
            strokeWidth={1.5}
            strokeDasharray="4 4"
          />
        ))}
        <polyline
          points={singles.map((s) => `${s.x},${s.y}`).join(' ')}
          fill="none"
          stroke={INK}
          strokeWidth={3}
          strokeLinejoin="round"
        />
        {models.map((m, i) =>
          m.scaffolds.map((s, j) => {
            const x = cx(i) - colW / 2 + 24 + (j * (colW - 48)) / Math.max(1, m.scaffolds.length - 1);
            return <circle key={`${m.short}-${s.strategyId}`} cx={x} cy={y(s.score)} r={7} fill={arch(s.strategyId)} stroke={PLANE} strokeWidth={2.5} />;
          }),
        )}
        {singles.map((s, i) => (
          <circle key={`s-${i}`} cx={s.x} cy={s.y} r={9} fill={PLANE} stroke={INK} strokeWidth={3} />
        ))}
      </svg>
      {models.map((m, i) => (
        <span
          key={m.short}
          style={{
            position: 'absolute',
            top: height - 30,
            left: cx(i) - colW / 2,
            width: colW,
            display: 'flex',
            justifyContent: 'center',
            fontSize: 19,
            color: INK_2,
          }}
        >
          {m.short}
        </span>
      ))}
    </div>
  );
}
