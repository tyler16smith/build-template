/**
 * UUID v7 (RFC 9562): a 48-bit millisecond timestamp, then random bits. Ids sort by creation
 * time, so b-tree indexes stay compact, and they're safe to show (they carry no counter).
 */
export function uuidv7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const time = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((time >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * A new organization's id: UUID v7, created once and never reused, renumbered or parsed. It's the
 * company's id in logs, metrics, MCP grants, webhooks and Zapier payloads, and in any other
 * product built from this template (`specs/organizations.md`, "One organization ID across
 * products").
 */
export function newOrganizationId(): string {
  return uuidv7();
}
