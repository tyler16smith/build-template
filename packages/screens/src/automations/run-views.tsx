import { isRunOpen, type RunView } from "@template/contracts";
import {
  Alert,
  Badge,
  Button,
  cn,
  Field,
  Table,
  TBody,
  TD,
  Textarea,
  TH,
  THead,
  toast,
  TR,
} from "@template/ui";
import { FlaskConical, Wrench } from "lucide-react";
import { useState } from "react";
import { errorMessage, useApi } from "../context";
import {
  formatDateTime,
  RUN_STATUS_LABELS,
  runStatusTone,
  STEP_STATUS_LABELS,
  stepStatusTone,
  type Tone,
} from "./model";

export const MODE_LABELS: Record<RunView["mode"], string> = {
  live: "Live",
  simulated: "Simulated test",
  live_test: "Live test",
};

function modeTone(mode: RunView["mode"]): Tone {
  return mode === "live" ? "outline" : mode === "simulated" ? "info" : "warning";
}

/** How long a run took (or has taken so far). */
export function runDuration(
  run: Pick<RunView, "startedAt" | "finishedAt">,
  now = Date.now(),
): string {
  if (!run.startedAt) return "—";
  const ms =
    (run.finishedAt ? new Date(run.finishedAt).getTime() : now) - new Date(run.startedAt).getTime();
  return ms < 1000
    ? `${ms} ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(1)} s`
      : `${Math.round(ms / 60_000)} min`;
}

/** "v3", or "draft r7" for a test of a draft revision (stored as a negative version). */
export function versionLabel(version: number): string {
  return version > 0 ? `v${version}` : `draft r${-version}`;
}

