/**
 * Words that start tool titles ("List cards", "Draft an app change"). Only these become a
 * progressive cover, so a title that doesn't start with a verb ("Card details") stays as it is.
 */
const VERBS = new Set(
  (
    "add analyze approve archive ask assign book build calculate cancel change check close compare " +
    "complete compute connect copy count create delete draft edit email export fetch fill find " +
    "fix generate get import invite link list load look make mark merge move notify open plan " +
    "post prepare publish read record refresh reject remove rename reply request reschedule " +
    "restore review run save schedule search send set share show sort start stop submit " +
    "summarize sync tag test track transfer update upload verify write"
  ).split(" "),
);

/** Doubled final consonants and other spellings the simple rules get wrong. */
const IRREGULAR: Record<string, string> = {
  get: "getting",
  set: "setting",
  run: "running",
  stop: "stopping",
  plan: "planning",
  tag: "tagging",
  submit: "submitting",
  see: "seeing",
};

function gerund(verb: string): string {
  const lower = verb.toLowerCase();
  let result = IRREGULAR[lower];
  if (!result) {
    if (lower.endsWith("ie")) result = `${lower.slice(0, -2)}ying`;
    else if (lower.endsWith("e") && !lower.endsWith("ee")) result = `${lower.slice(0, -1)}ing`;
    else result = `${lower}ing`;
  }
  return verb[0] === verb[0]?.toUpperCase() ? result[0]!.toUpperCase() + result.slice(1) : result;
}

/**
 * The short line shown for a step. A running tool reads as progress ("Drafting an app change");
 * a finished one keeps its title.
 */
export function stepCover(title: string, state: "active" | "done" | "error"): string {
  const trimmed = title.trim();
  if (state !== "active") return trimmed;
  const [first = "", ...rest] = trimmed.split(/\s+/);
  if (!VERBS.has(first.toLowerCase())) return trimmed;
  return [gerund(first), ...rest].join(" ");
}

const BOLD_HEADING = /^\s*\*\*([^*\n]{2,80})\*\*\s*$/gm;
const MARKDOWN_HEADING = /^\s{0,3}#{1,4}\s+(.{2,80}?)\s*#*\s*$/gm;

/**
 * What a reasoning chunk is about. Reasoning models title each thought in bold
 * ("**Structuring a response**"); the latest title is what the model is doing now.
 */
export function reasoningCover(text: string, fallback = "Thinking"): string {
  const titles = [...text.matchAll(BOLD_HEADING)].map((m) => m[1]!.trim());
  if (!titles.length) titles.push(...[...text.matchAll(MARKDOWN_HEADING)].map((m) => m[1]!.trim()));
  const title = titles.at(-1)?.replace(/[.:]+$/, "");
  if (!title) return fallback;
  const words = title.split(/\s+/);
  return words.length > 6 ? `${words.slice(0, 6).join(" ")}…` : title;
}

/** "6s", "1m 42s", "2m". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export { shortUrl } from "./url";
