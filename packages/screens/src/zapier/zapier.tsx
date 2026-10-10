import {
  ZAPIER_BODY_EXAMPLE,
  ZAPIER_LIMITS,
  ZAPIER_SAMPLE_EVENT,
  ZAPIER_SECRET_HEADER,
  zapierHookUrlProblem,
  type ZapierConnectionView,
  type ZapierEventView,
} from "@template/contracts";
import {
  Alert,
  Badge,
  Button,
  Card,
  CopyButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  EmptyState,
  ErrorState,
  Field,
  formatRelative,
  Input,
  LoadingState,
  PageHeader,
  Table,
  TBody,
  TD,
  TH,
  THead,
  toast,
  TR,
} from "@template/ui";
import { ArrowLeft, Plus, Send, Zap } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useAssistantPageContext } from "../assistant/assistant";
import { errorMessage, Link, useApi, useCan, useNav, useSubmit } from "../context";
import { formatDateTime, type Tone } from "../automations/model";
import { CopyField, Section } from "../automations/parts";
import { useLoad } from "../use-load";

/** A secret we were just given; it can't be fetched again, so it lives only in this screen. */
type FreshSecret = { connectionId: string; secret: string };

export function connectionState(connection: ZapierConnectionView): { label: string; tone: Tone } {
  if (connection.status === "disabled") return { label: "Disabled", tone: "neutral" };
  if (connection.lastUsedAt) return { label: "Connected", tone: "success" };
  return connection.direction === "inbound"
    ? { label: "Waiting for first event", tone: "warning" }
    : { label: "Waiting for a test send", tone: "warning" };
}

export function eventName(event: { provider: string; eventType: string }): string {
  const provider = event.provider
    ? event.provider.charAt(0).toUpperCase() + event.provider.slice(1)
    : "";
  return [provider, event.eventType].filter(Boolean).join(" · ");
}

export function eventOutcome(event: ZapierEventView): { label: string; tone: Tone } {
  switch (event.status) {
    case "received":
      return { label: "Queued", tone: "info" };
    case "dispatched":
      return {
        label:
          event.runs.length === 1
            ? "Started 1 automation"
            : `Started ${event.runs.length} automations`,
        tone: "success",
      };
    case "no_match":
      return { label: "No automation listening", tone: "neutral" };
    case "failed":
      return event.attempts < ZAPIER_LIMITS.dispatchAttempts
        ? { label: "Failed · retrying", tone: "warning" }
        : { label: "Failed", tone: "danger" };
    case "test":
      return {
        label: event.runs.length
          ? `Test · would start ${event.runs.length}`
          : "Test · no automation listening",
        tone: "info",
      };
  }
}

/**
 * `/automations/zapier`: the bridge to systems this app has no connector for. Inbound
 * connections are URLs a Zap posts events to (they start automations); outbound hooks are Catch
 * Hook URLs a "Send to Zapier" step posts to. Owners and admins manage them.
 */
