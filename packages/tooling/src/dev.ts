import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { lookup } from "node:dns/promises";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allowDemo, dbLocal, dbMigrate, localNeon } from "./db";
import { ROOT, step } from "./shared";

/**
 * `pnpm dev`: local Postgres (Docker, or the Neon database in `LOCAL_DATABASE_URL`), migrated, then
 * `wrangler dev` for the Worker and Vite for the web app. Vite proxies the Worker's paths, so the
 * browser sees one origin (https://app.local.private), as in production. The Worker talks to
 * Postgres directly.
 */
export async function dev(): Promise<void> {
  await localHttps();
  const vars = join(ROOT, "apps/server/.dev.vars");
  if (!existsSync(vars)) {
    copyFileSync(join(ROOT, "apps/server/.dev.vars.example"), vars);
    console.log("created apps/server/.dev.vars from .dev.vars.example");
  }
  // wrangler checks the assets directory exists; Vite serves the real pages in development.
  const dist = join(ROOT, "apps/web/dist");
  if (!existsSync(join(dist, "index.html"))) {
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(dist, "index.html"),
      "<!doctype html><p>Open https://app.local.private (Vite).</p>",
    );
  }
  const neon = localNeon();
  step(neon ? `Postgres (Neon: ${new URL(neon.runtime).hostname})` : "Postgres");
  if (!neon) await dbLocal();
  step("Migrations");
  await dbMigrate("local");
  await allowDemo("local");
  step("Worker (8787) and web (443)");
  console.log(`Open ${DEV_ORIGIN}. Load the demo team with: pnpm db:seed --env local\n`);
  // Hyperdrive's localConnectionString points at Docker; this overrides it for wrangler dev.
  const env = neon
    ? { ...process.env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: neon.runtime }
    : process.env;
  const children: ChildProcess[] = [
    spawn("pnpm", ["--filter", "@template/server", "dev"], { cwd: ROOT, stdio: "inherit", env }),
    spawn("pnpm", ["--filter", "@template/web", "dev"], { cwd: ROOT, stdio: "inherit" }),
  ];
  const stop = () => {
    for (const child of children) child.kill("SIGINT");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise<void>((resolve, reject) => {
    for (const child of children)
      child.on("exit", (code) => {
        stop();
        if (code && code !== 130) reject(new Error(`a dev process exited with ${code}`));
        else resolve();
      });
  });
}

const DEV_HOST = "app.local.private";
const DEV_ORIGIN = `https://${DEV_HOST}`;

/**
 * The local origin is https://app.local.private: the host name must point at this machine, and
 * Vite needs a certificate for it, made by mkcert (whose CA `mkcert -install` trusted) in
 * `.certs/` (git-ignored).
 */
async function localHttps(): Promise<void> {
  const address = await lookup(DEV_HOST).catch(() => null);
  if (address?.address !== "127.0.0.1" && address?.address !== "::1")
    throw new Error(
      `${DEV_HOST} doesn't point at this machine. Add it to /etc/hosts:\n  echo "127.0.0.1 ${DEV_HOST}" | sudo tee -a /etc/hosts`,
    );
  const certs = join(ROOT, ".certs");
  if (existsSync(join(certs, `${DEV_HOST}.pem`)) && existsSync(join(certs, `${DEV_HOST}-key.pem`)))
    return;
  mkdirSync(certs, { recursive: true });
  const made = spawnSync(
    "mkcert",
    [
      "-cert-file",
      join(certs, `${DEV_HOST}.pem`),
      "-key-file",
      join(certs, `${DEV_HOST}-key.pem`),
      DEV_HOST,
    ],
    { stdio: "inherit" },
  );
  if (made.error || made.status !== 0)
    throw new Error(
      "mkcert couldn't make the local certificate. Install it once: brew install mkcert && mkcert -install",
    );
}
