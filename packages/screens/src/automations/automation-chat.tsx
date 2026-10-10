import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { AgentConnection } from "@template/api-client";
import type { AgentMessageMetadata, AssistantConfig, DraftSaveResult } from "@template/contracts";
import {
  Button,
  ChatComposer,
  ChatError,
  ChatPending,
  ChatThread,
  ChatWelcome,
  LoadingState,
  ModelPicker,
  type ChatSuggestion,
} from "@template/ui";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { CalendarClock, Sparkles, Webhook, Zap } from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";
import { useApi } from "../context";
import { AgentMessage, awaitingReply, type DescribeTool } from "../assistant/agent-message";
import { modelPickerOptions, UsageLabel } from "../assistant/assistant";
import { useAgentConnection } from "../assistant/use-agent";

type BuilderMessage = UIMessage<AgentMessageMetadata | undefined>;

/** What each of the Builder's tools is called while it runs and afterwards. */
export const BUILDER_TOOL_TITLES: Record<string, string> = {
  get_automation: "Read the latest draft",
  save_draft: "Update the draft",
  simulate: "Run a simulated test",
  recent_runs: "Look at recent runs",
  search_catalog: "Search actions and steps",
  describe_actions: "Read action details",
  lookup: "Look up records",
  zapier_setup: "Prepare the Zapier setup",
};

export const BUILDER_SUGGESTIONS: ChatSuggestion[] = [
  {
    label: "Every Monday at 9am, email the owners a summary of last week",
    icon: CalendarClock,
  },
  {
    label: "When a webhook arrives, ask AI to sort it, then email the right person",
    icon: Webhook,
  },
  {
    label: "When a deal closes in HubSpot, email the team and send the details to Google Sheets",
    icon: Zap,
  },
];

type SaveOutput = { saved?: boolean; summary?: string; message?: string; revision?: number };

export const describeBuilderTool: DescribeTool = (part) => {
  const name = getToolName(part);
  const output =
    part.state === "output-available" ? (part.output as SaveOutput | undefined) : undefined;
  return {
    title: BUILDER_TOOL_TITLES[name] ?? name,
    failed: output?.saved === false,
    detail:
      output?.saved && output.summary
        ? `Revision ${output.revision}: ${output.summary}`
        : output?.saved === false
          ? `Not saved: ${output.message}`
          : undefined,
  };
};

export type SavedDraft = DraftSaveResult & { saved: true };

/** Calls `onDraftSaved` once for each `save_draft` that saved, after the history first loads. */
function useDraftSaves(messages: UIMessage[], onDraftSaved: (saved: SavedDraft) => void) {
  const seen = useRef<Set<string> | null>(null);
  const callback = useRef(onDraftSaved);
  callback.current = onDraftSaved;
  useEffect(() => {
    const parts = messages
      .flatMap((m) => m.parts.filter(isToolUIPart))
      .filter((p) => p.state === "output-available" && getToolName(p) === "save_draft");
    if (seen.current === null) {
      seen.current = new Set(parts.map((p) => p.toolCallId));
      return;
    }
    for (const part of parts) {
      if (seen.current.has(part.toolCallId)) continue;
      seen.current.add(part.toolCallId);
      const output = part.output as { saved?: boolean } | undefined;
      if (output?.saved) callback.current(output as SavedDraft);
    }
  }, [messages]);
}

type ChatProps = {
  automationId: string;
  onDraftSaved: (saved: SavedDraft) => void;
  canEdit: boolean;
  /** A description typed on the start screen, sent once when the conversation is empty. */
  initialPrompt?: string | null;
  onInitialPromptSent?: () => void;
  suggestions?: ChatSuggestion[];
};

/**
 * The Automation Builder conversation for one automation. The agent edits the same draft as the
 * visual editor; each save it makes reloads the editor with a diff.
 */
export function AutomationChat(props: ChatProps) {
  const agent = useAgentConnection("automation", props.automationId);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Sparkles aria-hidden className="size-4 text-primary" /> Automation Builder
        </p>
      </div>
      {agent ? (
        // useAgentChat suspends while it loads the history: keep that inside the chat column.
        <Suspense
          key={props.automationId}
          fallback={<LoadingState label="Loading the conversation" className="flex-1" />}
        >
          <BuilderChat {...props} agent={agent} />
        </Suspense>
      ) : (
        <LoadingState label="Opening the Builder" className="flex-1" />
      )}
    </div>
  );
}

