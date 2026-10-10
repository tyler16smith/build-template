import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { AgentConnection } from "@template/api-client";
import {
  AI_LIMITS,
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  type AgentMessageMetadata,
  type AiConversation,
  type AssistantConfig,
  type AssistantPageHint,
  type ReasoningEffort,
} from "@template/contracts";
import {
  Alert,
  Button,
  ChatComposer,
  ChatComposerButton,
  ChatError,
  ChatPending,
  ChatThread,
  ChatWelcome,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  formatRelative,
  Kbd,
  LightboxImage,
  LoadingState,
  ModelPicker,
  SidePanel,
  Tooltip,
  type ChatSuggestion,
  type EffortControl,
  type ModelOption,
  type SidePanelLayout,
} from "@template/ui";
import { getToolName, type UIMessage } from "ai";
import {
  Asterisk,
  Cloud,
  Eraser,
  Paperclip,
  Sparkles,
  SquarePen,
  Trash2,
  UserRound,
  X,
  ChevronDown,
} from "lucide-react";
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useApi, useNav, useSession } from "../context";
import { AgentMessage, awaitingReply, type DescribeTool } from "./agent-message";
import { useAgentConnection } from "./use-agent";

type AssistantMessage = UIMessage<AgentMessageMetadata | undefined>;

/** What a screen says about itself (`useAssistantPageContext`). */
export type AssistantPageContext = {
  title: string;
  /** One line about what's on screen: "Your name, job title and sign-in methods". */
  summary?: string;
  /** The record in front of the person, if one is. */
  selection?: { type: string; id: string; name: string };
  /** Starter questions in an empty conversation, in place of the defaults. */
  suggestions?: string[];
};

type PageEntry = { id: symbol; priority: number; context: AssistantPageContext };

type AssistantState = {
  config: AssistantConfig | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  conversationId: string | null;
  setConversationId: (id: string) => void;
  conversations: AiConversation[];
  refreshConversations: () => void;
  deleteConversation: (id: string) => void;
  model: string;
  setModel: (model: string) => void;
  effort: ReasoningEffort;
  setEffort: (effort: ReasoningEffort) => void;
  newConversation: () => void;
  registerPage: (entry: PageEntry) => void;
  unregisterPage: (id: symbol) => void;
  /** The page hint sent with each turn: the highest-priority context. */
  currentPage: () => AssistantPageHint;
  pageSuggestions: () => string[] | null;
  /** Clears the open conversation; set by the chat while it's mounted. */
  clearRef: RefObject<(() => void) | null>;
};

const AssistantContext = createContext<AssistantState | null>(null);

function useAssistant(): AssistantState {
  const value = useContext(AssistantContext);
  if (!value) throw new Error("Assistant components must be used inside AssistantProvider");
  return value;
}

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

/**
 * The Assistant for the signed-in person (ported from Custombase's `assistant.tsx`): which
 * conversation is open, the model and effort, and what each screen says about itself. ⌘/Ctrl+J
 * opens and closes it.
 */
