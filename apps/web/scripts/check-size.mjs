// The first-load budget (SPEC.md, "Request path and speed budget"): the JavaScript index.html
// loads, gzipped, at most 150 KB. Routes behind sign-in are lazy chunks and don't count.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const BUDGET_KB = 150;
const dist = new URL("../dist/", import.meta.url).pathname;
const html = readFileSync(join(dist, "index.html"), "utf8");
const scripts = [
  ...html.matchAll(/<script[^>]+src="\/([^"]+\.js)"/g),
  ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/([^"]+\.js)"/g),
].map((m) => m[1]);
let total = 0;
for (const file of new Set(scripts)) total += gzipSync(readFileSync(join(dist, file))).length;
const kb = total / 1024;
console.log(`first-load JS: ${kb.toFixed(1)} KB gzipped (budget ${BUDGET_KB} KB)`);
if (kb > BUDGET_KB) {
  console.error(`Over the first-load budget by ${(kb - BUDGET_KB).toFixed(1)} KB.`);
  process.exit(1);
}
