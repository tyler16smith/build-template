import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  createTestPostgres,
  judgeMigration,
  MIGRATIONS_DIR,
  tenantPolicyProblems,
} from "@template/db/node";
import { ROOT, run, step } from "./shared";

/**
 * `pnpm check:migrations`: every migration added since `base` passes the migration rule
 * (`packages/db/src/node/rules.ts`), none that already existed was edited or deleted
 * (append-only), and with every migration applied (on PGlite) each tenant table has forced
 * row-level security and its policy.
 */
export async function checkMigrations(options: { base: string | null }): Promise<void> {
  const dir = relative(ROOT, MIGRATIONS_DIR);
  const problems: string[] = [];
  const hasBase =
    options.base !== null &&
    run("git", ["rev-parse", "--verify", "--quiet", `${options.base}^{commit}`], {
      allowFailure: true,
      quiet: true,
    }).status === 0;
  let files: { status: string; path: string }[];
  if (hasBase) {
    step(`Migrations changed since ${options.base}`);
    files = run(
      "git",
      ["diff", "--name-status", "--no-renames", `${options.base}...HEAD`, "--", `${dir}/*.sql`],
      { quiet: true },
    )
      .stdout.split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status = "", path = ""] = line.split("\t");
        return { status, path };
      });
    // Uncommitted files count too, so the check works before a commit.
    const untracked = run("git", ["status", "--porcelain", "--", `${dir}/*.sql`], { quiet: true })
      .stdout.split("\n")
      .filter(Boolean)
      .map((line) => ({
        status: line.slice(0, 2).trim() === "??" ? "A" : line.slice(0, 2).trim(),
        path: line.slice(3),
      }));
    for (const file of untracked) if (!files.some((f) => f.path === file.path)) files.push(file);
  } else {
    step(`Every migration (no ${options.base ?? "base"} to compare with)`);
    files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => ({ status: "A", path: `${dir}/${f}` }));
  }
  for (const { status, path } of files) {
    if (status !== "A") {
      problems.push(
        `${path}: migrations are append-only (${status === "D" ? "deleted" : "edited"}); add a new one instead`,
      );
      continue;
    }
    const verdict = judgeMigration(readFileSync(join(ROOT, path), "utf8"));
    if (!verdict.ok) problems.push(`${path}: ${verdict.reason}`);
    else
      console.log(
        `  ${path}: ${verdict.contract ? `contract (${verdict.contract})` : "expand-only"}`,
      );
  }
  if (!files.length) console.log("  none");

  step("Every tenant table has forced row-level security (all migrations, PGlite)");
  const test = await createTestPostgres();
  try {
    const policy = await tenantPolicyProblems(test.owner);
    problems.push(...policy);
    if (!policy.length) console.log("  ok");
  } finally {
    await test.close();
  }
  if (problems.length) throw new Error(problems.join("\n"));
}

type Rule = {
  /** Files (relative to the root) the rule applies to. */
  files: RegExp;
  /** A file it doesn't apply to. */
  except?: RegExp;
  /** Import specifiers that are refused. */
  imports?: RegExp;
  /** Source text that is refused (after comments are removed). */
  code?: RegExp;
  why: string;
};

/**
 * The dependency direction and the rules that keep it (SPEC.md, "Repository layout"):
 * `apps/*` → `screens` → `ui`, `api-client` → `contracts`; `server` → `db`, `auth`,
 * `contracts`. Screens and ui never import apps, call `fetch` or read `window.location`.
 */
