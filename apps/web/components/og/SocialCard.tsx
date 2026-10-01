/**
 * The social card, rendered to PNG at build time by `next/og` for the
 * Open Graph and Twitter images. Satori draws it, so it uses flexbox only,
 * literal colours (no CSS variables) and fonts passed in as files.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ARCHITECTURES } from '../../lib/architectures';
import type { GlyphGeometry, GlyphNode } from '../../lib/glyphs';
import { GLYPHS, GLYPH_HEIGHT, GLYPH_WIDTH } from '../../lib/glyphs';
import { DARK } from '../../lib/palette';

export const CARD_SIZE = { width: 1200, height: 630 };

const INK = DARK.ink;
const INK_2 = DARK['ink-2'];
const MUTED = DARK.muted;
const PLANE = DARK.plane;
const RULE = DARK.rule;
const arch = (id: string): string =>
  (DARK as Record<string, string>)[`arch-${id}`] ?? INK_2;

async function font(file: string): Promise<ArrayBuffer> {
  const candidates = [
    path.join(process.cwd(), 'assets', 'og-fonts', file),
    path.join(process.cwd(), 'apps', 'web', 'assets', 'og-fonts', file),
  ];
  for (const candidate of candidates) {
    try {
      const buffer = await readFile(candidate);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    } catch {
      // try the next location
    }
  }
  throw new Error(`Social card font not found: ${file}`);
}

export async function cardFonts() {
  return [
    { name: 'Newsreader', data: await font('Newsreader-Medium.woff'), weight: 500 as const, style: 'normal' as const },
    { name: 'Newsreader', data: await font('Newsreader-MediumItalic.woff'), weight: 500 as const, style: 'italic' as const },
    { name: 'Geist', data: await font('Geist-Medium.ttf'), weight: 500 as const, style: 'normal' as const },
    { name: 'Geist Mono', data: await font('GeistMono-Regular.ttf'), weight: 400 as const, style: 'normal' as const },
  ];
}

const RADIUS: Record<GlyphNode['kind'], number> = {
  agent: 3.6,
  worker: 2.6,
  plan: 3.2,
  decide: 3.9,
  gate: 5,
  reviewer: 2.3,
};

function Glyph({ geometry, color, width }: { geometry: GlyphGeometry; color: string; width: number }) {
  const byId = new Map(geometry.nodes.map((node) => [node.id, node]));
  return (
    <svg width={width} height={(width * GLYPH_HEIGHT) / GLYPH_WIDTH} viewBox={`0 0 ${GLYPH_WIDTH} ${GLYPH_HEIGHT}`}>
      {geometry.edges.map((edge) => {
        const a = byId.get(edge.from);
        const b = byId.get(edge.to);
        if (!a || !b) return null;
        if (edge.kind === 'loop') {
          return (
            <path
              key={`${edge.from}-${edge.to}`}
              d={`M ${a.x - 2.5} ${a.y - 2.5} Q ${(a.x + b.x) / 2} ${a.y - 11} ${b.x + 2.5} ${b.y - 2.5}`}
              stroke={color}
              strokeWidth={1.15}
              fill="none"
              opacity={0.6}
            />
          );
        }
        return (
          <line
            key={`${edge.from}-${edge.to}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={color}
            strokeWidth={1.15}
            opacity={0.6}
            strokeDasharray={edge.kind === 'review' ? '1.6 1.2' : undefined}
          />
        );
      })}
      {geometry.nodes.map((node) => {
        const r = RADIUS[node.kind];
        if (node.kind === 'plan' || node.kind === 'reviewer') {
          return <circle key={node.id} cx={node.x} cy={node.y} r={r} fill={PLANE} stroke={color} strokeWidth={1.4} />;
        }
        if (node.kind === 'decide') {
          const s = r * 1.05;
          return (
            <path
              key={node.id}
              d={`M ${node.x} ${node.y - s} L ${node.x + s} ${node.y} L ${node.x} ${node.y + s} L ${node.x - s} ${node.y} Z`}
              fill={color}
            />
          );
        }
        if (node.kind === 'gate') {
          return (
            <path
              key={node.id}
              d={`M ${node.x - 1.4} ${node.y - r} V ${node.y + r} M ${node.x + 1.4} ${node.y - r} V ${node.y + r}`}
              stroke={color}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          );
        }
        return <circle key={node.id} cx={node.x} cy={node.y} r={r} fill={color} />;
      })}
    </svg>
  );
}

export function SocialCard({ footnote, host }: { footnote: string; host: string }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: PLANE,
        backgroundImage: `linear-gradient(${RULE} 1px, transparent 1px), linear-gradient(90deg, ${RULE} 1px, transparent 1px)`,
        backgroundSize: '40px 40px',
        padding: '64px 72px',
        fontFamily: 'Geist',
        color: INK,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <svg width={44} height={44} viewBox="0 0 64 64">
            <path
              d="M18.4 29.4 27 18.6M18.6 32h8.6M18.4 34.6 27 45.4M37 18.6l8.6 10.8M36.8 32h8.6M37 45.4l8.6-10.8"
              stroke={INK}
              strokeWidth={3}
              strokeLinecap="round"
              opacity={0.5}
            />
            <circle cx={13.5} cy={32} r={6} fill={INK} />
            <circle cx={50.5} cy={32} r={6} fill={INK} />
            <circle cx={32} cy={14.5} r={5} fill={arch('plan-execute')} />
            <circle cx={32} cy={32} r={5} fill={arch('orchestrator-workers')} />
            <circle cx={32} cy={49.5} r={5} fill={arch('plan-execute-verify')} />
          </svg>
          <span style={{ fontFamily: 'Newsreader', fontSize: 36, letterSpacing: -0.4 }}>ScaffoldBench</span>
        </div>
        <span style={{ fontFamily: 'Geist Mono', fontSize: 18, color: MUTED }}>{host}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', fontFamily: 'Newsreader', fontSize: 88, lineHeight: 1.02, letterSpacing: -2 }}>
          <span>Does your agent scaffold&nbsp;</span>
          <span style={{ fontStyle: 'italic' }}>pay for itself?</span>
        </div>
        <div style={{ display: 'flex', marginTop: 40, alignItems: 'flex-start' }}>
          {ARCHITECTURES.map((info) => (
            <div key={info.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: 176 }}>
              <Glyph geometry={GLYPHS[info.id]} color={arch(info.id)} width={108} />
              <span style={{ fontSize: 16, color: INK_2, whiteSpace: 'nowrap' }}>{info.name}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', borderTop: `1px solid ${RULE}`, paddingTop: 22 }}>
        <span style={{ fontFamily: 'Newsreader', fontSize: 26, lineHeight: 1.3, color: INK_2 }}>{footnote}</span>
      </div>
    </div>
  );
}
