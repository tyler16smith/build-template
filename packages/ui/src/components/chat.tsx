import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  MessageSquare,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  type LucideIcon,
} from "lucide-react";
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ClipboardEventHandler,
  type ReactNode,
} from "react";
import { formatElapsed } from "../lib/chat";
import { cn } from "../lib/cn";
import { Button } from "./button";
import { Markdown } from "./markdown";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./overlay";
import { Spinner } from "./spinner";

/** Dispatched (bubbling) by content that grows because the person opened it. */
const CHAT_HOLD_EVENT = "ui-chat-hold";

// Layout effects warn during server rendering; the thread only needs them in a browser.
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Text in its loading state: muted, with a lighter band sweeping left to right. */
export function ShimmerText({
  children,
  active = true,
  className,
}: {
  children: ReactNode;
  /** When false the text is plain muted text, so callers can toggle without remounting. */
  active?: boolean;
  className?: string;
}) {
  return (
    <span className={cn(active ? "ui-shimmer" : "text-muted-foreground", className)}>
      {children}
    </span>
  );
}

/**
 * The scrolling column of a conversation. It follows new content while the person is at the
 * bottom, stays put when they scroll up to read, and offers a way back down.
 */
export function ChatThread({
  children,
  className,
  contentClassName,
  pinKey,
  label = "Conversation",
  busy,
}: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  /** Changing it (a message was sent) scrolls to the bottom and follows again. */
  pinKey?: unknown;
  label?: string;
  busy?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);

  useBrowserLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const follow = () => {
      if (pinned.current) scroller.scrollTop = scroller.scrollHeight;
    };
    follow();
    // Opening steps grows the thread under the person's pointer; following would scroll what
    // they just opened out of view. Stop following, then check again once it has settled.
    let settle: number | undefined;
    const hold = () => {
      pinned.current = false;
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        pinned.current = gap < 64;
        setAway(gap >= 64);
      }, 400);
    };
    scroller.addEventListener(CHAT_HOLD_EVENT, hold);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);
    observer?.observe(content);
    return () => {
      observer?.disconnect();
      scroller.removeEventListener(CHAT_HOLD_EVENT, hold);
      window.clearTimeout(settle);
    };
  }, []);

  useBrowserLayoutEffect(() => {
    pinned.current = true;
    setAway(false);
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [pinKey]);

  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col", className)}>
      <div
        ref={scrollRef}
        role="log"
        aria-label={label}
        aria-busy={busy || undefined}
        onScroll={(event) => {
          const el = event.currentTarget;
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
          pinned.current = gap < 64;
          setAway(gap >= 64);
        }}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div
          ref={contentRef}
          className={cn("mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5", contentClassName)}
        >
          {children}
        </div>
      </div>
      {away ? (
        <button
          type="button"
          aria-label="Jump to latest"
          onClick={() => {
            pinned.current = true;
            setAway(false);
            scrollRef.current?.scrollTo({
              top: scrollRef.current.scrollHeight,
              behavior: "smooth",
            });
          }}
          className="absolute bottom-3 left-1/2 grid size-8 -translate-x-1/2 animate-ui-fade-in place-items-center rounded-full border border-border bg-surface-raised text-muted-foreground shadow-lg transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ArrowDown aria-hidden className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * One message. The person's messages sit on the right; replies are full-width text with an
 * actions row (copy, model and cost) that shows on hover, or always when `persistentActions`.
 */
export function ChatMessage({
  role,
  children,
  actions,
  persistentActions,
  className,
}: {
  role: "user" | "assistant";
  children: ReactNode;
  actions?: ReactNode;
  persistentActions?: boolean;
  className?: string;
}) {
  if (role === "user")
    return (
      <div className={cn("flex animate-ui-message-in flex-col items-end gap-1.5", className)}>
        {children}
      </div>
    );
  return (
    <div
      className={cn("group/message flex min-w-0 animate-ui-message-in flex-col gap-3", className)}
    >
      {children}
      {actions ? (
        <div
          className={cn(
            "-ml-1.5 -mt-1 flex min-h-7 items-center gap-1 text-xs text-muted-foreground transition-opacity duration-200",
            persistentActions
              ? "opacity-100"
              : "opacity-0 focus-within:opacity-100 group-hover/message:opacity-100 [@media(hover:none)]:opacity-100",
          )}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/** The person's words, in a soft bubble. */
export function ChatBubble({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "max-w-[85%] whitespace-pre-wrap rounded-2xl bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A reply's text, set for reading in a chat. */
export function ChatText({ source, className }: { source: string; className?: string }) {
  return (
    <Markdown source={source} className={cn("text-sm leading-[1.65] text-foreground", className)} />
  );
}

export type ChatStepState = "active" | "done" | "error";

export type ChatStep = {
  id: string;
  /** One to five words about what is happening: "Searching your boards". */
  cover: string;
  /** Shown when the steps are opened: reasoning, inputs, results, errors. */
  detail?: ReactNode;
  state: ChatStepState;
};

function StepDot({ state }: { state: ChatStepState }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -left-[21px] top-[7px] size-[9px] rounded-full ring-[3px] ring-surface",
        state === "active" && "animate-ui-dot-pulse bg-primary",
        state === "done" && "bg-border-strong",
        state === "error" && "bg-danger",
      )}
    />
  );
}

const compactTokens = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Seconds since `startedAt`, ticking once a second while mounted. */
function useElapsed(startedAt: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === undefined ? undefined : Math.max(0, now - startedAt);
}

/**
 * What the AI is doing, as one quiet line. While `active` it shows a spinner, the current step's
 * cover in shimmering text and, when given, how long it has run since `startedAt` and the
 * `tokens` it has produced; afterwards it settles to `summary` ("Thought for 6s"). The chevron
 * opens every step on a timeline, with its detail.
 */
export function ChatSteps({
  steps,
  active,
  summary,
  startedAt,
  tokens,
  defaultOpen = false,
  className,
}: {
  steps: ChatStep[];
  active: boolean;
  summary?: string;
  /** When the work began (epoch ms), for the running timer. */
  startedAt?: number;
  /** Output tokens produced so far. */
  tokens?: number;
  defaultOpen?: boolean;
  className?: string;
}) {
  const elapsed = useElapsed(active ? startedAt : undefined);
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const current = active
    ? ([...steps].reverse().find((step) => step.state === "active") ?? steps.at(-1))
    : undefined;
  const failed = steps.find((step) => step.state === "error");
  const label = active
    ? (current?.cover ?? "Thinking")
    : (summary ?? (steps.length === 1 ? steps[0]!.cover : `${steps.length} steps`));
  const expandable = steps.length > 1 || steps.some((step) => step.detail);

  const meta = active
    ? [
        elapsed !== undefined ? formatElapsed(elapsed) : null,
        tokens ? `${compactTokens.format(tokens).toLowerCase()} tokens` : null,
      ].filter(Boolean)
    : [];

  const heading = (
    <>
      {active ? <Spinner label="" className="size-3 text-primary" /> : null}
      {failed && !active ? (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-danger" />
      ) : null}
      <span className="min-w-0 truncate" aria-live="polite">
        <span
          key={label}
          className="inline-block max-w-full truncate align-bottom animate-ui-cover-in"
        >
          <ShimmerText active={active}>{label}</ShimmerText>
        </span>
        {failed && !active ? <span className="sr-only"> (a step failed)</span> : null}
      </span>
      {meta.length ? (
        <span className="shrink-0 tabular-nums text-xs text-muted-foreground/80">
          · {meta.join(" · ")}
        </span>
      ) : null}
    </>
  );

  return (
    <div className={cn("min-w-0", className)}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={(event) => {
            event.currentTarget.dispatchEvent(new Event(CHAT_HOLD_EVENT, { bubbles: true }));
            setOpen((value) => !value);
          }}
          className="-mx-1 flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {heading}
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 transition-transform duration-200",
              open && "rotate-90",
            )}
          />
        </button>
      ) : (
        <p className="flex max-w-full items-center gap-1.5 py-0.5 text-sm text-muted-foreground">
          {heading}
        </p>
      )}
      {expandable ? (
        <div
          id={bodyId}
          inert={open ? undefined : true}
          style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
            open ? "opacity-100" : "opacity-0",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <ol className="relative ml-[5px] mt-2 space-y-3 border-l border-border pb-1 pl-4">
              {steps.map((step) => (
                <li key={step.id} className="relative animate-ui-fade-in">
                  <StepDot state={step.state} />
                  <p
                    className={cn(
                      "text-sm",
                      step.state === "error" ? "text-danger" : "text-foreground/85",
                    )}
                  >
                    {step.state === "active" ? <ShimmerText>{step.cover}</ShimmerText> : step.cover}
                  </p>
                  {step.detail ? (
                    <div className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                      {step.detail}
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The line shown before the first word of a reply arrives. */
export function ChatPending({ label = "Thinking" }: { label?: string }) {
  return (
    <div className="animate-ui-message-in">
      <ChatSteps steps={[{ id: "pending", cover: label, state: "active" }]} active />
    </div>
  );
}

export type ChatSuggestion = string | { label: string; icon?: LucideIcon; value?: string };

/** The start of a new conversation: a greeting and a few things to try. */
export function ChatWelcome({
  icon: Icon = Sparkles,
  title = "How can I help?",
  description,
  suggestions = [],
  onSuggestion,
  footnote,
  className,
}: {
  icon?: LucideIcon;
  title?: ReactNode;
  description?: ReactNode;
  suggestions?: ChatSuggestion[];
  onSuggestion?: (value: string) => void;
  footnote?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex animate-ui-screen-in flex-col gap-6 pt-4", className)}>
      <div className="grid gap-3">
        <span className="grid size-10 place-items-center rounded-full bg-primary/10 text-primary">
          <Icon aria-hidden className="size-5" />
        </span>
        <div className="grid gap-1">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {suggestions.length ? (
        <ul aria-label="Suggestions" className="-mx-2 grid gap-0.5">
          {suggestions.map((suggestion, index) => {
            const item = typeof suggestion === "string" ? { label: suggestion } : suggestion;
            const ItemIcon = item.icon ?? MessageSquare;
            return (
              <li
                key={item.label}
                className="animate-ui-rise"
                style={{ animationDelay: `${90 + index * 45}ms` }}
              >
                <button
                  type="button"
                  onClick={() => onSuggestion?.(item.value ?? item.label)}
                  className="group/suggestion flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <ItemIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">{item.label}</span>
                  <ArrowRight
                    aria-hidden
                    className="size-3.5 shrink-0 -translate-x-1 text-muted-foreground opacity-0 transition duration-200 group-hover/suggestion:translate-x-0 group-hover/suggestion:opacity-100 group-focus-visible/suggestion:opacity-100"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {footnote ? (
        <p
          className="animate-ui-rise text-xs leading-relaxed text-muted-foreground"
          style={{ animationDelay: `${120 + suggestions.length * 45}ms` }}
        >
          {footnote}
        </p>
      ) : null}
    </div>
  );
}

/** A round toolbar button for the composer: attach, pick an element, and the like. */
export const ChatComposerButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { size?: "md" | "sm" }
>(({ className, type, size = "md", ...props }, ref) => (
  <button
    ref={ref}
    type={type ?? "button"}
    className={cn(
      "inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-primary/10 aria-pressed:text-primary data-[state=open]:bg-muted [&_svg]:shrink-0",
      size === "sm"
        ? "h-7 min-w-7 gap-1 px-1.5 text-xs [&_svg]:size-3.5"
        : "h-8 min-w-8 gap-1.5 px-2 text-[13px] [&_svg]:size-4",
      className,
    )}
    {...props}
  />
));
ChatComposerButton.displayName = "ChatComposerButton";

export type ChatComposerProps = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  /** An accessible name for the text box: "Message the Assistant". */
  label: string;
  placeholder?: string;
  /** A reply is streaming: the send button becomes stop. */
  busy?: boolean;
  onStop?: () => void;
  /** Whether sending is allowed now (text or attachments, nothing blocking). */
  canSubmit?: boolean;
  /** The message is being sent (a request, not a stream): the send button shows a spinner. */
  submitting?: boolean;
  disabled?: boolean;
  /** Toolbar controls on the left, such as attach. */
  leading?: ReactNode;
  /** Toolbar controls on the right, before send, such as the model picker. */
  trailing?: ReactNode;
  /** Above the text: attachments, a picked element. */
  top?: ReactNode;
  /** Between the text and the toolbar: warnings about what's attached. */
  notice?: ReactNode;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  maxLength?: number;
  autoFocus?: boolean;
  /** `sm` fits a narrow panel: slightly smaller type, field, and send button. */
  size?: "md" | "sm";
  className?: string;
};

/**
 * The message box: a rounded card with a text box that grows as you type, and a toolbar with
 * `leading` controls on the left and `trailing` controls, then send, on the right. Enter sends;
 * Shift+Enter adds a line.
 */
export const ChatComposer = forwardRef<HTMLTextAreaElement, ChatComposerProps>(
  (
    {
      value,
      onValueChange,
      onSubmit,
      label,
      placeholder,
      busy,
      onStop,
      canSubmit = value.trim().length > 0,
      submitting,
      disabled,
      leading,
      trailing,
      top,
      notice,
      onPaste,
      maxLength,
      autoFocus,
      size = "md",
      className,
    },
    ref,
  ) => {
    const textRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => textRef.current!, []);
    const ready = canSubmit && !busy && !submitting && !disabled;

    useBrowserLayoutEffect(() => {
      const field = textRef.current;
      if (!field) return;
      field.style.height = "auto";
      field.style.height = `${Math.min(field.scrollHeight, 208)}px`;
    }, [value]);

    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onSubmit();
        }}
        className={cn(
          "min-w-0 rounded-2xl border border-border bg-surface shadow-sm transition-[border-color,box-shadow] duration-200 focus-within:border-border-strong/70 focus-within:shadow-lg",
          className,
        )}
      >
        {top}
        <textarea
          ref={textRef}
          aria-label={label}
          value={value}
          rows={1}
          maxLength={maxLength}
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => onValueChange(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (ready) onSubmit();
          }}
          className={cn(
            "block max-h-52 w-full resize-none bg-transparent leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-60",
            size === "sm"
              ? "min-h-14 px-3 pb-4 pt-3 text-[15px]"
              : "min-h-11 px-3.5 pb-1 pt-3 text-sm",
          )}
        />
        {notice}
        <div
          className={cn(
            "flex items-center",
            size === "sm" ? "gap-0.5 px-1.5 pb-1.5 pt-0.5" : "gap-1 px-2 pb-2 pt-1",
          )}
        >
          <div className="flex min-w-0 items-center gap-0.5">{leading}</div>
          <div className="flex-1" />
          <div className="flex min-w-0 items-center gap-1">{trailing}</div>
          {busy && onStop ? (
            <button
              type="button"
              aria-label="Stop"
              onClick={onStop}
              className={cn(
                "grid shrink-0 animate-ui-fade-in place-items-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                size === "sm" ? "size-7" : "size-8",
              )}
            >
              <Square
                aria-hidden
                className={cn("fill-current", size === "sm" ? "size-2.5" : "size-3")}
              />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              disabled={!ready}
              className={cn(
                "grid shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:bg-muted disabled:text-muted-foreground/70",
                size === "sm" ? "size-7" : "size-8",
              )}
            >
              {submitting ? (
                <Spinner
                  className={cn("text-current", size === "sm" ? "size-3.5" : "size-4")}
                  label="Sending"
                />
              ) : (
                <ArrowUp
                  aria-hidden
                  className={size === "sm" ? "size-3.5" : "size-4"}
                  strokeWidth={2.25}
                />
              )}
            </button>
          )}
        </div>
      </form>
    );
  },
);
ChatComposer.displayName = "ChatComposer";

export type ModelOption = {
  id: string;
  label: string;
  /** A second line: "Default · Sees images". */
  description?: string;
  icon?: ReactNode;
};

/** "GLM 5.3 Flash" → ["GLM", "5.3 Flash"]: the family in weight, the version muted. */
export function splitModelLabel(label: string): [string, string] {
  const [family = "", ...rest] = label.trim().split(/\s+/);
  return [family, rest.join(" ")];
}

/**
 * How hard the model thinks, shown beside it in the picker. `options` run from fastest to
 * smartest; `recommended` is marked under the slider.
 */
export type EffortControl = {
  value: string;
  options: { id: string; label: string }[];
  onValueChange: (id: string) => void;
  recommended?: string;
};

/**
 * The composer's model menu: a quiet chip showing the current model (and effort, when given) with
 * a chevron, opening a menu with the recommended models first, any others in a submenu, and an
 * effort slider at the bottom.
 */
export function ModelPicker({
  options,
  value,
  onValueChange,
  recommended,
  effort,
  size = "md",
  className,
}: {
  options: ModelOption[];
  value: string;
  onValueChange: (id: string) => void;
  /** Ids to list first. Defaults to the first four options. */
  recommended?: string[];
  effort?: EffortControl;
  /** `sm` fits a narrow panel: slightly smaller type and chip. */
  size?: "md" | "sm";
  className?: string;
}) {
  const selected = options.find((option) => option.id === value) ?? options[0];
  if (!selected) return null;
  const top = recommended
    ? options.filter((option) => recommended.includes(option.id))
    : options.slice(0, 4);
  const others = options.filter((option) => !top.includes(option));
  const flat = others.length <= 1;
  const effortLabel = effort?.options.find((option) => option.id === effort.value)?.label;

  const row = (option: ModelOption) => {
    const [family, variant] = splitModelLabel(option.label);
    return (
      <DropdownMenuItem
        key={option.id}
        onSelect={() => onValueChange(option.id)}
        className="items-start gap-2.5 rounded-lg px-2.5 py-2"
      >
        <span aria-hidden className="mt-0.5 grid size-4 shrink-0 place-items-center">
          {option.icon ?? <Sparkles />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            <span className="font-medium text-foreground">{family}</span>
            {variant ? <span className="text-muted-foreground"> {variant}</span> : null}
          </span>
          {option.description ? (
            <span className="block truncate text-xs text-muted-foreground">
              {option.description}
            </span>
          ) : null}
        </span>
        {option.id === selected.id ? (
          <Check aria-label="Selected" className="mt-0.5 shrink-0 !text-foreground" />
        ) : null}
      </DropdownMenuItem>
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Model: ${selected.label}${effortLabel ? `, ${effortLabel} effort` : ""}`}
          className={cn(
            "group inline-flex min-w-0 max-w-[16rem] items-center rounded-full bg-transparent font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-muted data-[state=open]:text-foreground",
            size === "sm" ? "h-7 gap-1 pl-2 pr-1.5 text-xs" : "h-8 gap-1.5 pl-3 pr-2 text-[13px]",
            className,
          )}
        >
          <span className="truncate">{selected.label}</span>
          {effortLabel ? (
            <span className="shrink-0 font-normal text-muted-foreground">{effortLabel}</span>
          ) : null}
          <ChevronDown
            aria-hidden
            className={cn(
              "shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180",
              size === "sm" ? "size-3" : "size-3.5",
            )}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        className="w-72 rounded-xl p-1.5"
      >
        {flat ? (
          options.map(row)
        ) : (
          <>
            <DropdownMenuLabel>Recommended</DropdownMenuLabel>
            {top.map(row)}
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="rounded-lg px-2.5 py-2">
                <span className="flex-1">Other models</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                sideOffset={6}
                className="max-h-80 w-64 overflow-y-auto rounded-xl p-1.5"
              >
                {others.map(row)}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
        {effort && effort.options.length > 1 ? (
          <>
            <DropdownMenuSeparator />
            <EffortSlider effort={effort} />
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Inset of the first and last stops from the ends of the track, in px. */
const EFFORT_TRACK_INSET = 16;

function effortStop(index: number, count: number): string {
  const fraction = count > 1 ? index / (count - 1) : 0;
  return `calc(${EFFORT_TRACK_INSET}px + (100% - ${EFFORT_TRACK_INSET * 2}px) * ${fraction})`;
}

/**
 * Faster ↔ Smarter, one stop per option. Drag or click the track, or use the arrow keys; it keeps
 * its keys from the surrounding menu, which would otherwise move between items.
 */
function EffortSlider({ effort }: { effort: EffortControl }) {
  const labelId = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const count = effort.options.length;
  const index = Math.max(
    0,
    effort.options.findIndex((option) => option.id === effort.value),
  );
  const recommendedIndex = effort.recommended
    ? effort.options.findIndex((option) => option.id === effort.recommended)
    : -1;
  const current = effort.options[index]!;

  const choose = (next: number) => {
    const option = effort.options[Math.min(count - 1, Math.max(0, next))];
    if (option && option.id !== effort.value) effort.onValueChange(option.id);
  };
  const fromPointer = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const usable = rect.width - EFFORT_TRACK_INSET * 2;
    const fraction = usable > 0 ? (clientX - rect.left - EFFORT_TRACK_INSET) / usable : 0;
    choose(Math.round(fraction * (count - 1)));
  };

  return (
    <div className="grid gap-2 px-2.5 pb-1.5 pt-2">
      <div className="flex items-baseline gap-2 text-sm">
        <span id={labelId} className="text-muted-foreground">
          Effort
        </span>
        <span className="font-medium text-foreground">{current.label}</span>
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Faster</span>
        <span>Smarter</span>
      </div>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={index}
        aria-valuetext={current.label}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          fromPointer(event.clientX);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(event.clientX);
        }}
        onKeyDown={(event) => {
          const moves: Record<string, number> = {
            ArrowLeft: index - 1,
            ArrowDown: index - 1,
            ArrowRight: index + 1,
            ArrowUp: index + 1,
            Home: 0,
            End: count - 1,
          };
          const next = moves[event.key];
          if (next === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          choose(next);
        }}
        className="relative h-8 cursor-pointer touch-none select-none rounded-full bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-transparent to-foreground/15 transition-[width] duration-150"
          style={{ width: effortStop(index, count) }}
        />
        {effort.options.map((option, stop) => (
          <span
            key={option.id}
            aria-hidden
            className="absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/50"
            style={{ left: effortStop(stop, count) }}
          />
        ))}
        <span
          aria-hidden
          className="absolute top-1/2 h-6 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-sm transition-[left] duration-150"
          style={{ left: effortStop(index, count) }}
        />
      </div>
      <div className="relative h-4 text-xs text-muted-foreground">
        {recommendedIndex >= 0 ? (
          <span
            className="absolute -translate-x-1/2 whitespace-nowrap"
            style={{
              left: effortStop(recommendedIndex, count),
              // Keep the end labels inside the menu.
              transform:
                recommendedIndex === 0
                  ? "translateX(-16px)"
                  : recommendedIndex === count - 1
                    ? "translateX(calc(-100% + 16px))"
                    : undefined,
            }}
          >
            Recommended
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The AI wants to do something consequential and asks first. */
export function ChatApproval({
  title,
  children,
  onApprove,
  onDecline,
  approveLabel = "Approve",
  declineLabel = "Don't do it",
}: {
  title: string;
  children?: ReactNode;
  onApprove: () => void;
  onDecline: () => void;
  approveLabel?: string;
  declineLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={`Confirm ${title}`}
      className="animate-ui-message-in rounded-xl border border-border bg-surface p-3.5 shadow-sm"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-warning-soft text-warning">
          <ShieldCheck aria-hidden className="size-3.5" />
        </span>
        <span className="min-w-0">Confirm: {title}</span>
      </p>
      {children ? (
        <div className="mt-2.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-sunken p-2.5 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {children}
        </div>
      ) : null}
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={onApprove}>
          {approveLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDecline}>
          {declineLabel}
        </Button>
      </div>
    </div>
  );
}

/** A reply that failed, inline in the conversation. */
export function ChatError({
  title,
  children,
  onRetry,
}: {
  title: string;
  children?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex animate-ui-message-in items-start gap-2.5 rounded-xl border border-danger/25 bg-danger-soft/40 px-3.5 py-2.5 text-sm"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{title}</p>
        {children ? (
          <div className="text-muted-foreground [overflow-wrap:anywhere]">{children}</div>
        ) : null}
      </div>
      {onRetry ? (
        <Button size="sm" variant="ghost" onClick={onRetry} className="-my-1 shrink-0">
          <RotateCcw aria-hidden /> Retry
        </Button>
      ) : null}
    </div>
  );
}
