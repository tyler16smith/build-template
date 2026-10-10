import {
  ChatApproval,
  ChatBubble,
  ChatMessage,
  ChatPending,
  ChatSteps,
  ChatText,
  CopyButton,
  LightboxImage,
  Markdown,
  formatElapsed,
  reasoningCover,
  stepCover,
  type ChatStep,
} from "@template/ui";
import {
  getToolName,
  isFileUIPart,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
} from "ai";
import { useRef, type ReactNode } from "react";

export type AgentToolPart = Parameters<typeof getToolName>[0];

/** How a surface names one of its tool calls: a short imperative title and optional detail. */
export type ToolDescription = {
  /** "Update profile". Shown as "Updating profile" while it runs. */
  title: string;
  detail?: ReactNode;
  /** The tool ran but reports it didn't do its job. */
  failed?: boolean;
};

export type DescribeTool = (part: AgentToolPart) => ToolDescription;

type Segment =
  | { kind: "text"; key: string; text: string }
  | { kind: "image"; key: string; url: string; name: string }
  | { kind: "steps"; key: string; steps: ChatStep[]; reasoningOnly: boolean }
  | { kind: "approval"; key: string; part: AgentToolPart; title: string };

/** The reasoning without its opening bold title when that title is already the step's cover. */
function withoutLeadingTitle(text: string, cover: string): string {
  const trimmed = text.trim();
  const title = /^\*\*([^*\n]+)\*\*\s*(?:\n|$)/.exec(trimmed);
  return title && title[1]!.trim() === cover ? trimmed.slice(title[0].length).trim() : trimmed;
}

type TimedMetadata = { startedAt?: string; finishedAt?: string } | undefined;

/** Only data URLs of raster images are shown; anything else in a file part is ignored. */
export function displayImageUrl(url: string, mediaType: string): string | null {
  if (!mediaType.startsWith("image/") || mediaType === "image/svg+xml") return null;
  return /^data:image\/(png|jpeg|webp|gif)[;,]/.test(url) ? url : null;
}