export function AssistantProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [config, setConfig] = useState<AssistantConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<ReasoningEffort>(DEFAULT_REASONING_EFFORT);
  const pages = useRef<PageEntry[]>([]);
  const clearRef = useRef<(() => void) | null>(null);
  const nav = useNav();
  const pathRef = useRef(nav.path);
  pathRef.current = nav.path;

  useEffect(() => {
    let live = true;
    api.assistant
      .config()
      .then((loaded) => {
        if (!live) return;
        setConfig(loaded);
        setModel((current) => current || loaded.defaultModel || loaded.models[0]?.id || "");
      })
      .catch(() => live && setConfig({ enabled: false, models: [], defaultModel: null }));
    return () => {
      live = false;
    };
  }, [api]);

  const refreshConversations = useCallback(() => {
    void api.assistant
      .conversations()
      .then(({ conversations: rows }) => {
        setConversations(rows);
        setConversationId((current) => current ?? rows[0]?.id ?? newId());
      })
      .catch(() => setConversationId((current) => current ?? newId()));
  }, [api]);

  useEffect(() => {
    if (config?.enabled && open && !conversationId) refreshConversations();
  }, [config?.enabled, open, conversationId, refreshConversations]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "j" || event.altKey || event.shiftKey) return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (!config?.enabled) return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [config?.enabled]);

  const registerPage = useCallback((entry: PageEntry) => {
    pages.current = [...pages.current.filter((item) => item.id !== entry.id), entry];
  }, []);
  const unregisterPage = useCallback((id: symbol) => {
    pages.current = pages.current.filter((item) => item.id !== id);
  }, []);
  const best = () =>
    pages.current.reduce<PageEntry | null>(
      (winner, entry) => (!winner || entry.priority >= winner.priority ? entry : winner),
      null,
    );
  const currentPage = useCallback((): AssistantPageHint => {
    const page = best()?.context;
    return {
      path: pathRef.current.split("?")[0]!.slice(0, 200),
      title: (page?.title ?? "").slice(0, 120),
      ...(page?.summary ? { summary: page.summary.slice(0, 400) } : {}),
      ...(page?.selection ? { selection: page.selection } : {}),
    };
  }, []);
  const pageSuggestions = useCallback(() => {
    const offering = pages.current.filter((entry) => entry.context.suggestions?.length);
    const winner = offering.reduce<PageEntry | null>(
      (top, entry) => (!top || entry.priority >= top.priority ? entry : top),
      null,
    );
    return winner?.context.suggestions?.slice(0, 4) ?? null;
  }, []);

  const newConversation = useCallback(() => {
    const id = newId();
    setConversationId(id);
    setConversations((rows) => [
      { id, title: null, updatedAt: new Date().toISOString() },
      ...rows.filter((row) => row.title),
    ]);
  }, []);

  const deleteConversation = useCallback(
    (id: string) => {
      void api.assistant.deleteConversation({ conversationId: id }).then(() => {
        setConversations((rows) => rows.filter((row) => row.id !== id));
        setConversationId((current) => (current === id ? newId() : current));
      });
    },
    [api],
  );

  const value: AssistantState = {
    config,
    open,
    setOpen,
    conversationId,
    setConversationId,
    conversations,
    refreshConversations,
    deleteConversation,
    model,
    setModel,
    effort,
    setEffort,
    newConversation,
    registerPage,
    unregisterPage,
    currentPage,
    pageSuggestions,
    clearRef,
  };
  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

/**
 * Describes the screen in front of the person, for the Assistant's prompt (as data, never as
 * instructions). Pass only what the screen shows. A page overrides the shell with a higher
 * priority.
 */
export function useAssistantPageContext(context: AssistantPageContext, priority = 1) {
  const assistant = useContext(AssistantContext);
  const id = useRef(Symbol());
  const key = JSON.stringify(context);
  useEffect(() => {
    if (!assistant) return;
    assistant.registerPage({
      id: id.current,
      priority,
      context: JSON.parse(key) as AssistantPageContext,
    });
    const own = id.current;
    return () => assistant.unregisterPage(own);
  }, [assistant?.registerPage, assistant?.unregisterPage, priority, key]);
}

const INTRO_KEY = "ask-ai-intro";

function introWanted(): boolean {
  try {
    return localStorage.getItem(INTRO_KEY) === null;
  } catch {
    return false;
  }
}

function rememberIntro() {
  try {
    localStorage.setItem(INTRO_KEY, "1");
  } catch {
    // Closing still hides it until the next visit.
  }
}

/** ⌘J or Ctrl+J, for the platform. */
function chord(): string {
  const apple =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
  return apple ? "⌘J" : "Ctrl+J";
}

/**
 * Ask AI, bottom right of every signed-in page: a round sparkles button. The first visit shows a
 * short closable intro beside it. Hidden while the panel is open.
 */
export function AskAiButton() {
  const assistant = useContext(AssistantContext);
  const [intro, setIntro] = useState(false);
  useEffect(() => {
    if (introWanted()) setIntro(true);
  }, []);
  if (!assistant?.config?.enabled || assistant.open) return null;
  const dismiss = () => {
    rememberIntro();
    setIntro(false);
  };
  const button = (
    <button
      type="button"
      onClick={() => {
        dismiss();
        assistant.setOpen(true);
      }}
      aria-label="Ask AI"
      aria-keyshortcuts="Meta+J Control+J"
      className="grid size-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-95 motion-reduce:transition-none"
    >
      <Sparkles aria-hidden className="size-5" />
    </button>
  );
  return (
    <div className="fixed right-5 bottom-5 z-30">
      {intro ? (
        <div className="absolute top-1/2 right-[calc(100%+0.75rem)] z-10 w-max max-w-[min(16rem,calc(100vw-6rem))] -translate-y-1/2 animate-ui-fade-in">
          <div className="relative rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-foreground shadow-lg">
            <div className="flex items-start gap-2">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 font-medium">
                  Ask AI <Kbd>{chord()}</Kbd>
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  Ask about your work, or ask it to do something for you.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={dismiss}
                className="-mt-0.5 -mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {intro ? (
        button
      ) : (
        <Tooltip content={`Ask AI (${chord()})`} side="left">
          {button}
        </Tooltip>
      )}
    </div>
  );
}

