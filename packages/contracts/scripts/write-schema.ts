import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { actionsJsonSchema } from "../src/actions";

/**
 * Writes `actions.schema.json`, every action's input and output as JSON Schema, for clients in
 * other languages (Swift, Kotlin) to generate their types from. `--check` fails if it's stale.
 */
const target = fileURLToPath(new URL("../actions.schema.json", import.meta.url));
const next = `${JSON.stringify(actionsJsonSchema(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    current = "";
  }
  if (current !== next) {
    console.error(
      "actions.schema.json is out of date. Run `pnpm --filter @template/contracts build`.",
    );
    process.exit(1);
  }
  console.log("actions.schema.json is up to date");
} else {
  writeFileSync(target, next);
  console.log(`wrote ${target}`);
}
