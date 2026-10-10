import { organizationTracker, type ApiClientError } from "@template/api-client";

/**
 * Two tabs share one session, so one organization is open in both. When this tab switches (or
 * creates or joins a company), the others reload before anyone types; a save from a tab that
 * missed it is refused by the server (`organization_changed`), and that tab reloads too, with a
 * notice. `screens` can't touch the window, so this lives here.
 */
const CHANNEL = "organization";
const NOTICE_KEY = "organization-switched";

const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);

/** Shared by both API clients, so every call carries the same `X-Organization-Id`. */
export const organization = organizationTracker((organizationId) =>
  channel?.postMessage({ organizationId }),
);

channel?.addEventListener("message", (event: MessageEvent<{ organizationId?: string | null }>) => {
  if (organization.seen && event.data?.organizationId !== organization.current) reloadSwitched();
});

/** Reloads into the organization the session has open now, and says why after the reload. */
export function reloadSwitched(): void {
  try {
    sessionStorage.setItem(NOTICE_KEY, "1");
  } catch {
    // Private mode: reload without the notice.
  }
  window.location.reload();
}

/** True once after a reload `reloadSwitched` caused. */
export function takeSwitchNotice(): boolean {
  try {
    const set = sessionStorage.getItem(NOTICE_KEY) === "1";
    sessionStorage.removeItem(NOTICE_KEY);
    return set;
  } catch {
    return false;
  }
}

/** The API clients' error hook: a page loaded for the previous organization reloads. */
export function onApiError(error: ApiClientError): void {
  if (error.code === "organization_changed") reloadSwitched();
}
