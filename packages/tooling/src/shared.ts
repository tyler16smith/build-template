import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

// The root `.env` (`.env.example` lists every name). Variables already set, as in CI, win.
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

export type Env = "local" | "staging" | "production";

export function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const inline = args.find((a) => a.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

export function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--")) {
      if (!args[i]!.includes("=") && args[i + 1] && !args[i + 1]!.startsWith("--")) i++;
      continue;
    }
    out.push(args[i]!);
  }
  return out;
}

export function envOption(args: string[], fallback?: Env): Env {
  const value = option(args, "--env") ?? fallback;
  if (value !== "local" && value !== "staging" && value !== "production")
    throw new Error("Say which database: --env local|staging|production");
  return value;
}

export function run(
  command: string,
  args: string[],
  options: SpawnSyncOptions & { allowFailure?: boolean; quiet?: boolean } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : "inherit",
    ...options,
  });
  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFailure)
    throw new Error(
      `${command} ${args.join(" ")} failed (${status})${result.stderr ? `: ${String(result.stderr).trim()}` : ""}`,
    );
  return { status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

/** `KEY=value` lines from `apps/server/.dev.vars` (else `.dev.vars.example`). */
export function devVars(): Record<string, string> {
  for (const name of [".dev.vars", ".dev.vars.example"]) {
    const path = join(ROOT, "apps/server", name);
    if (!existsSync(path)) continue;
    const vars: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match) vars[match[1]!] = match[2]!.replace(/^"(.*)"$/, "$1");
    }
    return vars;
  }
  return {};
}

export function step(title: string): void {
  console.log(`\n▸ ${title}`);
}
