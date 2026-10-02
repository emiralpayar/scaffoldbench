/**
 * The post-mortem's social card: the page's own claim, drawn. Five
 * architectures with their scores, and the steps that never did their job
 * struck through, as on the page. Satori renders it, so flexbox and literal
 * colours only (see `SocialCard`).
 */

import { DARK } from '../../lib/palette';
import { GLYPHS } from '../../lib/glyphs';
import { CardFrame, CardHeader, Glyph, INK, INK_2, MUTED, RULE, arch } from './SocialCard';

export interface PostmortemCardRow {
  strategyId: string;
  name: string;
  /** The score the first leaderboard gave it. */
  score: string;
  /** Glyph node ids that never did their job. */
  deadNodes: readonly string[];
  ranAsDesigned: boolean;
}

export function PostmortemCard({
  host,
  tied,
  degraded,
  rows,
}: {
  host: string;
  /** "five": how many architectures the first leaderboard called a tie. */
  tied: string;
  /** "four": how many of them did not run as designed. */
  degraded: string;
  rows: readonly PostmortemCardRow[];
}) {
  return (
    <CardFrame>
      <CardHeader host={host} />

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', fontFamily: 'Newsreader', fontSize: 56, lineHeight: 1.06, letterSpacing: -1.2 }}>
          The leaderboard said {tied} architectures tied.
        </div>
        <div style={{ display: 'flex', fontFamily: 'Newsreader', fontStyle: 'italic', fontSize: 56, lineHeight: 1.06, letterSpacing: -1.2 }}>
          The traces said {degraded} never ran as designed.
        </div>

        <div style={{ display: 'flex', marginTop: 38 }}>
          {rows.map((row) => (
            <div key={row.strategyId} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 1056 / rows.length }}>
              <Glyph geometry={GLYPHS[row.strategyId as keyof typeof GLYPHS]} color={arch(row.strategyId)} width={126} dead={row.deadNodes} />
              <span style={{ marginTop: 10, fontSize: 17, color: INK_2, whiteSpace: 'nowrap' }}>{row.name}</span>
              <span style={{ marginTop: 6, fontFamily: 'Geist Mono', fontSize: 26, color: INK }}>{row.score}</span>
              <span
                style={{
                  marginTop: 4,
                  fontFamily: 'Geist Mono',
                  fontSize: 12.5,
                  letterSpacing: 0.4,
                  textTransform: 'uppercase',
                  color: row.ranAsDesigned ? DARK.good : DARK.bad,
                }}
              >
                {row.ranAsDesigned ? 'ran as designed' : 'did not run as designed'}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', borderTop: `1px solid ${RULE}`, paddingTop: 20 }}>
        <span style={{ fontFamily: 'Newsreader', fontSize: 25, lineHeight: 1.3, color: INK_2 }}>
          Our first run set, retracted.&nbsp;
        </span>
        <span style={{ fontFamily: 'Newsreader', fontSize: 25, lineHeight: 1.3, color: MUTED }}>
          Every count is read from files in the repository.
        </span>
      </div>
    </CardFrame>
  );
}
