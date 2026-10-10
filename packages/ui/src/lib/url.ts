/** A link as people read it: host and path, shortened in the middle when it's long. */
export function shortUrl(href: string, max = 48): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  const host = url.host.replace(/^www\./, "");
  const path = `${url.pathname}${url.search}`.replace(/\/$/, "");
  const full = `${host}${path}`;
  if (full.length <= max) return full;
  const last = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  const room = Math.max(8, max - host.length - 3);
  const tail = last.length > room ? `${last.slice(0, room - 1)}…` : last;
  return `${host}/…/${tail}`;
}
