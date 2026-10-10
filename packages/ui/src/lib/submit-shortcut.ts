/**
 * ⌘+Enter (Apple platforms) or Ctrl+Enter (everything else) runs the primary action of the view
 * the person is working in. `ThemeProvider` installs the listener; see `specs/submit-shortcut.md`.
 */

/** Marks a view (dialog, sheet, side panel) whose primary action the shortcut can run. */
export const SUBMIT_SCOPE_ATTR = "data-submit-scope";
const SCOPE_SELECTOR = `form, [${SUBMIT_SCOPE_ATTR}]`;

/** macOS, iOS and iPadOS use ⌘; Windows, Linux, ChromeOS and Android use Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent;
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

type ChordEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "isComposing" | "repeat"
>;

/** True for the platform's submit chord: ⌘+Enter on Apple platforms, Ctrl+Enter elsewhere. */
export function isSubmitShortcut(event: ChordEvent, apple = isApplePlatform()): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.altKey || event.isComposing) return false;
  return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** The chord as shown in hints: "⌘↵" or "Ctrl+Enter". */
export function submitShortcutLabel(apple = isApplePlatform()): string {
  return apple ? "⌘↵" : "Ctrl+Enter";
}

function usable(button: HTMLButtonElement | HTMLInputElement): boolean {
  if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;
  if (button.closest("[inert], [hidden]")) return false;
  return typeof button.checkVisibility === "function" ? button.checkVisibility() : true;
}

function isSubmitControl(el: Element): el is HTMLButtonElement | HTMLInputElement {
  return (
    (el instanceof HTMLButtonElement && el.type === "submit") ||
    (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "image"))
  );
}

function openScopes(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>(`[${SUBMIT_SCOPE_ATTR}]`)).filter(
    (scope) => scope.getAttribute("data-state") !== "closed" && !scope.closest("[inert]"),
  );
}

/** The action the shortcut runs from `target`, or null when the view has no single clear one. */
export function resolveSubmitAction(target: Element | null, doc: Document): (() => void) | null {
  let scope = target?.closest<HTMLElement>(SCOPE_SELECTOR) ?? null;
  // Focus in a portaled menu or popover belongs to the topmost open dialog or sheet.
  if (!scope) {
    const dialogs = openScopes(doc).filter((el) => el.getAttribute("role") === "dialog");
    scope = dialogs.at(-1) ?? null;
  }
  if (!scope) return null;

  const explicit = Array.from(
    scope.querySelectorAll<HTMLButtonElement>('button[data-submit-shortcut="true"]'),
  ).find(usable);
  if (explicit) return () => explicit.click();

  if (scope instanceof HTMLFormElement) {
    const form = scope;
    const defaultButton = Array.from(form.elements).find(isSubmitControl);
    if (defaultButton)
      return usable(defaultButton) ? () => form.requestSubmit(defaultButton) : null;
  }

  const primaries = Array.from(
    scope.querySelectorAll<HTMLButtonElement>('button[data-variant="primary"]'),
  ).filter((button) => button.dataset.submitShortcut !== "false" && usable(button));
  if (primaries.length === 1) return () => primaries[0]!.click();
  if (primaries.length > 1) return null;

  if (scope instanceof HTMLFormElement) {
    const form = scope;
    return () => form.requestSubmit();
  }
  return null;
}

function onKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.repeat || !isSubmitShortcut(event)) return;
  const doc = (event.target as Node | null)?.ownerDocument ?? document;
  const target = event.target instanceof Element ? event.target : doc.activeElement;
  const action = resolveSubmitAction(target, doc);
  if (!action) return;
  event.preventDefault();
  action();
}

let installs = 0;

/** Installs the document listener once, however many providers mount. Returns the uninstall. */
export function installSubmitShortcut(doc: Document = document): () => void {
  if (installs++ === 0) doc.addEventListener("keydown", onKeyDown);
  return () => {
    if (--installs === 0) doc.removeEventListener("keydown", onKeyDown);
  };
}
