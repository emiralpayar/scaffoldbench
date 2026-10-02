/**
 * Colour science for the token tests: WCAG contrast, OKLab distance, and
 * colour-vision-deficiency simulation (Machado, Oliveira & Fernandes 2009,
 * severity 1.0) — the same model and thresholds the palette was chosen with.
 */

const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;

type Rgb = [number, number, number];

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function hexToLinear(hex: string): Rgb {
  const clean = hex.replace('#', '');
  return [0, 2, 4].map((i) => toLinear(parseInt(clean.slice(i, i + 2), 16) / 255)) as Rgb;
}

function luminance(hex: string): number {
  const [r, g, b] = hexToLinear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function oklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function simulate(rgb: Rgb, kind: keyof typeof MACHADO): Rgb {
  const m = MACHADO[kind];
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [0, 1, 2].map((i) =>
    clamp(m[i]![0]! * rgb[0] + m[i]![1]! * rgb[1] + m[i]![2]! * rgb[2]),
  ) as Rgb;
}

/** OKLab ΔE ×100; with `kind`, both colours are first seen through that deficiency. */
export function deltaE(a: string, b: string, kind?: keyof typeof MACHADO): number {
  const la = oklab(kind ? simulate(hexToLinear(a), kind) : hexToLinear(a));
  const lb = oklab(kind ? simulate(hexToLinear(b), kind) : hexToLinear(b));
  return 100 * Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}