export function RunList({
  runs,
  onOpen,
  selectedId,
}: {
  runs: RunView[];
  onOpen: (run: RunView) => void;
  selectedId: string | null;
}) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Started</TH>
          <TH>Status</TH>
          <TH>Kind</TH>
          <TH>Version</TH>
          <TH>Current step</TH>
          <TH>Took</TH>
        </TR>
      </THead>
      <TBody>
        {runs.map((run) => (
          <TR
            key={run.id}
            className={cn("cursor-pointer hover:bg-muted/60", selectedId === run.id && "bg-muted")}
            onClick={() => onOpen(run)}
          >
            <TD>
              <button
                type="button"
                className="text-left font-medium underline-offset-2 hover:underline"
                aria-current={selectedId === run.id ? "true" : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen(run);
                }}
              >
                {formatDateTime(run.createdAt)}
              </button>
            </TD>
            <TD>
              <Badge tone={runStatusTone(run.status)}>{RUN_STATUS_LABELS[run.status]}</Badge>
            </TD>
            <TD>
              <Badge tone={modeTone(run.mode)}>{MODE_LABELS[run.mode]}</Badge>
            </TD>
            <TD>{versionLabel(run.version)}</TD>
            <TD className="font-mono text-xs">
              {isRunOpen(run.status) ? (run.currentStepId ?? "—") : "—"}
            </TD>
            <TD>{runDuration(run)}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="grid min-w-0 gap-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/** One run: its approvals (with Approve and Decline for the people who can), then each step. */
export function RunDetail({
  run,
  onChanged,
  canManage,
  onFixStep,
}: {
  run: RunView;
  onChanged: () => void;
  canManage: boolean;
  onFixStep?: (stepId: string) => void;
}) {
  const api = useApi();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (approvalId: string, decision: "approved" | "rejected") => {
    setBusy(decision);
    try {
      await api.automations.decideApproval({
        runId: run.id,
        approvalId,
        decision,
        note: note.trim() || undefined,
      });
      toast(decision === "approved" ? "Approved. The run continues." : "Declined. The run stops.", {
        tone: "success",
      });
      setNote("");
      onChanged();
    } catch (failure) {
      toast("Couldn't record the decision", { description: errorMessage(failure), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };
  const cancel = async () => {
    setBusy("cancel");
    try {
      await api.automations.cancelRun({ runId: run.id });
      toast("Run cancelled");
      onChanged();
    } catch (failure) {
      toast("Couldn't cancel the run", { description: errorMessage(failure), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={runStatusTone(run.status)}>{RUN_STATUS_LABELS[run.status]}</Badge>
        <Badge tone={modeTone(run.mode)}>
          {run.mode === "simulated" ? <FlaskConical aria-hidden /> : null} {MODE_LABELS[run.mode]}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {run.version > 0 ? `Version ${run.version}` : `Draft revision ${-run.version}`} · started{" "}
          {formatDateTime(run.startedAt ?? run.createdAt)} · {runDuration(run)}
        </span>
        {canManage && isRunOpen(run.status) && run.mode !== "simulated" ? (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            loading={busy === "cancel"}
            onClick={() => void cancel()}
          >
            Cancel run
          </Button>
        ) : null}
      </div>
      {run.mode === "simulated" ? (
        <Alert tone="info" title="Nothing real happened in this test">
          Steps marked Simulated show what would be sent or written. Lookups that only read data ran
          for real.
        </Alert>
      ) : null}
      {run.error ? (
        <Alert tone="danger" title="The run failed">
          {run.error}
          {run.fixHint ? <p className="mt-1">{run.fixHint}</p> : null}
        </Alert>
      ) : null}
      {run.approvals
        .filter((a) => a.status === "pending")
        .map((approval) => (
          <Alert key={approval.id} tone="warning" title="Waiting for approval">
            <p className="whitespace-pre-wrap text-foreground">{approval.message}</p>
            {approval.canDecide ? (
              <form
                className="mt-2 grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void decide(approval.id, "approved");
                }}
              >
                <Field label="Note (optional)">
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
                </Field>
                <div className="flex gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    loading={busy === "approved"}
                    disabled={busy !== null}
                  >
                    Approve
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    loading={busy === "rejected"}
                    disabled={busy !== null}
                    onClick={() => void decide(approval.id, "rejected")}
                  >
                    Decline
                  </Button>
                </div>
              </form>
            ) : (
              <p className="mt-1 text-xs">You aren't one of the approvers for this step.</p>
            )}
          </Alert>
        ))}
      {run.approvals.some((a) => a.status !== "pending") ? (
        <ul className="grid gap-1 text-sm text-muted-foreground">
          {run.approvals
            .filter((a) => a.status !== "pending")
            .map((a) => (
              <li key={a.id}>
                {a.status === "approved"
                  ? "Approved"
                  : a.status === "rejected"
                    ? "Declined"
                    : "Expired"}
                {a.decidedBy ? ` by ${a.decidedBy}` : ""}
                {a.decidedAt ? ` · ${formatDateTime(a.decidedAt)}` : ""}
              </li>
            ))}
        </ul>
      ) : null}
      <ol className="grid gap-2" aria-label="Run steps">
        {run.steps.map((step) => (
          <li
            key={step.stepId}
            className={cn(
              "rounded-lg border border-border p-3",
              step.status === "failed" && "border-danger/40",
              step.simulated && step.kind !== "trigger" && "border-dashed",
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{step.name}</span>
              <Badge tone={stepStatusTone(step.status)}>{STEP_STATUS_LABELS[step.status]}</Badge>
              {step.simulated && step.kind !== "trigger" && step.status !== "simulated" ? (
                <Badge tone="info">simulated</Badge>
              ) : null}
              {step.attempts > 1 ? <Badge tone="warning">{step.attempts} attempts</Badge> : null}
              <span className="ml-auto text-xs text-muted-foreground">
                {step.finishedAt
                  ? formatDateTime(step.finishedAt)
                  : step.startedAt
                    ? `since ${formatDateTime(step.startedAt)}`
                    : ""}
              </span>
            </div>
            {step.error ? <p className="mt-1 text-sm text-danger">{step.error}</p> : null}
            {step.hint ? (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Wrench aria-hidden className="size-3.5" /> {step.hint}
                {onFixStep && step.kind !== "trigger" ? (
                  <Button size="sm" variant="link" onClick={() => onFixStep(step.stepId)}>
                    Open this step
                  </Button>
                ) : null}
              </div>
            ) : null}
            {step.input !== null || step.output !== null ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Input and output (sensitive values redacted)
                </summary>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <JsonBlock label="Input" value={step.input} />
                  <JsonBlock label="Output" value={step.output} />
                </div>
              </details>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