function BuilderChat({
  agent,
  onDraftSaved,
  canEdit,
  initialPrompt,
  onInitialPromptSent,
  suggestions = BUILDER_SUGGESTIONS,
}: ChatProps & { agent: AgentConnection }) {
  const api = useApi();
  const [config, setConfig] = useState<AssistantConfig | null>(null);
  const [model, setModel] = useState("");
  const modelRef = useRef(model);
  modelRef.current = model;
  useEffect(() => {
    let live = true;
    api.assistant
      .config()
      .then((loaded) => {
        if (!live) return;
        setConfig(loaded);
        setModel((current) => current || loaded.defaultModel || loaded.models[0]?.id || "");
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api]);

  const {
    messages,
    sendMessage,
    regenerate,
    status,
    stop,
    clearHistory,
    addToolApprovalResponse,
    error,
  } = useAgentChat<unknown, BuilderMessage>({
    agent: agent as unknown as Parameters<typeof useAgentChat>[0]["agent"],
    body: () => (modelRef.current ? { model: modelRef.current } : {}),
  });
  const [text, setText] = useState("");
  const busy = status === "submitted" || status === "streaming";
  useDraftSaves(messages, onDraftSaved);

  const sentInitial = useRef(false);
  useEffect(() => {
    if (!initialPrompt || sentInitial.current) return;
    sentInitial.current = true;
    if (messages.length === 0) void sendMessage({ text: initialPrompt });
    onInitialPromptSent?.();
  }, [initialPrompt, messages.length, sendMessage, onInitialPromptSent]);

  function submit() {
    const message = text.trim();
    if (!message || busy) return;
    void sendMessage({ text: message });
    setText("");
  }

  const lastReply = messages.findLastIndex((message) => message.role === "assistant");
  return (
    <>
      {messages.length > 0 ? (
        <div className="flex justify-end px-3 pt-1">
          <Button variant="ghost" size="sm" onClick={() => clearHistory()} disabled={busy}>
            Clear chat
          </Button>
        </div>
      ) : null}
      <ChatThread
        pinKey={messages.filter((message) => message.role === "user").length}
        busy={busy}
        label="Conversation with the Automation Builder"
      >
        {messages.length === 0 ? (
          <ChatWelcome
            title="What should happen, and when?"
            description={
              canEdit
                ? "Describe it and I'll ask for anything essential, build the workflow alongside, and explain each step."
                : "Ask what this automation does, when it runs, or why a run failed."
            }
            suggestions={canEdit ? suggestions : []}
            onSuggestion={(suggestion) => void sendMessage({ text: suggestion })}
            footnote="The Builder only edits the draft. Nothing runs until you review it and publish it. Tests use sample data unless you choose a live test."
          />
        ) : (
          <>
            {messages.map((message, index) => (
              <AgentMessage
                key={message.id}
                message={message}
                streaming={busy && index === messages.length - 1}
                latest={index === lastReply}
                describeTool={describeBuilderTool}
                onApproval={(id, approved) => addToolApprovalResponse({ id, approved })}
                footer={
                  message.metadata?.usage ? <UsageLabel usage={message.metadata.usage} /> : null
                }
              />
            ))}
            {awaitingReply(messages, busy) ? <ChatPending /> : null}
            {status === "error" && error ? (
              <ChatError title="The Builder couldn't answer" onRetry={() => void regenerate()}>
                {error.message}
              </ChatError>
            ) : null}
          </>
        )}
      </ChatThread>
      <div className="px-3 pb-3">
        <ChatComposer
          size="sm"
          label="Message the Automation Builder"
          value={text}
          onValueChange={setText}
          onSubmit={submit}
          busy={busy}
          onStop={() => stop()}
          placeholder={
            canEdit ? "Describe the automation or a change…" : "Ask what this automation does…"
          }
          trailing={
            config && config.models.length > 0 ? (
              <ModelPicker
                size="sm"
                options={modelPickerOptions(config)}
                value={model}
                onValueChange={setModel}
                recommended={config.models.map((m) => m.id).slice(0, 4)}
              />
            ) : null
          }
        />
      </div>
    </>
  );
}
