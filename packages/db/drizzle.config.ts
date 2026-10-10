import { defineConfig } from "drizzle-kit";

// `pnpm db:new <name>` runs `drizzle-kit generate --name <name>`: it diffs src/schema.ts against
// the last snapshot in migrations/meta and writes the next numbered file for review.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  migrations: { prefix: "index" },
});
