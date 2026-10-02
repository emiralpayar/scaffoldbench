/**
 * The ScaffoldBench mark: one agent fanning out through a scaffold of three
 * parallel steps and back. It is the orchestrator glyph, drawn as a logo, so
 * the identity and the data share one visual language. `app/icon.svg` is the
 * same drawing on a dark tile.
 */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden
      className={className}
      fill="none"
    >
      <g stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" opacity={0.55}>
        <path d="M8.6 14.6 13.4 8.6M8.9 16h4.4M8.6 17.4l4.8 6M18.6 8.6l4.8 6M18.7 16h4.4M18.6 23.4l4.8-6" />
      </g>
      <circle cx={6} cy={16} r={3.4} fill="currentColor" />
      <circle cx={26} cy={16} r={3.4} fill="currentColor" />
      <circle cx={16} cy={6.6} r={2.7} fill="var(--arch-plan-execute)" />
      <circle cx={16} cy={16} r={2.7} fill="var(--arch-orchestrator-workers)" />
      <circle cx={16} cy={25.4} r={2.7} fill="var(--arch-plan-execute-verify)" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`font-serif text-[1.1875rem] font-[560] tracking-[-0.012em] ${className ?? ''}`}>
      ScaffoldBench
    </span>
  );
}
