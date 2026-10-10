import {
  emptyDefinition,
  type AutomationCatalog,
  type AutomationTrigger,
  type CatalogTrigger,
} from "@template/contracts";
import { Button, ChatComposer, PermissionState, Skeleton, toast } from "@template/ui";
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  PencilRuler,
  Sparkles,
  Webhook,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useAssistantPageContext } from "../assistant/assistant";
import { errorMessage, useApi, useCan, useNav } from "../context";
import { browserTimeZone } from "./step-editor";
import { useLoad } from "../use-load";

type EventTrigger = Extract<CatalogTrigger, { kind: "app.event" }>;

function eventName(event: EventTrigger): string {
  return event.title.replace(/^When:\s*/, "");
}

/** Ideas grounded in the events this organization's actions emit, then a few that work anywhere. */
export function startSuggestions(catalog: AutomationCatalog | null): string[] {
  const events = (catalog?.triggers ?? []).filter((t): t is EventTrigger => t.kind === "app.event");
  const patterns = [
    (e: EventTrigger) => `When “${eventName(e)}” happens, email the owners`,
    (e: EventTrigger) => `When “${eventName(e)}” happens, have AI summarize it and email me`,
    (e: EventTrigger) => `When “${eventName(e)}” happens, wait 3 days, then send a reminder`,
  ];
  const fromEvents = events.slice(0, 3).map((event, index) => patterns[index]!(event));
  const zapier = catalog?.triggers.some((t) => t.kind === "zapier.event")
    ? ["When a deal closes in HubSpot (through Zapier), email the team"]
    : [];
  return [
    ...fromEvents,
    "Every Monday at 9am, email me a summary of last week",
    ...zapier,
    "When a webhook arrives, have AI sort it and email the right person",
  ].slice(0, 5);
}

export type StartOptions = { prompt?: string; trigger?: AutomationTrigger };

/**
 * `/automations/new`: describe the automation in one message and the Builder drafts it, or start
 * blank or from a trigger. Nothing is created until one is chosen.
 */
export function AutomationStartScreen() {
  const api = useApi();
  const nav = useNav();
  const canManage = useCan("automations.manage");
  const catalog = useLoad(canManage ? () => api.automations.catalog() : null, "catalog");
  const [busy, setBusy] = useState<string | null>(null);
  useAssistantPageContext({
    title: "New automation",
    summary: "Describe what should happen and when; the Automation Builder drafts it",
  });

  if (!canManage)
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <h1 className="sr-only">New automation</h1>
        <PermissionState description="Only owners and admins can set up automations." />
      </div>
    );

  /** Creates a draft (optionally with a trigger) and opens it. */
  const create = async (key: string, options: StartOptions) => {
    if (busy) return;
    setBusy(key);
    try {
      const { id, draftRevision } = await api.automations.create({
        name: "Untitled automation",
      });
      if (options.trigger)
        await api.automations.saveDraft({
          automationId: id,
          baseRevision: draftRevision,
          definition: { ...emptyDefinition(), trigger: options.trigger },
          summary: "Chose what starts it",
        });
      // With a description the Builder drafts it; otherwise the trigger opens for editing.
      const query = options.prompt
        ? `?prompt=${encodeURIComponent(options.prompt)}`
        : "?select=trigger";
      nav.navigate(`/automations/${id}${query}`);
    } catch (failure) {
      toast("Couldn't start the automation", {
        description: errorMessage(failure),
        tone: "danger",
      });
      setBusy(null);
    }
  };

  return (
    <AutomationStartView
      catalog={catalog.data}
      loading={catalog.loading}
      busy={busy}
      onCreate={(key, options) => void create(key, options)}
      onBack={() => nav.navigate("/automations")}
    />
  );
}