export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  return Object.entries(input as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

function toolStep(
  part: AgentToolPart,
  describe: DescribeTool,
  streaming: boolean,
): ChatStep | null {
  const { title, detail, failed } = describe(part);
  const id = part.toolCallId;
  switch (part.state) {
    case "output-available":
      return { id, cover: title, detail, state: failed ? "error" : "done" };
    case "output-error":
      return {
        id,
        cover: title,
        state: "error",
        detail: (
          <>
            {detail ? <span className="block">{detail}</span> : null}
            <span className="text-danger">{part.errorText}</span>
          </>
        ),
      };
    case "output-denied":
      return { id, cover: title, detail: "You declined this.", state: "done" };
    case "approval-requested":
      return null;
    default: {
      const state = streaming ? "active" : "done";
      return { id, cover: stepCover(title, state), detail, state };
    }
  }
}

/**
 * A message's parts in reading order. Consecutive reasoning and tool calls form one steps block;
 * text between them ends it. Approval requests are never folded into a block.
 */
export function messageSegments(
  message: UIMessage,
  describe: DescribeTool,
  streaming: boolean,
): Segment[] {
  const segments: Segment[] = [];
  let group: Extract<Segment, { kind: "steps" }> | null = null;
  const close = () => {
    if (group?.steps.length) segments.push(group);
    group = null;
  };
  const open = (index: number) =>
    (group ??= { kind: "steps", key: `steps-${index}`, steps: [], reasoningOnly: true });

  message.parts.forEach((part, index) => {
    if (isTextUIPart(part)) {
      if (!part.text.trim()) return;
      close();
      segments.push({ kind: "text", key: `text-${index}`, text: part.text });
    } else if (isFileUIPart(part)) {
      const url = displayImageUrl(part.url, part.mediaType);
      if (!url) return;
      close();
      segments.push({
        kind: "image",
        key: `file-${index}`,
        url,
        name: part.filename || "Attached image",
      });
    } else if (isReasoningUIPart(part)) {
      const thinking = streaming && part.state === "streaming";
      if (!part.text.trim() && !thinking) return;
      const cover = reasoningCover(part.text);
      const detail = withoutLeadingTitle(part.text, cover);
      open(index).steps.push({
        id: `reasoning-${index}`,
        cover,
        detail: detail ? <Markdown source={detail} className="space-y-1.5 text-xs" /> : undefined,
        state: thinking ? "active" : "done",
      });
    } else if (isToolUIPart(part)) {
      if (part.state === "approval-requested") {
        close();
        segments.push({
          kind: "approval",
          key: `approval-${index}`,
          part,
          title: describe(part).title,
        });
        return;
      }
      const step = toolStep(part, describe, streaming);
      if (!step) return;
      const current = open(index);
      current.steps.push(step);
      current.reasoningOnly = false;
    }
  });
  close();
  return segments;
}

function stepsSummary(
  segment: Extract<Segment, { kind: "steps" }>,
  elapsedMs: number | null,
): string {
  const verb = segment.reasoningOnly ? "Thought" : "Worked";
  if (elapsedMs !== null) return `${verb} for ${formatElapsed(elapsedMs)}`;
  if (segment.steps.length === 1)
    return segment.reasoningOnly ? "Thought" : segment.steps[0]!.cover;
  return `${verb} through ${segment.steps.length} steps`;
}

/** Whether to show the "Thinking" line: a reply is on its way but nothing of it has arrived. */
export function awaitingReply(messages: UIMessage[], busy: boolean): boolean {
  return busy && messages.at(-1)?.role !== "assistant";
}

/**
 * One AI SDK message, rendered with the chat primitives: the person's words in a bubble; replies
 * as text, with their reasoning and tool calls folded into steps that shimmer while they run.
 */
export function AgentMessage({
  message,
  streaming,
  latest,
  describeTool,
  onApproval,
  footer,
  notice,
}: {
  message: UIMessage;
  /** This message is the one currently streaming. */
  streaming: boolean;
  /** The newest message: its actions stay visible. */
  latest?: boolean;
  describeTool: DescribeTool;
  onApproval?: (approvalId: string, approved: boolean) => void;
  /** Beside Copy under a finished reply, such as the model and cost. */
  footer?: ReactNode;
  /** Below a finished reply. */
  notice?: ReactNode;
}) {
  // Times each steps block while it streams, so it can settle to "Thought for 6s".
  const timing = useRef<{ start: number | null; ends: Record<string, number> }>({
    start: null,
    ends: {},
  });
  const segments = messageSegments(message, describeTool, streaming);

  if (message.role === "user") {
    return (
      <ChatMessage role="user">
        {segments.map((segment) =>
          segment.kind === "image" ? (
            <LightboxImage
              key={segment.key}
              src={segment.url}
              alt={segment.name}
              className="max-w-[85%]"
              imgClassName="max-h-48 max-w-full rounded-xl border border-border object-contain"
            />
          ) : segment.kind === "text" ? (
            <ChatBubble key={segment.key}>{segment.text}</ChatBubble>
          ) : null,
        )}
      </ChatMessage>
    );
  }

  const now = Date.now();
  if (streaming && timing.current.start === null) timing.current.start = now;
  const metadata = message.metadata as TimedMetadata;
  const groups = segments.filter((segment) => segment.kind === "steps");
  const recorded =
    metadata?.startedAt && metadata.finishedAt
      ? Date.parse(metadata.finishedAt) - Date.parse(metadata.startedAt)
      : null;
  const text = segments
    .filter((segment) => segment.kind === "text")
    .map((segment) => segment.text)
    .join("\n\n");

  if (streaming && segments.length === 0) return <ChatPending />;

  return (
    <ChatMessage
      role="assistant"
      persistentActions={latest}
      actions={
        !streaming && text ? (
          <>
            <CopyButton text={text} label="Copy reply" />
            {footer}
          </>
        ) : undefined
      }
    >
      {segments.map((segment, index) => {
        switch (segment.kind) {
          case "text":
            return <ChatText key={segment.key} source={segment.text} />;
          case "image":
            return (
              <LightboxImage
                key={segment.key}
                src={segment.url}
                alt={segment.name}
                imgClassName="max-h-64 max-w-full rounded-xl border border-border object-contain"
              />
            );
          case "approval":
            return (
              <ChatApproval
                key={segment.key}
                title={segment.title}
                onApprove={() => onApproval?.(approvalId(segment.part), true)}
                onDecline={() => onApproval?.(approvalId(segment.part), false)}
              >
                {summarizeToolInput(segment.part.input) || null}
              </ChatApproval>
            );
          case "steps": {
            const active =
              streaming &&
              (index === segments.length - 1 ||
                segment.steps.some((step) => step.state === "active"));
            const { start, ends } = timing.current;
            if (!active && start !== null && ends[segment.key] === undefined)
              ends[segment.key] = now;
            const live =
              start !== null && ends[segment.key] !== undefined && segment === groups[0]
                ? ends[segment.key]! - start
                : null;
            const elapsed = live ?? (groups.length === 1 ? recorded : null);
            return (
              <ChatSteps
                key={segment.key}
                steps={segment.steps}
                active={active}
                summary={stepsSummary(segment, elapsed)}
              />
            );
          }
        }
      })}
      {!streaming && notice ? notice : null}
    </ChatMessage>
  );
}

function approvalId(part: AgentToolPart): string {
  return "approval" in part && part.approval ? part.approval.id : part.toolCallId;
}
