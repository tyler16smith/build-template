import { ApiClientError } from "@template/api-client";
import {
  describeDiff,
  diffDefinitions,
  flattenSteps,
  isRunOpen,
  type AutomationDetail,
  type RunView,
  WEBHOOK_HEADERS,
} from "@template/contracts";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Textarea,
  toast,
} from "@template/ui";
import { FlaskConical, History, KeyRound, Rocket, TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage, useApi } from "../context";
import { describeStep, describeTrigger, effectsOf, formatDateTime } from "./model";
import { CopyField, Section } from "./parts";
import { RunDetail, RunList } from "./run-views";
import { useLoad } from "../use-load";

function EffectsList({ effects, empty }: { effects: string[]; empty: string }) {
  return effects.length ? (
    <ul className="list-disc pl-4">
      {effects.map((e) => (
        <li key={e}>{e}</li>
      ))}
    </ul>
  ) : (
    <>{empty}</>
  );
}

/** Review exactly what will run, then publish the revision that was reviewed. */
export function PublishDialog({
  open,
  onOpenChange,
  detail,
  userName,
  onPublished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: AutomationDetail;
  userName: string;
  onPublished: () => void;
}) {
  const api = useApi();
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = detail.draft;
  const blockers = detail.issues.filter((i) => i.severity === "error");
  const warnings = detail.issues.filter((i) => i.severity === "warning");
  const effects = effectsOf(draft, detail.catalog);
  const hooks = [
    ...new Set(
      flattenSteps(draft.steps).flatMap(({ step }) =>
        step.kind === "zapier.send" ? [step.connectionId] : [],
      ),
    ),
  ];
  const changes = detail.activeDefinition
    ? describeDiff(diffDefinitions(detail.activeDefinition, draft))
    : null;
  const nextVersion = Math.max(0, ...detail.versions.map((v) => v.version)) + 1;

  const publish = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { version } = await api.automations.publish({
        automationId: detail.automation.id,
        revision: detail.automation.draftRevision,
        notes: notes.trim() || undefined,
      });
      toast(`Published version ${version}`, {
        description: "It now runs on its trigger.",
        tone: "success",
      });
      onOpenChange(false);
      onPublished();
    } catch (failure) {
      setError(errorMessage(failure));
      if (failure instanceof ApiClientError && failure.status === 409) onPublished();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Publish “${draft.name}”`}
        description={`Review exactly what will run. This is draft revision ${detail.automation.draftRevision}.`}
        size="lg"
      >
        <form onSubmit={(e) => void publish(e)} className="grid gap-4 text-sm">
          <div>
            <p className="font-medium">{describeTrigger(draft.trigger, detail.catalog)}</p>
            <ol className="mt-2 grid gap-1">
              {flattenSteps(draft.steps).map(({ step, depth }) => (
                <li key={step.id} style={{ paddingLeft: `${depth * 1.25}rem` }}>
                  <span className="font-medium">{step.name}</span>{" "}
                  <span className="text-muted-foreground">
                    — {describeStep(step, detail.catalog)}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          {changes ? (
            <Alert tone="info" title={`Changes from version ${detail.automation.activeVersion}`}>
              {changes}. Runs already in progress keep using the version they started with.
            </Alert>
          ) : null}
          <Alert tone="warning" title="Real effects when it runs">
            <EffectsList
              effects={effects}
              empty="It only reads data and makes decisions; it doesn't change anything."
            />
            <p className="mt-2">
              It runs as you ({userName}), with your permissions. If you lose access, it stops.
            </p>
          </Alert>
          {hooks.length ? (
            <div>
              <p className="font-medium">Zapier hooks it uses</p>
              <ul className="mt-1 grid gap-1">
                {hooks.map((id) => {
                  const hook = detail.catalog.zapierHooks.find((h) => h.id === id);
                  return (
                    <li key={id ?? "none"} className="flex items-center gap-2">
                      {hook ? hook.name : "Not chosen yet"}
                      <Badge tone={hook?.status === "active" ? "success" : "danger"}>
                        {hook?.status ?? "missing"}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {blockers.length ? (
            <Alert
              tone="danger"
              title={`Fix ${blockers.length} problem${blockers.length === 1 ? "" : "s"} first`}
            >
              <ul className="list-disc pl-4">
                {blockers.map((issue, i) => (
                  <li key={i}>{issue.message}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {warnings.length ? (
            <details>
              <summary className="cursor-pointer text-muted-foreground">
                <TriangleAlert aria-hidden className="mr-1 inline size-3.5" />
                {warnings.length} warning{warnings.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                {warnings.map((issue, i) => (
                  <li key={i}>{issue.message}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <Field label="Release notes (optional)">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </Field>
          {error ? (
            <Alert tone="danger" title="Not published">
              {error}
            </Alert>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Keep editing
              </Button>
            </DialogClose>
            <Button type="submit" loading={busy} disabled={blockers.length > 0}>
              <Rocket /> Publish version {nextVersion}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Runs the saved draft once with real effects. The person ticks a box under the list of every
 * real effect first; the server refuses a live test without that confirmation.
 */
export function LiveTestDialog({
  open,
  onOpenChange,
  detail,
  payload,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: AutomationDetail;
  /** Sample trigger data; undefined uses values made from the trigger's schema. */
  payload?: () => unknown;
  onStarted: (runId: string) => void;
}) {
  const api = useApi();
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effects = effectsOf(detail.draft, detail.catalog);
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setUnderstood(false);
      setError(null);
    }
  };
  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!understood) return;
    setBusy(true);
    setError(null);
    try {
      const { runId } = await api.automations.liveTest({
        automationId: detail.automation.id,
        revision: detail.automation.draftRevision,
        payload: payload?.(),
        confirmEffects: true,
      });
      close(false);
      toast("Live test started", { description: "Follow it in Runs." });
      onStarted(runId);
    } catch (failure) {
      setError(
        failure instanceof Error && !(failure instanceof ApiClientError)
          ? failure.message
          : errorMessage(failure),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title="Run a live test?"
        description={`This runs draft revision ${detail.automation.draftRevision} once with real effects. It doesn't publish anything.`}
      >
        <form onSubmit={(e) => void start(e)} className="grid gap-3">
          <Alert tone="danger" title="These will really happen">
            <EffectsList
              effects={effects}
              empty="No step changes anything; the test only reads data."
            />
          </Alert>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={understood}
              onCheckedChange={(on) => setUnderstood(on === true)}
            />
            <span>
              {effects.length
                ? "I understand everything listed above really happens."
                : "I understand this runs for real."}
            </span>
          </label>
          {error ? (
            <Alert tone="danger" title="The live test didn't start">
              {error}
            </Alert>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant="destructive"
              submitShortcut
              loading={busy}
              disabled={!understood}
            >
              Run live test
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function parsePayload(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The sample data isn't valid JSON.");
  }
}

/** Tests with sample data: a simulated run (nothing real happens) or a live test. */
export function TestPanel({
  detail,
  dirty,
  onLiveStarted,
  onFixStep,
  onSimulated,
}: {
  detail: AutomationDetail;
  dirty: boolean;
  onLiveStarted: (runId: string) => void;
  onFixStep: (stepId: string) => void;
  /** The latest simulated run, so the workflow can show each step's result. */
  onSimulated?: (run: RunView) => void;
}) {
  const api = useApi();
  const [payloadText, setPayloadText] = useState("");
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [result, setResult] = useState<RunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);
  const blockers = detail.issues.filter((i) => i.severity === "error");

  const simulate = async (event: FormEvent) => {
    event.preventDefault();
    let payload: unknown;
    try {
      payload = parsePayload(payloadText);
      setPayloadError(null);
    } catch (failure) {
      setPayloadError((failure as Error).message);
      return;
    }
    setBusy(true);
    try {
      const run = await api.automations.simulate({ automationId: detail.automation.id, payload });
      setResult(run);
      onSimulated?.(run);
    } catch (failure) {
      toast("The test didn't run", { description: errorMessage(failure), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      {!detail.canManage ? (
        <Alert tone="info" title="Only owners and admins can test automations">
          You can see every run in Runs.
        </Alert>
      ) : null}
      {dirty ? (
        <Alert tone="warning" title="Save your changes first">
          Tests run the saved draft.
        </Alert>
      ) : null}
      <form onSubmit={(e) => void simulate(e)} className="grid gap-4">
        <Field
          label="Sample trigger data (optional JSON)"
          hint="Leave empty to use sample values made from the trigger's fields and schema."
          error={payloadError}
        >
          <Textarea
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            rows={5}
            className="font-mono text-xs"
            placeholder={'{ "data": { "name": "Dana Scully" } }'}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy} disabled={dirty || !detail.canManage}>
            <FlaskConical /> Run simulated test
          </Button>
          {detail.canManage ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                try {
                  parsePayload(payloadText);
                  setPayloadError(null);
                  setConfirmLive(true);
                } catch (failure) {
                  setPayloadError((failure as Error).message);
                }
              }}
              disabled={busy || dirty || blockers.length > 0}
            >
              Live test…
            </Button>
          ) : null}
        </div>
      </form>
      <Alert tone="info">
        Simulated tests never send email, post to Zapier or change records. Read-only lookups run
        for real so mappings show real values.
        {detail.canManage && blockers.length
          ? " Fix the draft's problems to enable a live test."
          : ""}
      </Alert>
      {result ? (
        <Card className="p-4">
          <RunDetail
            run={result}
            onChanged={() => undefined}
            canManage={false}
            onFixStep={onFixStep}
          />
        </Card>
      ) : null}
      <LiveTestDialog
        open={confirmLive}
        onOpenChange={setConfirmLive}
        detail={detail}
        payload={() => parsePayload(payloadText)}
        onStarted={onLiveStarted}
      />
    </div>
  );
}