export function ZapierScreen() {
  const api = useApi();
  const nav = useNav();
  const canManage = useCan("automations.manage");
  const list = useLoad(() => api.zapier.list().then((r) => r.connections), "zapier", {
    // Watch for the first event while someone is setting up their Zap.
    pollMs: 5000,
    shouldPoll: (data) =>
      Boolean(
        data?.some((c) => c.direction === "inbound" && c.status === "active" && !c.lastUsedAt),
      ),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fresh, setFresh] = useState<FreshSecret | null>(null);
  const [creating, setCreating] = useState(false);
  const [addingHook, setAddingHook] = useState(false);

  const inbound = (list.data ?? []).filter((c) => c.direction === "inbound");
  const outbound = (list.data ?? []).filter((c) => c.direction === "outbound");
  const selected = inbound.find((c) => c.id === selectedId) ?? inbound[0] ?? null;

  useAssistantPageContext({
    title: "Zapier",
    summary: list.data
      ? `${inbound.length} inbound connections, ${outbound.length} outbound hooks`
      : "Zapier connections for systems this app doesn't connect to",
  });

  const onCreated = (connection: ZapierConnectionView, secret: string | null) => {
    if (secret) setFresh({ connectionId: connection.id, secret });
    setSelectedId(connection.id);
    void list.refetch();
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-8 p-6">
      <div className="grid gap-2">
        <Button
          variant="link"
          size="sm"
          className="justify-self-start px-0"
          onClick={() => nav.navigate("/automations")}
        >
          <ArrowLeft /> Automations
        </Button>
        <PageHeader
          title="Zapier"
          description="Start automations from other apps, or send to them, through Zapier."
        />
      </div>
      {list.loading ? (
        <LoadingState />
      ) : !list.data ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <>
          <Section
            title="Events from other apps"
            description="A Zap posts an event to a connection's URL, and the automations listening for it start."
            actions={
              canManage && inbound.length ? (
                <Button variant="outline" onClick={() => setCreating(true)}>
                  <Plus /> New connection
                </Button>
              ) : null
            }
          >
            {inbound.length === 0 ? (
              <EmptyState
                icon={Zap}
                title="No inbound connections yet"
                description="Create a connection to get a private URL and secret. Point a Zap's Webhooks by Zapier action at it, and its events can start your automations."
                action={
                  canManage ? (
                    <Button variant="outline" onClick={() => setCreating(true)}>
                      <Plus /> New connection
                    </Button>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Ask an owner or admin to set up Zapier.
                    </p>
                  )
                }
              />
            ) : (
              <>
                {inbound.length > 1 ? (
                  <div
                    className="flex flex-wrap gap-2"
                    role="group"
                    aria-label="Zapier connections"
                  >
                    {inbound.map((connection) => {
                      const state = connectionState(connection);
                      return (
                        <Button
                          key={connection.id}
                          aria-pressed={connection.id === selected?.id}
                          variant={connection.id === selected?.id ? "secondary" : "outline"}
                          size="sm"
                          onClick={() => setSelectedId(connection.id)}
                        >
                          {connection.name}
                          <Badge tone={state.tone}>{state.label}</Badge>
                        </Button>
                      );
                    })}
                  </div>
                ) : null}
                {selected ? (
                  <ConnectionDetail
                    key={selected.id}
                    connection={selected}
                    canManage={canManage}
                    freshSecret={fresh?.connectionId === selected.id ? fresh.secret : null}
                    onSecret={(secret) => setFresh({ connectionId: selected.id, secret })}
                    onChanged={() => void list.refetch()}
                    onDeleted={() => {
                      setSelectedId(null);
                      setFresh(null);
                      void list.refetch();
                    }}
                  />
                ) : null}
              </>
            )}
          </Section>

          <Section
            title="Sending to other apps"
            description="A “Send to Zapier” step posts JSON to a Zap that starts with Webhooks by Zapier → Catch Hook."
            actions={
              canManage && outbound.length ? (
                <Button variant="outline" onClick={() => setAddingHook(true)}>
                  <Plus /> Add hook
                </Button>
              ) : null
            }
          >
            {outbound.length === 0 ? (
              <EmptyState
                icon={Send}
                title="No Zapier hooks yet"
                description="In Zapier, start a Zap with Webhooks by Zapier → Catch Hook, copy its URL, and add it here. Then any automation can send data to it."
                action={
                  canManage ? (
                    <Button variant="outline" onClick={() => setAddingHook(true)}>
                      <Plus /> Add hook
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <Card>
                <HookTable
                  hooks={outbound}
                  canManage={canManage}
                  onChanged={() => void list.refetch()}
                />
              </Card>
            )}
          </Section>
        </>
      )}
      <NewConnectionDialog open={creating} onOpenChange={setCreating} onCreated={onCreated} />
      <NewHookDialog
        open={addingHook}
        onOpenChange={setAddingHook}
        onCreated={() => void list.refetch()}
      />
    </div>
  );
}

function NewConnectionDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (connection: ZapierConnectionView, secret: string | null) => void;
}) {
  const api = useApi();
  const [name, setName] = useState("");
  const create = useSubmit(async () => {
    const created = await api.zapier.create({
      direction: "inbound",
      name: name.trim() || undefined,
    });
    onCreated(created.connection, created.secret);
    onOpenChange(false);
    setName("");
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void create.run();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New Zapier connection"
        description="Each connection has its own URL and secret. One is enough for most; use more to keep Zaps apart."
      >
        <form onSubmit={submit} className="grid gap-4">
          <Field
            label="Name"
            hint="Shown here only, e.g. “HubSpot deals”."
            error={create.fields.name}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="HubSpot deals"
              maxLength={80}
              autoFocus
            />
          </Field>
          {create.error ? <Alert tone="danger">{create.error}</Alert> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" loading={create.pending}>
              Create connection
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SetupStep({ n, title, children }: { n: number; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 gap-y-2">
      <span
        aria-hidden
        className="flex size-7 items-center justify-center rounded-full bg-primary/12 text-xs font-semibold text-primary"
      >
        {n}
      </span>
      <p className="self-center text-sm font-medium">{title}</p>
      {children ? <div className="col-start-2 grid gap-3">{children}</div> : null}
    </li>
  );
}

function ConnectionDetail({
  connection,
  canManage,
  freshSecret,
  onSecret,
  onChanged,
  onDeleted,
}: {
  connection: ZapierConnectionView;
  canManage: boolean;
  freshSecret: string | null;
  onSecret: (secret: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const api = useApi();
  const state = connectionState(connection);
  const events = useLoad(
    () => api.zapier.events({ connectionId: connection.id }).then((r) => r.events),
    connection.id,
    { pollMs: 10_000 },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // A new event arriving refreshes the connection's status line too.
  const newest = events.data?.[0]?.id;
  useEffect(() => {
    if (newest) onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newest]);

  const run = async (key: string, action: () => Promise<void>, failure: string) => {
    setBusy(key);
    try {
      await action();
    } catch (error) {
      toast(failure, { description: errorMessage(error), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const sendTest = () =>
    run(
      "test",
      async () => {
        const event = await api.zapier.sendTestEvent({
          connectionId: connection.id,
          body: ZAPIER_SAMPLE_EVENT,
        });
        await events.refetch();
        toast("Test event recorded", {
          description: event.runs.length
            ? `It would start ${event.runs.map((r) => `“${r.automationName}”`).join(", ")}. Test events never run automations.`
            : "No published automation listens for it yet. Its fields now show in the automation editor's data picker.",
          tone: "success",
        });
      },
      "Couldn't send the test event",
    );

  const setStatus = (status: "active" | "disabled") =>
    run(
      "status",
      async () => {
        await api.zapier.update({ connectionId: connection.id, status });
        onChanged();
      },
      "Couldn't change the connection",
    );

  const regenerate = () =>
    run(
      "secret",
      async () => {
        const { secret } = await api.zapier.regenerateSecret({ connectionId: connection.id });
        setConfirmRegenerate(false);
        onSecret(secret);
        onChanged();
      },
      "Couldn't regenerate the secret",
    );

  const remove = () =>
    run(
      "delete",
      async () => {
        const { stoppedAutomations } = await api.zapier.delete({ connectionId: connection.id });
        setConfirmDelete(false);
        toast("Connection deleted", {
          description: stoppedAutomations
            ? `${stoppedAutomations} automation${stoppedAutomations === 1 ? "" : "s"} that used it stopped. Choose another connection in their trigger and publish again.`
            : undefined,
        });
        onDeleted();
      },
      "Couldn't delete the connection",
    );

  return (
    <div className="grid gap-6">
      <Card className="grid gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold">{connection.name}</h3>
            <p className="text-sm text-muted-foreground">
              {connection.lastUsedAt && connection.lastEvent
                ? `Last event: ${eventName(connection.lastEvent) || "event"} · ${formatRelative(new Date(connection.lastUsedAt))}`
                : "No event from Zapier yet"}
              {" · "}
              {connection.automationCount === 1
                ? "1 automation listens"
                : `${connection.automationCount} automations listen`}
            </p>
          </div>
          <Badge tone={state.tone}>{state.label}</Badge>
        </div>
        {connection.status === "disabled" ? (
          <Alert
            tone="warning"
            title="This connection is disabled"
            action={
              canManage ? (
                <Button
                  size="sm"
                  variant="outline"
                  loading={busy === "status"}
                  onClick={() => void setStatus("active")}
                >
                  Enable
                </Button>
              ) : null
            }
          >
            Zapier's deliveries are refused until it's enabled again. Nothing is lost on Zapier's
            side; it shows the failed runs so you can replay them.
          </Alert>
        ) : null}
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              loading={busy === "test"}
              onClick={() => void sendTest()}
            >
              Send test event
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirmRegenerate(true)}>
              Regenerate secret
            </Button>
            {connection.status === "active" ? (
              <Button
                variant="ghost"
                size="sm"
                loading={busy === "status"}
                onClick={() => void setStatus("disabled")}
              >
                Disable
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </div>
        ) : null}
      </Card>

      {canManage ? (
        // Once events arrive the guide folds away; a new secret opens it so it can be copied.
        <Card className="p-4 sm:p-5">
          <details open={!connection.lastUsedAt || Boolean(freshSecret)}>
            <summary className="cursor-pointer text-sm font-semibold">Set up the Zap</summary>
            <ol className="mt-5 grid gap-5" aria-label="Set up the Zap">
              <SetupStep n={1} title="Create or open your Zap in Zapier." />
              <SetupStep
                n={2}
                title="Choose the app and event that should start your automation, and add a Filter step if you only want some of them."
              />
              <SetupStep
                n={3}
                title="Add “Webhooks by Zapier” as the last action, with the POST event."
              />
              <SetupStep n={4} title="POST to this URL, with Payload Type set to json:">
                {connection.url ? <CopyField label="Webhook URL" value={connection.url} /> : null}
              </SetupStep>
              <SetupStep n={5} title="Add this header in the action's Headers:">
                <div className="grid gap-3 sm:grid-cols-2">
                  <CopyField label="Header name" value={ZAPIER_SECRET_HEADER} />
                  {freshSecret ? (
                    <CopyField label="Secret" value={freshSecret} />
                  ) : (
                    <Field
                      label="Secret"
                      hint="Only a hash is stored, so the secret can't be shown again. Regenerate it to get a new one; the old one stops working."
                    >
                      <Input
                        readOnly
                        value={`${"•".repeat(12)}${connection.hint}`}
                        className="font-mono text-xs"
                      />
                    </Field>
                  )}
                </div>
                {freshSecret ? (
                  <Alert tone="warning" title="Copy the secret now">
                    It's shown only this once. Paste it into your Zap's header before you leave this
                    page.
                  </Alert>
                ) : null}
              </SetupStep>
              <SetupStep
                n={6}
                title="In Data, send a provider, an eventType and the fields you need. Then test the step in Zapier."
              >
                <BodyExample />
              </SetupStep>
              <SetupStep
                n={7}
                title={
                  <>
                    This shows <Badge tone="success">Connected</Badge> once an event has arrived.
                    Then publish an automation that starts with “Zapier event received”.
                  </>
                }
              />
            </ol>
          </details>
        </Card>
      ) : null}

      <div className="grid gap-3">
        <div className="grid gap-0.5">
          <h3 className="text-sm font-semibold">Events received</h3>
          <p className="text-sm text-muted-foreground">
            The last {ZAPIER_LIMITS.historyPageSize} events, kept for {ZAPIER_LIMITS.historyDays}{" "}
            days. Repeats of an event already received are counted and ignored.
          </p>
        </div>
        {events.loading ? (
          <LoadingState />
        ) : !events.data ? (
          <ErrorState error={events.error} onRetry={() => void events.refetch()} />
        ) : events.data.length === 0 ? (
          <EmptyState
            icon={Zap}
            title="No events yet"
            description="Test your Webhooks by Zapier step, or use Send test event above, and it appears here."
          />
        ) : (
          <Card>
            <ul className="divide-y divide-border">
              {events.data.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </ul>
          </Card>
        )}
      </div>

      <Dialog open={confirmRegenerate} onOpenChange={setConfirmRegenerate}>
        <DialogContent
          title="Regenerate the secret?"
          description="The current secret stops working at once. Zaps that use it fail until you paste the new one into their header."
        >
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              submitShortcut
              loading={busy === "secret"}
              onClick={() => void regenerate()}
            >
              Regenerate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent
          title={`Delete “${connection.name}”?`}
          description="Its URL stops accepting events and its event history is deleted. Automations that use this connection stop until you choose another one."
        >
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              submitShortcut
              loading={busy === "delete"}
              onClick={() => void remove()}
            >
              Delete connection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EventRow({ event }: { event: ZapierEventView }) {
  const outcome = eventOutcome(event);
  return (
    <li className="grid gap-2 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{eventName(event) || "Event"}</span>
        <Badge tone={outcome.tone}>{outcome.label}</Badge>
        <span className="text-muted-foreground" title={formatDateTime(event.receivedAt)}>
          · {formatRelative(new Date(event.receivedAt))}
        </span>
        {event.deliveries > 1 ? (
          <span className="text-muted-foreground">· delivered {event.deliveries}×</span>
        ) : null}
      </div>
      {event.error ? <p className="text-danger">{event.error}</p> : null}
      {event.runs.length ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Automations">
          {event.runs.map((run) => (
            <li key={run.automationId}>
              <Link
                className="text-primary underline-offset-2 hover:underline"
                to={`/automations/${run.automationId}${run.runId ? `?tab=runs&run=${run.runId}` : ""}`}
              >
                {run.automationName}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {event.data !== null && event.data !== undefined ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Data{event.externalId ? ` · id ${event.externalId}` : ""}
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-surface-sunken p-3 font-mono">
            {JSON.stringify(event.data, null, 2)}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

function BodyExample() {
  const example = JSON.stringify(ZAPIER_BODY_EXAMPLE, null, 2);
  return (
    <details className="grid gap-3 text-sm">
      <summary className="cursor-pointer text-muted-foreground">Example body</summary>
      <div className="mt-3 grid gap-3">
        <p className="text-muted-foreground">
          For example, HubSpot → Deal stage changed, a Filter on “Closed won”, then this body.
          Replace each <code>{"{{…}}"}</code> with the matching field from Zapier's picker. Any
          fields work inside <code>data</code>; your automation can use all of them.
        </p>
        <div className="relative">
          <pre className="overflow-x-auto rounded-md bg-surface-sunken p-3 pr-12 font-mono text-xs">
            {example}
          </pre>
          <CopyButton text={example} label="Copy example" className="absolute top-2 right-2" />
        </div>
        <p className="text-muted-foreground">
          With Zapier's plain Data fields, name them <code>provider</code>, <code>eventType</code>,{" "}
          <code>externalId</code>, <code>occurredAt</code> and <code>data__name</code>,{" "}
          <code>data__amount</code> and so on. Include <code>externalId</code> and{" "}
          <code>occurredAt</code> so a retried delivery is recognized and never starts the
          automation twice.
        </p>
      </div>
    </details>
  );
}

function HookTable({
  hooks,
  canManage,
  onChanged,
}: {
  hooks: ZapierConnectionView[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ZapierConnectionView | null>(null);
  const run = async (key: string, action: () => Promise<void>, failure: string) => {
    setBusy(key);
    try {
      await action();
    } catch (error) {
      toast(failure, { description: errorMessage(error), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };
  const sendTest = (hook: ZapierConnectionView) =>
    run(
      `test:${hook.id}`,
      async () => {
        const { status } = await api.zapier.sendTest({ connectionId: hook.id });
        toast("Sent to Zapier", {
          description: `Zapier answered ${status}. Open the Catch Hook in your Zap to see the sample fields.`,
          tone: "success",
        });
        onChanged();
      },
      "Couldn't send to Zapier",
    );
  const setStatus = (hook: ZapierConnectionView, status: "active" | "disabled") =>
    run(
      `status:${hook.id}`,
      async () => {
        await api.zapier.update({ connectionId: hook.id, status });
        onChanged();
      },
      "Couldn't change the hook",
    );
  const remove = (hook: ZapierConnectionView) =>
    run(
      `delete:${hook.id}`,
      async () => {
        const { stoppedAutomations } = await api.zapier.delete({ connectionId: hook.id });
        setDeleting(null);
        toast("Hook deleted", {
          description: stoppedAutomations
            ? `${stoppedAutomations} automation${stoppedAutomations === 1 ? "" : "s"} that used it stopped. Choose another hook in their step and publish again.`
            : undefined,
        });
        onChanged();
      },
      "Couldn't delete the hook",
    );
  return (
    <>
      <Table>
        <THead>
          <TR>
            <TH>Hook</TH>
            <TH>Status</TH>
            <TH>Used by</TH>
            {canManage ? (
              <TH className="w-px">
                <span className="sr-only">Actions</span>
              </TH>
            ) : null}
          </TR>
        </THead>
        <TBody>
          {hooks.map((hook) => {
            const state = connectionState(hook);
            return (
              <TR key={hook.id}>
                <TD>
                  <span className="font-medium">{hook.name}</span>
                  <span className="block font-mono text-xs text-muted-foreground">
                    …{hook.hint}
                  </span>
                </TD>
                <TD>
                  <Badge tone={state.tone}>{state.label}</Badge>
                  {hook.lastUsedAt ? (
                    <span className="block text-xs text-muted-foreground">
                      Last sent {formatRelative(new Date(hook.lastUsedAt))}
                    </span>
                  ) : null}
                </TD>
                <TD className="text-sm">
                  {hook.automationCount === 1
                    ? "1 automation"
                    : `${hook.automationCount} automations`}
                </TD>
                {canManage ? (
                  <TD className="whitespace-nowrap">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        loading={busy === `test:${hook.id}`}
                        disabled={hook.status !== "active"}
                        onClick={() => void sendTest(hook)}
                      >
                        Send test
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === `status:${hook.id}`}
                        onClick={() =>
                          void setStatus(hook, hook.status === "active" ? "disabled" : "active")
                        }
                      >
                        {hook.status === "active" ? "Disable" : "Enable"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(hook)}>
                        Delete
                      </Button>
                    </div>
                  </TD>
                ) : null}
              </TR>
            );
          })}
        </TBody>
      </Table>
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        {deleting ? (
          <DialogContent
            title={`Delete “${deleting.name}”?`}
            description="Automations that send to this hook stop until you choose another one. The Zap itself isn't changed."
          >
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button
                variant="destructive"
                submitShortcut
                loading={busy === `delete:${deleting.id}`}
                onClick={() => void remove(deleting)}
              >
                Delete hook
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

function NewHookDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const api = useApi();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [touched, setTouched] = useState(false);
  const problem = url.trim() ? zapierHookUrlProblem(url) : "Paste the Catch Hook URL from Zapier.";
  const create = useSubmit(async () => {
    await api.zapier.create({
      direction: "outbound",
      name: name.trim() || undefined,
      url: url.trim(),
    });
    toast("Hook added", {
      description:
        "Use “Send test” so Zapier can see the fields, then add a “Send to Zapier” step.",
      tone: "success",
    });
    onCreated();
    onOpenChange(false);
    setName("");
    setUrl("");
    setTouched(false);
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem) return;
    void create.run();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setTouched(false);
      }}
    >
      <DialogContent
        title="Add a Zapier hook"
        description="In Zapier, start a Zap with Webhooks by Zapier → Catch Hook and copy its URL. The URL is stored sealed and isn't shown again."
      >
        <form onSubmit={submit} className="grid gap-4">
          <Field
            label="Name"
            hint="Shown in the step picker, e.g. “Add row to Google Sheets”."
            error={create.fields.name}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Add row to Google Sheets"
              maxLength={80}
              autoFocus
            />
          </Field>
          <Field label="Catch Hook URL" error={(touched && problem) || create.fields.url}>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="https://hooks.zapier.com/hooks/catch/…"
              className="font-mono text-xs"
              inputMode="url"
              autoComplete="off"
            />
          </Field>
          {create.error ? <Alert tone="danger">{create.error}</Alert> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" loading={create.pending}>
              Add hook
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