/** The panel: pushes the page aside on desktop, overlays it on narrow screens. */
export function AssistantSidebar() {
  const assistant = useContext(AssistantContext);
  if (!assistant?.config?.enabled) return null;
  return (
    <SidePanel
      open={assistant.open}
      onOpenChange={assistant.setOpen}
      title="Assistant"
      description="Answers from your data and acts for you, asking first before anything important."
      storageKey="assistant-panel-width"
    >
      {(layout) => (
        <>
          <AssistantHeader layout={layout} />
          {assistant.open ? <AssistantConversation /> : null}
        </>
      )}
    </SidePanel>
  );
}

function AssistantHeader({ layout }: { layout: SidePanelLayout }) {
  const {
    conversations,
    conversationId,
    setConversationId,
    newConversation,
    deleteConversation,
    setOpen,
    clearRef,
  } = useAssistant();
  const current = conversations.find((row) => row.id === conversationId);
  const recent = conversations.filter((row) => row.title);
  return (
    <div className="flex min-w-0 items-center gap-1 border-b border-border px-2 py-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0 shrink justify-start gap-1 overflow-hidden px-2 data-[state=open]:bg-muted"
          >
            <span className="truncate">{current?.title || "New AI chat"}</span>
            <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-96 w-72 overflow-y-auto rounded-xl p-1.5"
        >
          <DropdownMenuItem onSelect={newConversation} className="rounded-lg px-2.5 py-2">
            <SquarePen aria-hidden /> New AI chat
          </DropdownMenuItem>
          {recent.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Recent</DropdownMenuLabel>
              {recent.map((row) => (
                <DropdownMenuItem
                  key={row.id}
                  onSelect={() => setConversationId(row.id)}
                  className={cn(
                    "gap-3 rounded-lg px-2.5 py-2",
                    row.id === conversationId && "bg-muted/60",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{row.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelative(new Date(row.updatedAt))}
                  </span>
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => clearRef.current?.()}
            className="rounded-lg px-2.5 py-2"
          >
            <Eraser aria-hidden /> Clear this chat
          </DropdownMenuItem>
          {current?.title ? (
            <DropdownMenuItem
              onSelect={() => deleteConversation(current.id)}
              className="rounded-lg px-2.5 py-2"
            >
              <Trash2 aria-hidden /> Delete this chat
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="flex-1" />
      <div className="flex shrink-0 items-center">
        <Tooltip content="New AI chat">
          <Button variant="ghost" size="icon-sm" aria-label="New AI chat" onClick={newConversation}>
            <SquarePen />
          </Button>
        </Tooltip>
        {layout === "push" ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close Assistant"
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function AssistantConversation() {
  const { conversationId } = useAssistant();
  const agent = useAgentConnection("assistant", conversationId);
  if (!conversationId || !agent) return <LoadingState label="Opening the Assistant" />;
  // useAgentChat suspends while it loads the conversation's history: the boundary keeps that
  // inside the panel instead of the whole page.
  return (
    <Suspense key={conversationId} fallback={<LoadingState label="Opening the Assistant" />}>
      <AssistantChat agent={agent} />
    </Suspense>
  );
}

const DEFAULT_SUGGESTIONS: ChatSuggestion[] = [
  { label: "What's my job title?", icon: UserRound },
  { label: "What can you help me with here?", icon: Sparkles },
];

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** The composer's effort control, for a model that reasons (else nothing). */
export function effortControl(
  reasons: boolean,
  value: ReasoningEffort,
  onValueChange: (effort: ReasoningEffort) => void,
): EffortControl | undefined {
  if (!reasons) return undefined;
  return {
    value,
    options: REASONING_EFFORTS.map((id) => ({ id, label: EFFORT_LABELS[id] })),
    onValueChange: (id) => onValueChange(id as ReasoningEffort),
    recommended: DEFAULT_REASONING_EFFORT,
  };
}

/** The composer's model options: provider icon, "Default · Sees images". */
export function modelPickerOptions(config: AssistantConfig): ModelOption[] {
  return config.models.map((option) => {
    const Icon = option.id.startsWith("@cf/") ? Cloud : Asterisk;
    return {
      id: option.id,
      label: option.label,
      icon: <Icon />,
      description:
        [option.id === config.defaultModel ? "Default" : null, option.vision ? "Sees images" : null]
          .filter(Boolean)
          .join(" · ") || undefined,
    };
  });
}

function humanize(name: string): string {
  const words = name.replace(/[_.-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function UsageLabel({ usage }: { usage: NonNullable<AgentMessageMetadata["usage"]> }) {
  return (
    <span className="truncate px-1 text-[11px]">
      {usage.model.split("/").at(-1)} · {(usage.inputTokens + usage.outputTokens).toLocaleString()}{" "}
      tokens · ~${usage.estimatedCostUsd.toFixed(4)}
    </span>
  );
}

/** Tool names are action ids with dots as underscores: `profile_update` → "Profile update". */
const describeTool: DescribeTool = (part) => ({ title: humanize(getToolName(part)) });

function AssistantChat({ agent }: { agent: AgentConnection }) {
  const {
    config,
    model,
    setModel,
    effort,
    setEffort,
    refreshConversations,
    currentPage,
    pageSuggestions,
    clearRef,
  } = useAssistant();
  const { dataChanged } = useSession();
  const modelRef = useRef(model);
  modelRef.current = model;
  const effortRef = useRef(effort);
  effortRef.current = effort;
  const pageRef = useRef(currentPage);
  pageRef.current = currentPage;
  const {
    messages,
    sendMessage,
    regenerate,
    status,
    stop,
    addToolApprovalResponse,
    clearHistory,
    error,
  } = useAgentChat<unknown, AssistantMessage>({
    agent: agent as unknown as Parameters<typeof useAgentChat>[0]["agent"],
    body: () => ({ model: modelRef.current, effort: effortRef.current, page: pageRef.current() }),
  });
  clearRef.current = clearHistory;

  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const busy = status === "submitted" || status === "streaming";
  const wasBusy = useRef(false);
  const selected = config?.models.find((option) => option.id === model);
  const imagesBlocked = images.length > 0 && !selected?.vision;
  const canSend = (draft.trim().length > 0 || images.length > 0) && !imagesBlocked;
  const sentCount = messages.filter((message) => message.role === "user").length;

  // After a turn: the list of conversations, and the screens if a tool wrote data.
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    refreshConversations();
    if (messages.at(-1)?.metadata?.wrote) void dataChanged();
  }, [busy, messages, refreshConversations, dataChanged]);

  function submit() {
    const text = draft.trim();
    if (busy || imagesBlocked || (!text && images.length === 0)) return;
    const files = images.map((image) => ({
      type: "file" as const,
      mediaType: image.mediaType,
      filename: image.name,
      url: image.url,
    }));
    if (text && files.length > 0) void sendMessage({ text, files });
    else if (files.length > 0) void sendMessage({ files });
    else void sendMessage({ text });
    setDraft("");
    setImages([]);
    setAttachError(null);
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files];
    if (!files.some((file) => IMAGE_TYPES.has(file.type))) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    void addFiles(files);
  }

  async function addFiles(files: File[]) {
    const accepted = files.filter((file) => IMAGE_TYPES.has(file.type));
    const room = AI_LIMITS.maxImages - imagesRef.current.length;
    if (accepted.length !== files.length)
      setAttachError("Only PNG, JPEG, GIF and WebP images can be attached.");
    else if (accepted.length > room)
      setAttachError(`You can attach up to ${AI_LIMITS.maxImages} images.`);
    else setAttachError(null);
    const prepared: AttachedImage[] = [];
    for (const file of accepted.slice(0, Math.max(0, room))) {
      const image = await readAttachedImage(file).catch(() => null);
      if (image) prepared.push(image);
      else setAttachError("That image couldn't be attached.");
    }
    if (prepared.length)
      setImages((current) => [...current, ...prepared].slice(0, AI_LIMITS.maxImages));
  }

  function onPickFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length > 0) void addFiles(files);
  }

  const suggestions: ChatSuggestion[] = pageSuggestions() ?? DEFAULT_SUGGESTIONS;
  const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");

  return (
    <div className="flex min-h-0 flex-1 animate-ui-screen-in flex-col bg-surface">
      <ChatThread pinKey={sentCount} busy={busy} label="Conversation with the Assistant">
        {messages.length === 0 ? (
          <ChatWelcome
            title="How can I help?"
            description={`Ask about ${currentPage().title ? `“${currentPage().title}”` : "your work"}, or ask me to do something.`}
            suggestions={suggestions}
            onSuggestion={(text) => void sendMessage({ text })}
            footnote="The Assistant can only do what your role allows, and asks before changing anything important."
          />
        ) : (
          <>
            {messages.map((message, index) => (
              <AgentMessage
                key={message.id}
                message={message}
                streaming={busy && index === messages.length - 1}
                latest={index === lastAssistant}
                describeTool={describeTool}
                onApproval={(id, approved) => addToolApprovalResponse({ id, approved })}
                footer={
                  message.metadata?.usage ? <UsageLabel usage={message.metadata.usage} /> : null
                }
              />
            ))}
            {awaitingReply(messages, busy) ? <ChatPending /> : null}
            {status === "error" && error ? (
              <ChatError title="The Assistant couldn't answer" onRetry={() => void regenerate()}>
                {error.message}
              </ChatError>
            ) : null}
          </>
        )}
      </ChatThread>
      <div className="px-3 pb-3">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          tabIndex={-1}
          aria-hidden
          className="hidden"
          onChange={onPickFiles}
        />
        <ChatComposer
          ref={draftRef}
          size="sm"
          autoFocus
          label="Message the Assistant"
          value={draft}
          onValueChange={setDraft}
          onSubmit={submit}
          onPaste={onPaste}
          placeholder="Ask about your work…"
          busy={busy}
          onStop={() => stop()}
          canSubmit={canSend}
          top={
            images.length > 0 ? (
              <ul aria-label="Attached files" className="flex flex-wrap gap-2 px-2 pt-2">
                {images.map((image) => (
                  <li
                    key={image.id}
                    className="flex max-w-56 animate-ui-fade-in items-center gap-2 rounded-lg border border-border bg-surface py-1 pr-1 pl-1 text-xs"
                  >
                    <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-md bg-muted">
                      <LightboxImage
                        src={image.url}
                        alt={image.name}
                        loading="eager"
                        className="size-full overflow-hidden rounded-md"
                        imgClassName="size-full object-cover"
                      />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{image.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${image.name}`}
                      onClick={() => {
                        setImages((current) => current.filter((item) => item.id !== image.id));
                        setAttachError(null);
                      }}
                      className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <X aria-hidden className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null
          }
          notice={
            attachError || imagesBlocked ? (
              <div className="grid gap-2 px-2 pb-1">
                {attachError ? <Alert tone="warning" title={attachError} /> : null}
                {imagesBlocked ? (
                  <Alert tone="warning" title="This model can't see images">
                    Pick one that can, or remove them.
                  </Alert>
                ) : null}
              </div>
            ) : null
          }
          leading={
            <ChatComposerButton
              size="sm"
              title="Attach images"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip aria-hidden /> Attach
            </ChatComposerButton>
          }
          trailing={
            config && config.models.length > 0 ? (
              <ModelPicker
                size="sm"
                options={modelPickerOptions(config)}
                value={model}
                onValueChange={(id) => {
                  setModel(id);
                  draftRef.current?.focus();
                }}
                recommended={config.models.map((m) => m.id).slice(0, 4)}
                effort={effortControl(Boolean(selected?.reasoning), effort, (next) => {
                  setEffort(next);
                  draftRef.current?.focus();
                })}
              />
            ) : null
          }
        />
      </div>
    </div>
  );
}

const MAX_IMAGE_EDGE = 1568;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type AttachedImage = { id: string; mediaType: string; name: string; url: string };

/** A pasted or picked image, scaled to at most 1568px a side, as a data URL. */
async function readAttachedImage(file: File): Promise<AttachedImage | null> {
  if (!IMAGE_TYPES.has(file.type)) return null;
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const mediaType =
      file.type === "image/jpeg"
        ? "image/jpeg"
        : file.type === "image/webp"
          ? "image/webp"
          : "image/png";
    return {
      id: crypto.randomUUID(),
      mediaType,
      name: file.name || "image",
      url: canvas.toDataURL(mediaType, 0.85),
    };
  } finally {
    bitmap.close();
  }
}
