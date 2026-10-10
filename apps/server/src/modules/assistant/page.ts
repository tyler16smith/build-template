import { AssistantPageHint } from "@template/contracts";

/**
 * The screen the person is on, sent by the browser with each turn
 * (`useAssistantPageContext`). A hint for the prompt only, put there as untrusted data: never
 * authorization. Every tool call is checked on its own.
 */
export function readPageHint(body: unknown): AssistantPageHint | null {
  if (!body || typeof body !== "object") return null;
  const parsed = AssistantPageHint.safeParse((body as { page?: unknown }).page);
  if (!parsed.success) return null;
  const page = parsed.data;
  return page.path || page.title || page.selection ? page : null;
}

type TitledMessage = {
  role: string;
  parts?: readonly { type: string; text?: string; mediaType?: string }[];
};

/** The first thing the person said, kept short enough to name the conversation. */
export function firstUserMessageTitle(messages: readonly TitledMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== "user" || !message.parts) continue;
    const text = message.parts
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text.slice(0, 80);
    if (message.parts.some((part) => part.type === "file" && part.mediaType?.startsWith("image/")))
      return "Image";
  }
  return null;
}