/** Every run, newest first, and the one picked with its timeline. Polls while one is open. */
export function RunsPanel({
  detail,
  selectedRunId,
  onSelect,
  onFixStep,
  refreshKey,
}: {
  detail: AutomationDetail;
  selectedRunId: string | null;
  onSelect: (runId: string | null) => void;
  onFixStep: (stepId: string) => void;
  /** Changes when a run was just started here, to load it at once. */
  refreshKey?: string;
}) {
  const api = useApi();
  const id = detail.automation.id;
  const runs = useLoad(
    () => api.automations.runs({ automationId: id }).then((r) => r.runs),
    `${id}:${refreshKey ?? ""}`,
    {
      pollMs: 3000,
      shouldPoll: (data) => Boolean(data?.some((r) => isRunOpen(r.status))),
    },
  );
  // A run linked from an approval email may be older than the list: load it on its own.
  const listed = runs.data?.find((r) => r.id === selectedRunId) ?? null;
  const single = useLoad(
    selectedRunId && runs.data && !listed
      ? () => api.automations.getRun({ runId: selectedRunId })
      : null,
    selectedRunId ?? "",
  );
  const selected = listed ?? single.data;
  const refresh = () => {
    void runs.refetch();
    if (!listed) void single.refetch();
  };
  if (runs.loading) return <LoadingState />;
  if (!runs.data) return <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />;
  if (runs.data.length === 0 && !selected)
    return (
      <EmptyState
        icon={History}
        title="No runs yet"
        description="Runs appear here when the trigger fires, when someone runs it, and for tests."
      />
    );
  return (
    <div className="grid gap-4">
      {runs.data.length ? (
        <Card>
          <RunList runs={runs.data} selectedId={selectedRunId} onOpen={(run) => onSelect(run.id)} />
        </Card>
      ) : null}
      {selected ? (
        <Card className="p-4">
          <RunDetail
            run={selected}
            canManage={detail.canManage}
            onChanged={refresh}
            onFixStep={onFixStep}
          />
        </Card>
      ) : null}
    </div>
  );
}

