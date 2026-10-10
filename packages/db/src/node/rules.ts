import { isNoTransaction, splitStatements } from "./migrations";

/**
 * The migration rule `pnpm check:migrations` applies to every new file (ported from Custombase's
 * `judgePostgresMigration`, with `organization_id` as the tenant column):
 *
 * - **Expand only.** Migrations run before the new Worker and are never rolled back, so the code
 *   that's live must keep working: no `DROP`, `RENAME` or column type change, and no `NOT NULL`
 *   column without a default, unless the file has a `-- contract: <why nothing uses it>` header
 *   (and ships after the code that stopped using it).
 * - **Tenant tables.** Every new table other than the identity tables has `organization_id`,
 *   first in its primary key, unique constraints, foreign keys (both sides) and indexes, and runs
 *   `SELECT enable_tenant_rls('<table>')`.
 * - **No long locks.** An index on an existing table is `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
 *   in a file whose first line is `-- no-transaction`. New constraints on existing tables are
 *   `NOT VALID`; `SET NOT NULL` and `ADD PRIMARY KEY` on them aren't allowed.
 *
 * An index that must not start with `organization_id` (a person's own memberships, say) is
 * allowed when the file says why: `-- cross-tenant index: <index name>: <reason>`.
 *
 * - **No other way around row-level security.** A `SECURITY DEFINER` function reads across
 *   organizations, so only the ones `DEFINER_FUNCTIONS` names may exist, each with a pinned
 *   `search_path` (`specs/organizations.md`, "Reads that cross organizations").
 */
export type MigrationVerdict =
  { ok: true; contract: string | null } | { ok: false; reason: string };

/** Belong to a person, not an organization (`packages/db/src/schema.ts`). */
export const IDENTITY_TABLES = [
  "users",
  "auth_identities",
  "sessions",
  "email_tokens",
  "environment_markers",
] as const;
/** The tenant itself: its `id` is the organization id, and it gets its own policy. */
export const TENANT_ROOT = "organizations";

const TENANT = "organization_id";

/**
 * The only `SECURITY DEFINER` functions: the reads that happen before an organization is chosen.
 * `@template/auth` is their only caller. Adding one is a security decision, made here.
 */
export const DEFINER_FUNCTIONS = [
  "member_organizations",
  "invite_by_token",
  "invites_for_email",
] as const;

const DESTRUCTIVE = [
  { pattern: /\bdrop\s+(table|column|index|view|trigger|policy|function)\b/i, what: "drops" },
  { pattern: /\brename\s+(to|column)\b/i, what: "renames" },
  { pattern: /\balter\s+(column\s+)?\S+\s+(set\s+data\s+)?type\b/i, what: "changes a column type" },
];

function withoutComments(sql: string): string {
  return splitStatements(sql).join(";\n");
}

function addsNotNullWithoutDefault(statements: string[]): boolean {
  return statements.some(
    (statement) =>
      /^alter\s+table\s+\S+\s+add\b/i.test(statement) &&
      /\bnot\s+null\b/i.test(statement) &&
      !/\bdefault\b/i.test(statement),
  );
}

