import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, legibleAccent, readableForeground } from "../src/lib/color";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function tokens(selector: string): Record<string, string> {
  const block = css.split(`${selector} {`)[1]?.split("}")[0] ?? "";
  return Object.fromEntries(
    [...block.matchAll(/--ui-([a-z-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1]!, m[2]!]),
  );
}

const PAIRS: [string, string, number][] = [
  ["foreground", "background", 4.5],
  ["foreground", "surface", 4.5],
  ["muted-foreground", "surface", 4.5],
  ["muted-foreground", "background", 4.5],
  ["secondary-foreground", "secondary", 4.5],
  ["success", "surface", 4.5],
  ["danger", "surface", 4.5],
  ["warning", "surface", 4.5],
  ["info", "surface", 4.5],
  ["border-strong", "surface", 2.2],
];

describe("design tokens meet WCAG AA contrast", () => {
  for (const [mode, selector] of [
    ["light", ":root"],
    ["dark", ".dark"],
  ] as const) {
    const values = { ...tokens(":root"), ...tokens(selector) };
    for (const [fg, bg, min] of PAIRS) {
      it(`${mode}: ${fg} on ${bg} >= ${min}`, () => {
        expect(values[fg], fg).toBeDefined();
        expect(values[bg], bg).toBeDefined();
        expect(contrastRatio(values[fg]!, values[bg]!)).toBeGreaterThanOrEqual(min);
      });
    }
  }

  it("chooses a readable foreground for any accent color", () => {
    for (const accent of [
      "#4f46e5",
      "#facc15",
      "#0f766e",
      "#e11d48",
      "#ffffff",
      "#000000",
      "#22c55e",
    ]) {
      expect(contrastRatio(accent, readableForeground(accent))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps any brand accent visible against light and dark surfaces", () => {
    const surfaces = { light: tokens(":root").surface!, dark: tokens(".dark").surface! };
    for (const accent of [
      "#111827",
      "#4f46e5",
      "#0e7490",
      "#facc15",
      "#ffffff",
      "#000000",
      "#fef3c7",
    ]) {
      for (const surface of Object.values(surfaces)) {
        const shown = legibleAccent(accent, surface);
        expect(contrastRatio(shown, surface), `${accent} on ${surface}`).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(shown, readableForeground(shown))).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(legibleAccent("#4f46e5", surfaces.light)).toBe("#4f46e5");
  });
});
