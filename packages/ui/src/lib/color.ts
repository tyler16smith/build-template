function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function parseHex(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map(channel) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function mixHex(from: string, to: string, amount: number): string {
  const a = parseHex(from)!;
  const b = parseHex(to)!;
  return `#${a
    .map((value, i) =>
      Math.round(value + (b[i]! - value) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * A near-black accent in dark mode (or a pale one in
 * light mode) would make primary buttons vanish. Moves the accent toward white or black until it
 * reaches the 3:1 non-text contrast WCAG asks of controls against the surface.
 */
export function legibleAccent(accent: string, surface: string, minimumContrast = 3): string {
  if (!parseHex(accent) || !parseHex(surface)) return accent;
  const toward = relativeLuminance(surface) < 0.5 ? "#ffffff" : "#000000";
  for (let step = 0; step <= 10; step++) {
    const candidate = mixHex(accent, toward, step / 10);
    if (contrastRatio(candidate, surface) >= minimumContrast) return candidate;
  }
  return toward;
}

/** Picks black or white text for an accent background, whichever has higher contrast. */
export function readableForeground(background: string): "#ffffff" | "#09090b" {
  return contrastRatio(background, "#ffffff") >= contrastRatio(background, "#09090b")
    ? "#ffffff"
    : "#09090b";
}
