import { ImageResponse } from 'next/og';

import { DARK } from '../../lib/palette';

/** The home-screen icon: app/icon.svg's mark on its dark tile, as a PNG. See og.png for why a route. */
export const dynamic = 'force-static';

export function GET() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', background: '#14130f' }}>
        <svg width={180} height={180} viewBox="0 0 64 64">
          <path
            d="M18.4 29.4 27 18.6M18.6 32h8.6M18.4 34.6 27 45.4M37 18.6l8.6 10.8M36.8 32h8.6M37 45.4l8.6-10.8"
            stroke={DARK.ink}
            strokeWidth={3}
            strokeLinecap="round"
            opacity={0.5}
          />
          <circle cx={13.5} cy={32} r={6} fill={DARK.ink} />
          <circle cx={50.5} cy={32} r={6} fill={DARK.ink} />
          <circle cx={32} cy={14.5} r={5} fill={DARK['arch-plan-execute']} />
          <circle cx={32} cy={32} r={5} fill={DARK['arch-orchestrator-workers']} />
          <circle cx={32} cy={49.5} r={5} fill={DARK['arch-plan-execute-verify']} />
        </svg>
      </div>
    ),
    { width: 180, height: 180 },
  );
}
