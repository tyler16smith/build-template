/**
 * A write an action refused with `confirmation_required` (a bulk delete, say: too large to run
 * without the person's say-so). The tool result tells the model; when it calls the same tool with
 * the same input again, the person gets an approval card for it, and only their approval lets it
 * run with `ctx.confirmed`. Ported from Custombase's `bulk-confirmation.ts`.
 */

/** How long a stopped write waits for the model to ask again. */
const PENDING_MS = 10 * 60_000;

export type PendingStore = Pick<DurableObjectStorage, "get" | "put" | "delete">;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** One storage key per action and exact input. */
export async function pendingKey(actionId: string, input: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${actionId}\n${stable(input)}`),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `confirmation:${hex}`;
}

export async function isPending(store: PendingStore, key: string, now = Date.now()) {
  const expiresAt = await store.get<number>(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    await store.delete(key);
    return false;
  }
  return true;
}

export async function rememberPending(store: PendingStore, key: string, now = Date.now()) {
  await store.put(key, now + PENDING_MS);
}

/** What the model is told when a write stops for the person's confirmation. */
export function confirmationReply(message: string) {
  return {
    confirmationRequired: true,
    message: `${message} If they agree, call this tool again with exactly the same input; they'll be asked to approve it. Don't split it into smaller calls.`,
  };
}