/** The start screen itself, without data loading, so it can be rendered and tested on its own. */
export function AutomationStartView({
  catalog,
  loading,
  busy,
  onCreate,
  onBack,
}: {
  catalog: AutomationCatalog | null;
  loading: boolean;
  busy: string | null;
  onCreate: (key: string, options: StartOptions) => void;
  onBack: () => void;
}) {
  const [text, setText] = useState("");
  const suggestions = useMemo(() => startSuggestions(catalog), [catalog]);
  const events = (catalog?.triggers ?? []).filter((t): t is EventTrigger => t.kind === "app.event");
  const submit = () => {
    const prompt = text.trim();
    if (prompt) onCreate("prompt", { prompt });
  };

  return (
    <div className="mx-auto grid w-full max-w-2xl content-start gap-8 px-4 pt-6 pb-10 sm:px-6 lg:pt-[10vh]">
      <Button variant="link" size="sm" className="justify-self-start px-0" onClick={onBack}>
        <ArrowLeft /> Automations
      </Button>
      <div className="grid justify-items-center gap-3 text-center">
        <span className="grid size-11 place-items-center rounded-full bg-primary/10 text-primary">
          <Sparkles aria-hidden className="size-5" />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">Describe what should happen</h1>
        <p className="max-w-lg text-sm text-muted-foreground">
          In your own words, with when it should happen. The Builder picks the trigger and steps,
          asks only what it needs, and drafts the workflow for you to review.
        </p>
      </div>
      <ChatComposer
        label="Describe what should happen"
        value={text}
        onValueChange={setText}
        onSubmit={submit}
        submitting={busy === "prompt"}
        disabled={busy !== null}
        autoFocus
        placeholder="When a profile is updated, email the owners and send the change to Google Sheets…"
      />
      <div className="grid gap-2">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Try</p>
        {loading ? (
          <Skeleton className="h-16" />
        ) : (
          <ul aria-label="Suggestions" className="flex flex-wrap gap-2">
            {suggestions.map((suggestion) => (
              <li key={suggestion}>
                <button
                  type="button"
                  onClick={() => setText(suggestion)}
                  className="rounded-full border border-border bg-surface px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button
          variant="outline"
          loading={busy === "blank"}
          disabled={busy !== null && busy !== "blank"}
          onClick={() => onCreate("blank", {})}
        >
          <PencilRuler /> Start from a blank automation
        </Button>
        <Button
          variant="ghost"
          loading={busy === "schedule"}
          disabled={busy !== null && busy !== "schedule"}
          onClick={() =>
            onCreate("schedule", {
              trigger: {
                kind: "schedule",
                frequency: "daily",
                time: "09:00",
                minute: 0,
                weekdays: [1],
                dayOfMonth: 1,
                timezone: browserTimeZone(),
              },
            })
          }
        >
          <CalendarClock /> On a schedule
        </Button>
        <Button
          variant="ghost"
          loading={busy === "webhook"}
          disabled={busy !== null && busy !== "webhook"}
          onClick={() => onCreate("webhook", { trigger: { kind: "webhook", fields: [] } })}
        >
          <Webhook /> From a webhook
        </Button>
        <Button
          variant="ghost"
          loading={busy === "zapier"}
          disabled={busy !== null && busy !== "zapier"}
          onClick={() =>
            onCreate("zapier", {
              trigger: {
                kind: "zapier.event",
                connectionId: null,
                provider: "",
                eventType: "",
                when: [],
              },
            })
          }
        >
          <Zap /> From Zapier
        </Button>
      </div>
      {events.length ? (
        <section aria-labelledby="start-from-event" className="grid gap-2">
          <h2
            id="start-from-event"
            className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
          >
            Or start from something that happens here
          </h2>
          <ul className="grid gap-1 sm:grid-cols-2">
            {events.slice(0, 10).map((event) => (
              <li key={event.eventId}>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    onCreate(event.eventId, {
                      trigger: { kind: "app.event", eventId: event.eventId, when: [] },
                    })
                  }
                  className="group flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
                >
                  <Zap aria-hidden className="size-4 shrink-0 text-primary" />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate font-medium">{eventName(event)}</span>
                    <span className="truncate text-xs text-muted-foreground">{event.eventId}</span>
                  </span>
                  <ArrowRight
                    aria-hidden
                    className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100"
                  />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
