import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { actionsJsonSchema } from "@template/contracts";
import { sourceFiles, withoutComments } from "./checks";
import { ROOT, step } from "./shared";

/**
 * `pnpm check:permissions` (`specs/organizations.md`, "No organization in action inputs"):
 *
 * - no action's input names an organization (`organizationId` or `organization_id`, at any
 *   depth): the organization always comes from `ctx.organization`;
 * - no file compares a role to a role literal (`role === "owner"`, `.includes("admin")`,
 *   `switch (role)`) except `packages/contracts/src/permissions.ts`. Code asks for a permission.
 *   Fixtures, the seed and tests are exempt.
 */

const ORGANIZATION_KEY = /^organization_?id$/i;
const ROLE = `["'](?:owner|admin|member)["']`;
const ROLE_COMPARISONS: { pattern: RegExp; what: string }[] = [
  {
    pattern: new RegExp(`\\brole\\??\\s*[!=]==?\\s*${ROLE}`),
    what: "compares a role to a role",
  },
  {
    pattern: new RegExp(`${ROLE}\\s*[!=]==?\\s*[\\w.?]*\\brole\\b`),
    what: "compares a role to a role",
  },
  { pattern: new RegExp(`\\.includes\\(\\s*${ROLE}\\s*\\)`), what: "looks for a role in a list" },
  {
    pattern: new RegExp(`\\[[^\\]]*${ROLE}[^\\]]*\\]\\s*\\.includes\\(\\s*[\\w.?]*\\brole\\s*\\)`),
    what: "looks a role up in a list of roles",
  },
  { pattern: /\bswitch\s*\(\s*[\w.?]*\brole\s*\)/, what: "switches on a role" },
];

/** Where comparing roles is allowed: the one permissions file, the seed, fixtures and tests. */
const EXEMPT =
  /^(packages\/contracts\/src\/permissions\.ts$|packages\/tooling\/src\/seed[\w-]*\.ts$|e2e\/)|\/(test|tests|fixtures?)\/|\.test\.tsx?$/;

/** Every key path in a JSON Schema's properties that names an organization. */
export function organizationKeys(schema: unknown, path = ""): string[] {
  if (!schema || typeof schema !== "object") return [];
  const found: string[] = [];
  const node = schema as Record<string, unknown>;
  const properties = node.properties as Record<string, unknown> | undefined;
  if (properties)
    for (const [key, value] of Object.entries(properties)) {
      const here = path ? `${path}.${key}` : key;
      if (ORGANIZATION_KEY.test(key)) found.push(here);
      found.push(...organizationKeys(value, here));
    }
  for (const key of ["items", "additionalProperties", "anyOf", "oneOf", "allOf", "prefixItems"]) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach((c) => found.push(...organizationKeys(c, path)));
    else if (child && typeof child === "object") found.push(...organizationKeys(child, path));
  }
  return found;
}

/** Actions whose input names an organization, as sentences. */
export function organizationInputProblems(
  actions = (actionsJsonSchema() as { actions: Record<string, { input: unknown }> }).actions,
): string[] {
  return Object.entries(actions).flatMap(([id, action]) =>
    organizationKeys(action.input).map(
      (key) =>
        `${id}: its input has ${key}. The organization comes from ctx.organization, never from input`,
    ),
  );
}

/** Role comparisons in one file, as sentences (none for an exempt file). */
export function roleComparisonProblems(path: string, source: string): string[] {
  if (EXEMPT.test(path)) return [];
  const code = withoutComments(source);
  const problems: string[] = [];
  for (const { pattern, what } of ROLE_COMPARISONS) {
    const match = pattern.exec(code);
    if (match)
      problems.push(
        `${path}: ${match[0].trim()} ${what}. Ask for a permission instead (ctx.can, requirePermission, useCan; packages/contracts/src/permissions.ts)`,
      );
  }
  return problems;
}

export function checkPermissions(): void {
  step("No organization in action inputs");
  const inputs = organizationInputProblems();
  console.log(inputs.length ? `  ${inputs.length} problems` : "  ok");
  step("No role comparisons outside packages/contracts/src/permissions.ts");
  const files = sourceFiles();
  const roles = files.flatMap((file) =>
    roleComparisonProblems(relative(ROOT, file), readFileSync(file, "utf8")),
  );
  console.log(roles.length ? `  ${roles.length} problems` : `  ${files.length} files, ok`);
  const problems = [...inputs, ...roles];
  if (problems.length) throw new Error(problems.join("\n"));
}