/** Published versions, and every saved draft revision with Restore. */
export function VersionsPanel({
  detail,
  dirty,
  onRestored,
}: {
  detail: AutomationDetail;
  dirty: boolean;
  onRestored: () => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState<number | null>(null);
  const restore = async (revision: number) => {
    setBusy(revision);
    try {
      await api.automations.restore({
        automationId: detail.automation.id,
        revision,
        baseRevision: detail.automation.draftRevision,
      });
      toast(`Restored revision ${revision} as the draft`, { tone: "success" });
      onRestored();
    } catch (failure) {
      toast("Couldn't restore", { description: errorMessage(failure), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="grid gap-6">
      <Section
        title="Published versions"
        description="Each run uses exactly the version that was active when it started."
      >
        {detail.versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not published yet.</p>
        ) : (
          <ol className="grid gap-2">
            {detail.versions.map((version) => (
              <li key={version.version} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Version {version.version}</span>
                  {version.version === detail.automation.activeVersion ? (
                    <Badge tone="success">active</Badge>
                  ) : null}
                  <span className="text-muted-foreground">
                    {version.publishedBy ? `by ${version.publishedBy} · ` : ""}
                    {formatDateTime(version.createdAt)} · from draft r{version.draftRevision}
                  </span>
                </div>
                {version.notes ? (
                  <p className="mt-1 text-muted-foreground">{version.notes}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Section>
      <Section title="Draft history" description="Every saved change, from the chat or the editor.">
        <ol className="grid gap-2">
          {detail.revisions.map((revision) => (
            <li
              key={revision.revision}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-sm"
            >
              <span className="font-medium">r{revision.revision}</span>
              <Badge tone={revision.source === "chat" ? "accent" : "outline"}>
                {revision.source === "chat"
                  ? "Builder chat"
                  : revision.source === "ui"
                    ? "Editor"
                    : "Created"}
              </Badge>
              <span className="min-w-0 flex-1 truncate">{revision.summary}</span>
              <span className="text-xs text-muted-foreground">
                {revision.author ? `${revision.author} · ` : ""}
                {formatDateTime(revision.createdAt)}
              </span>
              {detail.canManage && revision.revision !== detail.automation.draftRevision ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={dirty || (busy !== null && busy !== revision.revision)}
                  loading={busy === revision.revision}
                  onClick={() => void restore(revision.revision)}
                >
                  Restore
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

/** The webhook trigger's URL and signing secret, for managers, once published. */
export function WebhookPanel({ detail }: { detail: AutomationDetail }) {
  const api = useApi();
  const [secret, setSecret] = useState<string | null>(null);
  const [url, setUrl] = useState(detail.webhook?.url ?? null);
  const [busy, setBusy] = useState<"reveal" | "rotate" | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  if (!detail.canManage) return null;
  if (!url)
    return (
      <Alert tone="info">The webhook URL and signing secret are created when you publish.</Alert>
    );
  const reveal = async () => {
    setBusy("reveal");
    try {
      const result = await api.automations.webhook({ automationId: detail.automation.id });
      setUrl(result.url);
      setSecret(result.secret);
    } catch (failure) {
      toast("Couldn't load the secret", { description: errorMessage(failure), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };
  const rotate = async () => {
    setBusy("rotate");
    try {
      const result = await api.automations.rotateWebhook({ automationId: detail.automation.id });
      setUrl(result.url);
      setSecret(result.secret);
      setConfirmRotate(false);
      toast("New URL and secret", {
        description: "Update every sender to use them.",
        tone: "success",
      });
    } catch (failure) {
      toast("Couldn't rotate the webhook", { description: errorMessage(failure), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="grid gap-3 text-sm">
      <CopyField label="Webhook URL" value={url} />
      {secret ? (
        <CopyField label="Signing secret" value={secret} />
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          loading={busy === "reveal"}
          onClick={() => void reveal()}
        >
          <KeyRound /> Show signing secret
        </Button>
      )}
      <Alert tone="info" title="How to call it">
        Send <code>POST</code> with a JSON body (up to 64 KB) and the headers{" "}
        <code>{WEBHOOK_HEADERS.timestamp}</code> (Unix seconds) and{" "}
        <code>{WEBHOOK_HEADERS.signature}: sha256=</code>
        the hex HMAC-SHA256 of <code>{"<timestamp>.<body>"}</code> with the secret. Optionally add{" "}
        <code>{WEBHOOK_HEADERS.delivery}</code> (a unique id; repeats are ignored). Requests older
        than 5 minutes are refused.
      </Alert>
      <Button
        variant="ghost"
        size="sm"
        className="justify-self-start"
        onClick={() => setConfirmRotate(true)}
      >
        Rotate URL and secret
      </Button>
      <Dialog open={confirmRotate} onOpenChange={setConfirmRotate}>
        <DialogContent
          title="Rotate the webhook URL and secret?"
          description="Senders using the old ones are refused at once."
        >
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              submitShortcut
              loading={busy === "rotate"}
              onClick={() => void rotate()}
            >
              Rotate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Run now, for a published manual trigger, with its fields. */
export function ManualRunDialog({
  open,
  onOpenChange,
  detail,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: AutomationDetail;
  onStarted: (runId: string) => void;
}) {
  const api = useApi();
  const trigger = detail.activeDefinition?.trigger;
  const [fields, setFields] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!trigger || trigger.kind !== "manual") return null;
  const run = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const values = Object.fromEntries(
        trigger.fields.map((f) => {
          const raw = fields[f.key];
          return [
            f.key,
            f.type === "number"
              ? raw === undefined || raw === ""
                ? null
                : Number(raw)
              : f.type === "boolean"
                ? raw === true
                : f.type === "datetime" && typeof raw === "string" && raw
                  ? new Date(raw).toISOString()
                  : (raw ?? ""),
          ];
        }),
      );
      const { runId } = await api.automations.run({
        automationId: detail.automation.id,
        fields: values,
      });
      onOpenChange(false);
      setFields({});
      toast("Started", { description: "Follow it in Runs.", tone: "success" });
      onStarted(runId);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Run “${detail.automation.name}”`}
        description={`Runs published version ${detail.automation.activeVersion} with real effects.`}
      >
        <form onSubmit={(e) => void run(e)} className="grid gap-3">
          {trigger.fields.map((field) =>
            field.type === "boolean" ? (
              <label key={field.key} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={fields[field.key] === true}
                  onCheckedChange={(on) => setFields({ ...fields, [field.key]: on === true })}
                />
                {field.label}
              </label>
            ) : (
              <Field
                key={field.key}
                label={field.required ? field.label : `${field.label} (optional)`}
              >
                <Input
                  required={field.required}
                  type={
                    field.type === "number"
                      ? "number"
                      : field.type === "email"
                        ? "email"
                        : field.type === "datetime"
                          ? "datetime-local"
                          : "text"
                  }
                  value={String(fields[field.key] ?? "")}
                  onChange={(e) => setFields({ ...fields, [field.key]: e.target.value })}
                />
              </Field>
            ),
          )}
          {error ? (
            <Alert tone="danger" title="It didn't start">
              {error}
            </Alert>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" loading={busy}>
              Run now
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