/** Splits at commas that aren't inside parentheses or string literals. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** The text inside the parenthesis that opens at `open`, or null if it never closes. */
function balanced(text: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

/** `(a, "b", c)` at `from` (after optional spaces) as lowercase names, or null. */
function columnList(text: string, from = 0): string[] | null {
  const open = text.indexOf("(", from);
  if (open === -1 || text.slice(from, open).trim()) return null;
  const inner = balanced(text, open);
  if (inner === null) return null;
  return splitTopLevel(inner).map((c) => c.replace(/"/g, "").trim().toLowerCase());
}

const tenantFirst = (columns: string[] | null) => columns?.[0] === TENANT;
const withoutStrings = (text: string) => text.replace(/'(?:[^']|'')*'/g, "''");
const isIdentity = (table: string) => (IDENTITY_TABLES as readonly string[]).includes(table);
const unquote = (name: string) =>
  name
    .replace(/"/g, "")
    .replace(/^public\./i, "")
    .toLowerCase();

/**
 * Key problems in one element of a tenant table (a `CREATE TABLE` item or an `ALTER TABLE … ADD`
 * clause): organization_id first in a primary key, unique constraint and a foreign key to another
 * tenant table; a reference to an identity table (a person) may be a single column.
 */
function constraintProblem(table: string, item: string): string | null {
  const text = withoutStrings(item).replace(/^\s*constraint\s+"?\w+"?\s+/i, "");
  const key = /^\s*(primary\s+key|unique)\b/i.exec(text);
  if (key) {
    if (!tenantFirst(columnList(text, key[0].length)))
      return `${table}'s ${key[1]!.toUpperCase().replace(/\s+/g, " ")} must start with ${TENANT}, so every key stays inside one organization`;
    return null;
  }
  const foreign = /^\s*foreign\s+key\b/i.exec(text);
  if (foreign) {
    const references = /\breferences\s+((?:"?\w+"?\.)?"?\w+"?)\s*/i.exec(text);
    const target = references ? unquote(references[1]!) : "";
    if (isIdentity(target)) return null;
    if (target === TENANT_ROOT) {
      const local = columnList(text, foreign[0].length);
      return local?.length === 1 && local[0] === TENANT
        ? null
        : `${table}'s FOREIGN KEY to organizations must be (${TENANT})`;
    }
    const local = columnList(text, foreign[0].length);
    const remote = references ? columnList(text, references.index + references[0].length) : null;
    if (!tenantFirst(local) || !tenantFirst(remote))
      return `${table}'s FOREIGN KEY must be composite with ${TENANT} first on both sides (FOREIGN KEY (${TENANT}, …) REFERENCES t (${TENANT}, …)), so a row can't point at another organization's row`;
    return null;
  }
  if (/^\s*(check|exclude)\b/i.test(text)) return null;
  const column = /^\s*"?(\w+)"?/.exec(text)?.[1]?.toLowerCase();
  if (column === TENANT) return null;
  if (/\bprimary\s+key\b/i.test(text))
    return `${table}.${column} is a single-column PRIMARY KEY; use PRIMARY KEY (${TENANT}, ${column})`;
  if (/\breferences\b/i.test(text)) {
    const target = /\breferences\s+((?:"?\w+"?\.)?"?\w+"?)/i.exec(text)?.[1];
    if (target && isIdentity(unquote(target))) return null;
    return `${table}.${column} has a single-column REFERENCES; use a composite FOREIGN KEY (${TENANT}, ${column})`;
  }
  if (/\bunique\b/i.test(text))
    return `${table}.${column} is UNIQUE on its own; use UNIQUE (${TENANT}, ${column})`;
  return null;
}

export function judgeMigration(sql: string): MigrationVerdict {
  const fail = (reason: string): MigrationVerdict => ({ ok: false, reason });
  const contract = sql.match(/^--\s*contract:\s*(.+)$/im)?.[1]?.trim() || null;
  const allowedIndexes = new Set(
    [...sql.matchAll(/^--\s*cross-tenant index:\s*"?(\w+)"?\s*:\s*\S.*$/gim)].map((m) =>
      m[1]!.toLowerCase(),
    ),
  );
  const statements = splitStatements(sql);
  const body = withoutComments(sql);
  if (addsNotNullWithoutDefault(statements))
    return fail(
      "adds a NOT NULL column without a default, which fails on existing rows and breaks the live code's inserts; make it nullable or give it a default",
    );
  const destructive = DESTRUCTIVE.filter(({ pattern }) => pattern.test(withoutStrings(body))).map(
    (d) => d.what,
  );
  if (destructive.length && !contract)
    return fail(
      `${destructive.join(" and ")}: something the live code may still use. Add a \`-- contract: <why the code no longer uses it>\` header and ship it after that code change`,
    );

  for (const statement of statements) {
    const fn = /^create\s+(?:or\s+replace\s+)?function\s+((?:"?\w+"?\.)?"?\w+"?)/i.exec(statement);
    if (!fn) continue;
    const definer = /\bsecurity\s+definer\b/i.test(
      statement.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, ""),
    );
    if (!definer) continue;
    const name = unquote(fn[1]!);
    if (!(DEFINER_FUNCTIONS as readonly string[]).includes(name))
      return fail(
        `creates the SECURITY DEFINER function ${name}, which reads around row-level security. Only ${DEFINER_FUNCTIONS.join(", ")} may (packages/db/src/node/rules.ts)`,
      );
    if (!/\bset\s+search_path\b/i.test(statement))
      return fail(
        `the SECURITY DEFINER function ${name} must pin its search_path (SET search_path = public, pg_temp)`,
      );
  }

  const noTransaction = isNoTransaction(sql);
  const tables = new Map<string, string>();
  for (const statement of statements) {
    const create =
      /^create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)\s*/i.exec(
        statement,
      );
    if (!create) continue;
    const name = unquote(create[1]!);
    const body = balanced(statement, create[0].length);
    if (body === null) return fail(`can't read the definition of ${name}`);
    tables.set(name, body);
  }
  const rls = (table: string) =>
    statements.some((s) =>
      new RegExp(`enable_tenant_rls\\(\\s*'(?:public\\.)?"?${table}"?'\\s*\\)`, "i").test(s),
    );
  for (const [table, body] of tables) {
    if (isIdentity(table)) continue;
    if (table === TENANT_ROOT) {
      const forced = statements.some((s) =>
        /alter\s+table\s+"?organizations"?\s+force\s+row\s+level\s+security/i.test(s),
      );
      const policy = statements.some((s) =>
        /create\s+policy\s+"?tenant_isolation"?\s+on\s+"?organizations"?/i.test(s),
      );
      if (!forced || !policy)
        return fail(
          "creates organizations without FORCE ROW LEVEL SECURITY and its tenant_isolation policy",
        );
      continue;
    }
    const items = splitTopLevel(body);
    if (!items.some((item) => new RegExp(`^"?${TENANT}"?\\s`, "i").test(item)))
      return fail(
        `creates ${table} without ${TENANT}. Every table except the identity tables (${IDENTITY_TABLES.join(", ")}) belongs to an organization`,
      );
    for (const item of items) {
      const problem = constraintProblem(table, item);
      if (problem) return fail(problem);
    }
    const keyed =
      items.some((item) => /^\s*(constraint\s+"?\w+"?\s+)?primary\s+key\b/i.test(item)) ||
      statements.some((s) =>
        new RegExp(
          `^alter\\s+table\\s+(?:only\\s+)?(?:public\\.)?"?${table}"?\\s+add\\s+(constraint\\s+"?\\w+"?\\s+)?primary\\s+key\\b`,
          "i",
        ).test(s),
      );
    if (!keyed) return fail(`creates ${table} without PRIMARY KEY (${TENANT}, …)`);
    if (!rls(table))
      return fail(
        `creates ${table} without SELECT enable_tenant_rls('${table}'): every tenant table needs forced row-level security and its policy`,
      );
  }
  for (const statement of statements) {
    const index =
      /^create\s+(?:unique\s+)?index\s+(concurrently\s+)?(if\s+not\s+exists\s+)?("?\w+"?\s+)?on\s+(?:only\s+)?((?:"?\w+"?\.)?"?\w+"?)\s*(?:using\s+\w+\s*)?/i.exec(
        statement,
      );
    if (index) {
      const [, concurrently, ifNotExists, rawName, rawTable] = index;
      const table = unquote(rawTable!);
      const name = rawName ? unquote(rawName.trim()) : "";
      if (!isIdentity(table) && table !== TENANT_ROOT) {
        if (!tenantFirst(columnList(statement, index[0].length)) && !allowedIndexes.has(name))
          return fail(
            `an index on ${table} must start with ${TENANT}: every query is scoped to one organization (or add \`-- cross-tenant index: ${name || "<name>"}: <reason>\`)`,
          );
      }
      if (!concurrently && !tables.has(table))
        return fail(
          `builds an index on the existing table ${table} with a lock that blocks its writes; use CREATE INDEX CONCURRENTLY IF NOT EXISTS in a file that starts with \`-- no-transaction\``,
        );
      if (concurrently && !noTransaction)
        return fail(
          "CREATE INDEX CONCURRENTLY can't run in a transaction; make `-- no-transaction` the file's first line",
        );
      if (concurrently && !ifNotExists)
        return fail(
          "use CREATE INDEX CONCURRENTLY IF NOT EXISTS, so the file can run again after a failed build",
        );
      continue;
    }
    const alter =
      /^alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)\s+/i.exec(statement);
    if (!alter) continue;
    const table = unquote(alter[1]!);
    const existing = !tables.has(table);
    for (const action of splitTopLevel(statement.slice(alter[0].length))) {
      const text = withoutStrings(action);
      if (
        /^add\b/i.test(text) &&
        /\bdefault\s+(gen_random_uuid|random|clock_timestamp|uuid_generate)/i.test(text)
      )
        return fail(
          "adds a column with a volatile default, which rewrites the whole table; add it nullable and backfill in batches",
        );
      const added = /^add\s+(?!column\b)/i.test(text)
        ? text.replace(/^add\s+/i, "")
        : /^add\s+column\s+(?:if\s+not\s+exists\s+)?/i.test(text)
          ? text.replace(/^add\s+column\s+(?:if\s+not\s+exists\s+)?/i, "")
          : null;
      if (added !== null) {
        const constraint = added.replace(/^\s*constraint\s+"?\w+"?\s+/i, "");
        if (!isIdentity(table) && table !== TENANT_ROOT) {
          const problem = constraintProblem(table, added);
          if (problem) return fail(problem);
        }
        if (existing) {
          if (/^primary\s+key\b/i.test(constraint))
            return fail(
              `adds a PRIMARY KEY to the existing table ${table}, which scans it under a lock; give the table its key when it's created`,
            );
          if (/^(foreign\s+key|check)\b/i.test(constraint) && !/\bnot\s+valid\b/i.test(constraint))
            return fail(
              `adds a constraint to the existing table ${table} that checks every row under a lock; add it NOT VALID and VALIDATE CONSTRAINT in a later migration`,
            );
        }
      }
      if (existing && /^alter\s+(column\s+)?\S+\s+set\s+not\s+null\b/i.test(text))
        return fail(
          `runs SET NOT NULL on a column of the existing table ${table}, which scans it under a lock; add a CHECK (… IS NOT NULL) NOT VALID constraint and validate it instead`,
        );
    }
  }
  return { ok: true, contract };
}