export const BOUNDARY_RULES: Rule[] = [
  {
    files: /^packages\/(screens|ui)\/src\//,
    imports: /^(@template\/(server|web|db|auth|tooling)|@tanstack\/|.*apps\/)/,
    why: "screens and ui get the API and navigation through context; they don't import apps, the router, or server packages",
  },
  {
    files: /^packages\/(screens|ui)\/src\//,
    code: /\bfetch\s*\(|window\.location|\bdocument\.location|\blocation\.(href|assign|replace)\b/,
    why: "screens and ui never call fetch or read window.location (use useApi and useNav)",
  },
  {
    files: /^packages\/ui\/src\//,
    imports: /^@template\//,
    why: "ui is the bottom of the UI stack: it imports no other workspace package",
  },
  {
    files: /^packages\/api-client\/src\//,
    imports: /^(?!@template\/contracts$)(@template\/|react|zod)/,
    why: "api-client depends only on contracts (and needs no React or zod at runtime)",
  },
  {
    files: /^packages\/contracts\/src\//,
    imports: /^@template\//,
    why: "contracts is the base: it imports no other workspace package",
  },
  {
    files: /^packages\/db\/src\//,
    imports: /^@template\/(?!contracts$)/,
    why: "db depends only on contracts",
  },
  {
    files: /^packages\/auth\/src\//,
    imports: /^(hono|@template\/(?!contracts$|db$))/,
    why: "auth depends on contracts and db, and has no HTTP framework",
  },
  {
    files: /^(apps|packages)\//,
    except: /^packages\/(db|tooling)\//,
    imports: /^(drizzle-orm|pg|@neondatabase\/serverless)(\/|$)/,
    why: "queries go through @template/db (no raw SQL or drivers outside it)",
  },
  {
    files: /^apps\/server\/src\//,
    except: /^apps\/server\/src\/lib\/log\.ts$/,
    code: /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/,
    why: "the server logs through ctx.log (redacted, structured); no other console calls",
  },
  {
    files: /^packages\//,
    imports: /^(@template\/(server|web)|.*\/apps\/)/,
    why: "packages never import from apps",
  },
  // A module's functional core (`apps/server/AGENTS.md`): plain data in, a decision out. The
  // handler around it (the shell) reads, calls it, then writes.
  {
    files: /^apps\/server\/src\/modules\/[^/]+\/core\.ts$/,
    imports: /^(?!@template\/contracts$|zod$|\.\/core\/)/,
    why: "a module's core is pure: it imports only @template/contracts, zod and its own core/ files (shared pure code goes in contracts)",
  },
  {
    files: /^apps\/server\/src\/modules\/[^/]+\/core\//,
    imports: /^(?!@template\/contracts$|zod$|\.\/[^/]+$)/,
    why: "a module's core is pure: it imports only @template/contracts, zod and its own core/ files (shared pure code goes in contracts)",
  },
  {
    files: /^apps\/server\/src\/modules\/[^/]+\/core(\.ts$|\/)/,
    code: /\b(async|await|ctx)\b|\bnew Date\(\s*\)|\bDate\.now\s*\(|\bperformance\.now\s*\(|\bMath\.random\s*\(|\bcrypto\.|\buuidv7\s*\(|\bfetch\s*\(/,
    why: "a module's core is pure and synchronous: no ctx, I/O, clock or randomness (the handler passes `now` and new ids in)",
  },
];

const SOURCE = /\.(ts|tsx|mts|mjs|js)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (SOURCE.test(entry)) out.push(path);
  }
  return out;
}

export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

export function importsOf(source: string): string[] {
  const found: string[] = [];
  const pattern =
    /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) found.push((match[1] ?? match[2] ?? match[3])!);
  return found;
}

/** Problems in one file under the rules, as sentences. */
export function boundaryProblems(path: string, source: string, rules = BOUNDARY_RULES): string[] {
  const problems: string[] = [];
  const code = withoutComments(source);
  const imports = importsOf(code);
  for (const rule of rules) {
    if (!rule.files.test(path) || rule.except?.test(path)) continue;
    if (rule.imports)
      for (const specifier of imports)
        if (rule.imports.test(specifier))
          problems.push(`${path}: imports ${specifier}: ${rule.why}`);
    if (rule.code) {
      const match = rule.code.exec(code);
      if (match) problems.push(`${path}: ${match[0].trim()}: ${rule.why}`);
    }
  }
  return problems;
}

/** Every source file in the apps and packages (their `src` folders). */
export function sourceFiles(): string[] {
  return [
    ...walk(join(ROOT, "apps/server/src")),
    ...walk(join(ROOT, "apps/web/src")),
    ...readdirSync(join(ROOT, "packages")).flatMap((pkg) => {
      try {
        return walk(join(ROOT, "packages", pkg, "src"));
      } catch {
        return [];
      }
    }),
  ];
}

export function checkBoundaries(): void {
  step("Package boundaries");
  const files = sourceFiles();
  const problems = files.flatMap((file) =>
    boundaryProblems(relative(ROOT, file), readFileSync(file, "utf8")),
  );
  if (problems.length) throw new Error(problems.join("\n"));
  console.log(`  ${files.length} files, no problems`);
}
