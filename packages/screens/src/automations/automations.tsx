import type { ApprovalWaiting, AutomationList, AutomationSummary } from "@template/contracts";
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  formatRelative,
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
import { MoreHorizontal, Plus, Workflow, Zap } from "lucide-react";
import { useState } from "react";
import { useAssistantPageContext } from "../assistant/assistant";
import { errorMessage, Link, useApi, useNav } from "../context";
import {
  AUTOMATION_STATUS_LABELS,
  automationStatusTone,
  formatDateTime,
  RUN_STATUS_LABELS,
  runStatusTone,
} from "./model";
import { Section } from "./parts";
import { useLoad } from "../use-load";

const STATUS_ORDER = ["active", "failed", "paused", "draft"] as const;

/** `/automations`: every automation by status, and the approvals waiting for this person. */
export function AutomationsScreen() {
  const api = useApi();
  const nav = useNav();
  const list = useLoad(() => api.automations.list(), "automations", { pollMs: 10_000 });
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const data = list.data;
  useAssistantPageContext({
    title: "Automations",
    summary: data
      ? `${data.automations.length} automations (${data.automations.filter((a) => a.status === "active").length} active), ${data.approvalsWaiting.length} approvals waiting`
      : "Automations that run on events, schedules, webhooks, Zapier or by hand",
    suggestions: ["What do my automations do?", "Did anything fail recently?"],
  });

  const start = () => nav.navigate("/automations/new");
  const openEditor = (id: string) => nav.navigate(`/automations/${id}`);

  async function confirmDelete() {
    if (!pendingDelete) return;
    const { id, name } = pendingDelete;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.automations.delete({ automationId: id });
      setPendingDelete(null);
      toast(`Deleted ${name}`);
      await list.refetch();
    } catch (failure) {
      setDeleteError(errorMessage(failure));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-8 p-6">
      <PageHeader
        title="Automations"
        description="Workflows that run on triggers, schedules, webhooks, Zapier events, or manually."
        actions={
          <>
            <Button variant="outline" onClick={() => nav.navigate("/automations/zapier")}>
              <Zap /> Zapier
            </Button>
            {data?.canManage ? (
              <Button onClick={start}>
                <Plus /> New automation
              </Button>
            ) : null}
          </>
        }
      />
      {list.loading ? (
        <LoadingState />
      ) : !data ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <>
          {data.approvalsWaiting.length ? (
            <ApprovalsWaiting
              approvals={data.approvalsWaiting}
              onDecided={() => void list.refetch()}
            />
          ) : null}
          {data.automations.length === 0 ? (
            <EmptyState
              icon={Workflow}
              title="No automations yet"
              description="Describe what should happen, for example “when a profile is updated, email the owners”, and the Builder sets it up."
              action={
                data.canManage ? (
                  <Button onClick={start}>
                    <Plus /> New automation
                  </Button>
                ) : undefined
              }
            />
          ) : (
            STATUS_ORDER.map((status) => {
              const rows = data.automations.filter((a) => a.status === status);
              if (!rows.length) return null;
              return (
                <Section key={status} title={AUTOMATION_STATUS_LABELS[status]}>
                  <Card>
                    <AutomationTable
                      rows={rows}
                      data={data}
                      onOpen={openEditor}
                      onDelete={(row) => {
                        setDeleteError(null);
                        setPendingDelete({ id: row.id, name: row.name });
                      }}
                    />
                  </Card>
                </Section>
              );
            })
          )}
        </>
      )}
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (deleting || open) return;
          setPendingDelete(null);
          setDeleteError(null);
        }}
      >
        {pendingDelete ? (
          <DialogContent
            title={`Delete “${pendingDelete.name}”?`}
            description="Its draft, versions and run history are deleted. You can't undo it."
            size="sm"
          >
            {deleteError ? <Alert tone="danger">{deleteError}</Alert> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button
                variant="destructive"
                submitShortcut
                loading={deleting}
                onClick={() => void confirmDelete()}
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

function AutomationTable({
  rows,
  data,
  onOpen,
  onDelete,
}: {
  rows: AutomationSummary[];
  data: AutomationList;
  onOpen: (id: string) => void;
  onDelete: (row: AutomationSummary) => void;
}) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Automation</TH>
          <TH>Starts</TH>
          <TH>Last run</TH>
          <TH className="text-right">Runs today</TH>
          {data.canManage ? (
            <TH className="w-px">
              <span className="sr-only">Actions</span>
            </TH>
          ) : null}
        </TR>
      </THead>
      <TBody>
        {rows.map((automation) => (
          <TR
            key={automation.id}
            className="cursor-pointer hover:bg-muted/60"
            onClick={() => onOpen(automation.id)}
          >
            <TD>
              <Link
                to={`/automations/${automation.id}`}
                onClick={(event) => event.stopPropagation()}
                className="font-medium underline-offset-2 hover:underline"
              >
                {automation.name}
              </Link>
              <span className="mt-0.5 flex flex-wrap items-center gap-1">
                <Badge tone={automationStatusTone(automation.status)}>
                  {AUTOMATION_STATUS_LABELS[automation.status]}
                </Badge>
                {automation.activeVersion ? (
                  <Badge tone="outline">v{automation.activeVersion}</Badge>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {automation.stepCount} {automation.stepCount === 1 ? "step" : "steps"} ·{" "}
                  {automation.owner.name}
                  {automation.runAs && automation.runAs.id !== automation.owner.id
                    ? ` · runs as ${automation.runAs.name}`
                    : ""}
                </span>
              </span>
              {automation.statusReason ? (
                <span className="mt-1 block text-xs text-danger">{automation.statusReason}</span>
              ) : null}
            </TD>
            <TD className="text-sm">
              {automation.triggerTitle}
              {automation.nextRunAt ? (
                <span className="block text-xs text-muted-foreground">
                  Next: {formatDateTime(automation.nextRunAt)}
                </span>
              ) : null}
            </TD>
            <TD className="text-sm">
              {automation.lastRunStatus ? (
                <>
                  <Badge tone={runStatusTone(automation.lastRunStatus)}>
                    {RUN_STATUS_LABELS[automation.lastRunStatus]}
                  </Badge>
                  {automation.lastRunAt ? (
                    <span
                      className="block text-xs text-muted-foreground"
                      title={formatDateTime(automation.lastRunAt)}
                    >
                      {formatRelative(new Date(automation.lastRunAt))}
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="text-muted-foreground">Never</span>
              )}
            </TD>
            <TD className="text-right text-sm tabular-nums">{automation.runsToday}</TD>
            {data.canManage ? (
              <TD className="w-px" onClick={(event) => event.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Actions for ${automation.name}`}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onOpen(automation.id)}>Open</DropdownMenuItem>
                    <DropdownMenuItem destructive onSelect={() => onDelete(automation)}>
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TD>
            ) : null}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

/** Runs waiting for this person's decision, with Approve and Decline right here. */
function ApprovalsWaiting({
  approvals,
  onDecided,
}: {
  approvals: ApprovalWaiting[];
  onDecided: () => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (approval: ApprovalWaiting, decision: "approved" | "rejected") => {
    setBusy(`${approval.id}:${decision}`);
    try {
      await api.automations.decideApproval({
        runId: approval.runId,
        approvalId: approval.id,
        decision,
      });
      toast(decision === "approved" ? "Approved. The run continues." : "Declined. The run stops.", {
        description: approval.automationName,
        tone: "success",
      });
      onDecided();
    } catch (failure) {
      toast("Couldn't record the decision", { description: errorMessage(failure), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section title="Approvals waiting" description="Runs that wait for you before they continue.">
      <div className="grid gap-2">
        {approvals.map((approval) => (
          <Alert
            key={approval.id}
            tone="warning"
            title={
              <Link
                to={`/automations/${approval.automationId}?tab=runs&run=${approval.runId}`}
                className="underline-offset-2 hover:underline"
              >
                {approval.automationName}
              </Link>
            }
            action={
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === `${approval.id}:approved`}
                  disabled={busy !== null}
                  onClick={() => void decide(approval, "approved")}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  loading={busy === `${approval.id}:rejected`}
                  disabled={busy !== null}
                  onClick={() => void decide(approval, "rejected")}
                >
                  Decline
                </Button>
              </div>
            }
          >
            <span className="whitespace-pre-wrap">{approval.message}</span>
            <span className="block text-xs">{formatDateTime(approval.createdAt)}</span>
          </Alert>
        ))}
      </div>
    </Section>
  );
}
