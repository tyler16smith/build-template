import { ApiClientError } from "@template/api-client";
import {
  automationDefinitionSchema,
  describeDiff,
  findStep,
  flattenSteps,
  updateStep,
  type AutomationDefinition,
  type AutomationIssue,
  type RunView,
  type StepRunStatus,
} from "@template/contracts";
import {
  Alert,
  Badge,
  Button,
  Card,
  ErrorState,
  Input,
  LoadingState,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "@template/ui";
import { ArrowLeft, FlaskConical, Pause, Play, Rocket, Save, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAssistantPageContext } from "../assistant/assistant";
import { errorMessage, queryParam, useApi, useNav, useSession } from "../context";
import { AutomationChat, type SavedDraft } from "./automation-chat";
import { FlowEditor, type Selection } from "./flow-editor";
import {
  AUTOMATION_STATUS_LABELS,
  automationStatusTone,
  describeTrigger,
  issuesFor,
  STEP_KIND_LABELS,
  type RecentChange,
} from "./model";
import {
  LiveTestDialog,
  ManualRunDialog,
  PublishDialog,
  RunsPanel,
  TestPanel,
  VersionsPanel,
  WebhookPanel,
} from "./panels";
import { StepEditor, TriggerEditor } from "./step-editor";
import { useLoad } from "../use-load";

const TABS = ["workflow", "test", "runs", "versions"] as const;
type Tab = (typeof TABS)[number];

/** Problems the definition's own schema finds, for unsaved edits (the server re-checks on save). */
export function schemaIssues(definition: AutomationDefinition): AutomationIssue[] {
  const parsed = automationDefinitionSchema.safeParse(definition);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const dotted = issue.path.map(String).join(".");
    // The innermost step whose path the problem sits under.
    const owner = flattenSteps(definition.steps)
      .filter((f) => dotted === f.path || dotted.startsWith(`${f.path}.`))
      .pop();
    return {
      severity: "error" as const,
      message: issue.message,
      path: dotted,
      ...(owner ? { stepId: owner.step.id } : {}),
    };
  });
}

/** A path with some query parameters changed (null removes one). */
function withQuery(path: string, patch: Record<string, string | null>): string {
  const [pathname, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  for (const [key, value] of Object.entries(patch))
    if (value === null) params.delete(key);
    else params.set(key, value);
  const next = params.toString();
  return `${pathname}${next ? `?${next}` : ""}`;
}

function IssueList({
  issues,
  onSelect,
}: {
  issues: AutomationIssue[];
  onSelect: (selection: Selection) => void;
}) {
  const nav = useNav();
  if (!issues.length) return null;
  const errors = issues.filter((i) => i.severity === "error" && !i.incomplete).length;
  const todo = issues.filter((i) => i.severity === "error" && i.incomplete).length;
  return (
    <Alert
      tone={errors ? "danger" : todo ? "info" : "warning"}
      title={
        errors
          ? `${errors} problem${errors === 1 ? "" : "s"} to fix before publishing`
          : todo
            ? "Before you can publish"
            : "Warnings"
      }
    >
      <ul className="grid gap-1">
        {issues.map((issue, index) => (
          <li key={index} className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="text-left underline-offset-2 hover:underline"
              onClick={() =>
                onSelect(
                  issue.stepId
                    ? { kind: "step", id: issue.stepId }
                    : issue.path?.startsWith("trigger")
                      ? { kind: "trigger" }
                      : null,
                )
              }
            >
              {issue.severity === "warning" ? "Warning: " : ""}
              {issue.message}
            </button>
            {issue.fix?.kind === "zapier" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => nav.navigate("/automations/zapier")}
              >
                {issue.fix.direction === "inbound" ? "Set up Zapier" : "Add a Zapier hook"}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/**
 * `/automations/:id`: the Builder chat on the left, the workflow on the right with the selected
 * card's settings, and tabs for tests, runs and versions (`?tab=runs&run=<id>`). People who can't
 * manage automations see all of it read-only.
 */
export function AutomationEditorScreen({ automationId }: { automationId: string }) {
  const api = useApi();
  const nav = useNav();
  const { session } = useSession();
  const detail = useLoad(() => api.automations.get({ automationId }), automationId, {
    pollMs: 15_000,
  });

  const [baseline, setBaseline] = useState<{
    revision: number;
    definition: AutomationDefinition;
  } | null>(null);
  const [working, setWorking] = useState<AutomationDefinition | null>(null);
  const [selection, setSelection] = useState<Selection>(
    queryParam(nav.path, "select") === "trigger" ? { kind: "trigger" } : null,
  );
  const [recentChange, setRecentChange] = useState<RecentChange | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [manualRun, setManualRun] = useState(false);
  const [liveTest, setLiveTest] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [lastTest, setLastTest] = useState<RunView | null>(null);
  const [testing, setTesting] = useState(false);
  const [startedRun, setStartedRun] = useState<string | null>(null);

  const rawTab = queryParam(nav.path, "tab");
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "")
    ? (rawTab as Tab)
    : "workflow";
  const runId = queryParam(nav.path, "run");
  const initialPrompt = queryParam(nav.path, "prompt");
  const setQuery = useCallback(
    (patch: Record<string, string | null>) =>
      nav.navigate(withQuery(nav.path, patch), { replace: true }),
    [nav],
  );

  const data = detail.data;
  const dirty = Boolean(
    working && baseline && JSON.stringify(working) !== JSON.stringify(baseline.definition),
  );
  const savedRevision = data?.automation.draftRevision ?? null;
  const staleEdits =
    dirty && baseline !== null && savedRevision !== null && savedRevision !== baseline.revision;

  useAssistantPageContext(
    {
      title: data ? `Automation: ${data.automation.name}` : "Automation",
      summary: data
        ? `${AUTOMATION_STATUS_LABELS[data.automation.status]}, ${describeTrigger(data.draft.trigger, data.catalog)}, ${flattenSteps(data.draft.steps).length} steps`
        : undefined,
      ...(data
        ? {
            selection: {
              type: "automation",
              id: data.automation.id,
              name: data.automation.name.slice(0, 120),
            },
          }
        : {}),
    },
    2,
  );

  useEffect(() => {
    if (!data) return;
    if (!baseline || (!dirty && baseline.revision !== data.automation.draftRevision)) {
      setBaseline({ revision: data.automation.draftRevision, definition: data.draft });
      setWorking(data.draft);
    }
  }, [data, baseline, dirty]);

  const refetch = detail.refetch;
  const onDraftSaved = useCallback(
    (saved: SavedDraft) => {
      setRecentChange({
        revision: saved.revision,
        summary: saved.summary,
        diff: saved.diff,
        source: "chat",
      });
      setLastTest(null);
      void refetch();
    },
    [refetch],
  );
  const onInitialPromptSent = useCallback(() => setQuery({ prompt: null }), [setQuery]);

  const issues = useMemo(() => {
    if (!working || !data) return [];
    if (!dirty) return data.issues;
    const shapeIssues = schemaIssues(working);
    if (shapeIssues.length) return shapeIssues;
    const stepIds = new Set(flattenSteps(working.steps).map((f) => f.step.id));
    return data.issues.filter((i) => !i.stepId || stepIds.has(i.stepId));
  }, [working, dirty, data]);

  if (detail.loading || (data && !working)) return <LoadingState className="min-h-dvh" />;
  if (!data || !working || !baseline)
    return (
      <div className="p-6">
        <h1 className="sr-only">Automation</h1>
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  const editable = data.canManage;
  const status = data.automation.status;

  const save = async (baseRevision: number) => {
    setSaving(true);
    try {
      const result = await api.automations.saveDraft({
        automationId,
        baseRevision,
        definition: working,
      });
      setRecentChange({
        revision: result.revision,
        summary: result.summary,
        diff: result.diff,
        source: "ui",
      });
      setBaseline({ revision: result.revision, definition: working });
      setLastTest(null);
      await detail.refetch();
    } catch (failure) {
      if (failure instanceof ApiClientError && failure.status === 409) {
        toast("The draft changed while you were editing", {
          description: "Load the latest version, or save yours over it.",
        });
        await detail.refetch();
      } else {
        toast("Not saved", { description: errorMessage(failure), tone: "danger" });
      }
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setWorking(data.draft);
    setBaseline({ revision: data.automation.draftRevision, definition: data.draft });
  };

  const undoRecent = async () => {
    if (!recentChange) return;
    setUndoing(true);
    try {
      await api.automations.restore({
        automationId,
        revision: recentChange.revision - 1,
        baseRevision: recentChange.revision,
      });
      setRecentChange(null);
      toast(`Undone: back to revision ${recentChange.revision - 1}`);
      await detail.refetch();
    } catch (failure) {
      toast("Couldn't undo", { description: errorMessage(failure), tone: "danger" });
    } finally {
      setUndoing(false);
    }
  };

  const togglePause = async () => {
    const pause = status === "active";
    setPausing(true);
    try {
      await api.automations.setPaused({ automationId, paused: pause });
      toast(pause ? "Paused. New triggers are ignored." : "Resumed", { tone: "success" });
      await detail.refetch();
    } catch (failure) {
      toast(pause ? "Couldn't pause" : "Couldn't resume", {
        description: errorMessage(failure),
        tone: "danger",
      });
    } finally {
      setPausing(false);
    }
  };

  const openRun = (id: string) => {
    setStartedRun(id);
    setQuery({ tab: "runs", run: id });
  };

  const selectStep = (stepId: string) => {
    setSelection(stepId === "trigger" ? { kind: "trigger" } : { kind: "step", id: stepId });
    setQuery({ tab: null, run: null });
  };

  const quickTest = async () => {
    setTesting(true);
    try {
      const run = await api.automations.simulate({ automationId });
      setLastTest(run);
      const failed = run.steps.find((s) => s.status === "failed");
      toast(
        run.status === "succeeded"
          ? "Test passed with sample data"
          : `The test ${run.status === "failed" ? "failed" : "stopped"}`,
        {
          description: failed
            ? `${failed.name}: ${failed.error ?? "failed"}`
            : "Each step shows what it did. Nothing was changed or sent.",
          tone: run.status === "succeeded" ? "success" : "danger",
        },
      );
    } catch (failure) {
      toast("The test didn't run", { description: errorMessage(failure), tone: "danger" });
    } finally {
      setTesting(false);
    }
  };

  const selectedStep =
    selection?.kind === "step" ? findStep(working.steps, selection.id) : undefined;
  const stepStatuses: Record<string, { status: StepRunStatus; simulated: boolean }> | undefined =
    lastTest && !dirty
      ? Object.fromEntries(
          lastTest.steps
            .filter((s) => s.kind !== "trigger")
            .map((s) => [s.stepId, { status: s.status, simulated: s.simulated }]),
        )
      : undefined;
  const hasErrors = data.issues.some((i) => i.severity === "error");
  const canResume =
    status === "paused" || (status === "failed" && data.automation.activeVersion !== null);
  const recentChangeDiff = recentChange ? describeDiff(recentChange.diff) : "no changes";
  const recentChangeText =
    recentChangeDiff === "no changes" ? "" : recentChangeDiff.replace(/^./, (c) => c.toUpperCase());

  return (
    <div
      data-fill-screen
      className="grid min-h-dvh grid-cols-1 lg:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]"
    >
      <h1 className="sr-only">{working.name}</h1>
      <aside
        className="border-b border-border lg:sticky lg:top-0 lg:h-dvh lg:border-r lg:border-b-0"
        aria-label="Automation Builder chat"
      >
        <div className="h-[28rem] lg:h-full">
          <AutomationChat
            automationId={automationId}
            onDraftSaved={onDraftSaved}
            canEdit={editable}
            initialPrompt={editable ? initialPrompt : null}
            onInitialPromptSent={onInitialPromptSent}
          />
        </div>
      </aside>
      <div className="grid min-w-0 content-start gap-5 px-4 py-5 sm:px-6">
        <div className="grid gap-3">
          <Button
            variant="link"
            size="sm"
            className="justify-self-start px-0"
            onClick={() => nav.navigate("/automations")}
          >
            <ArrowLeft /> Automations
          </Button>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid min-w-0 flex-1 gap-1">
              <Input
                aria-label="Automation name"
                value={working.name}
                onChange={(e) => setWorking({ ...working, name: e.target.value })}
                readOnly={!editable}
                className="h-auto border-transparent px-1 text-xl font-semibold shadow-none hover:border-border focus-visible:border-border"
              />
              <div className="flex flex-wrap items-center gap-2 px-1 text-sm text-muted-foreground">
                <Badge tone={automationStatusTone(status)}>
                  {AUTOMATION_STATUS_LABELS[status]}
                </Badge>
                {data.automation.activeVersion ? (
                  <Badge tone="outline">v{data.automation.activeVersion} live</Badge>
                ) : null}
                <span>Draft r{data.automation.draftRevision}</span>
                {data.automation.activeVersion && !data.draftMatchesActive ? (
                  <Badge tone="info">unpublished changes</Badge>
                ) : null}
                <span>· owner {data.automation.owner.name}</span>
                {data.automation.runAs ? <span>· runs as {data.automation.runAs.name}</span> : null}
                {!editable ? <Badge tone="neutral">View only</Badge> : null}
              </div>
            </div>
            {editable ? (
              <div className="flex flex-wrap gap-2">
                {dirty ? (
                  <>
                    <Button variant="ghost" onClick={discard} disabled={saving}>
                      Discard
                    </Button>
                    <Button loading={saving} onClick={() => void save(baseline.revision)}>
                      <Save /> Save draft
                    </Button>
                  </>
                ) : (
                  <Button
                    onClick={() => setPublishing(true)}
                    disabled={hasErrors || data.draftMatchesActive}
                  >
                    <Rocket />{" "}
                    {data.automation.activeVersion ? "Publish changes" : "Review and publish"}
                  </Button>
                )}
                {status === "active" && data.activeDefinition?.trigger.kind === "manual" ? (
                  <Button variant="outline" onClick={() => setManualRun(true)}>
                    <Play /> Run now
                  </Button>
                ) : null}
                {status === "active" ? (
                  <Button variant="outline" loading={pausing} onClick={() => void togglePause()}>
                    <Pause /> Pause
                  </Button>
                ) : canResume ? (
                  <Button variant="outline" loading={pausing} onClick={() => void togglePause()}>
                    <Play /> Resume
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          {data.automation.statusReason ? (
            <Alert
              tone={status === "failed" ? "danger" : "warning"}
              title={status === "failed" ? "Stopped" : "Paused"}
            >
              {data.automation.statusReason}
            </Alert>
          ) : null}
          {staleEdits ? (
            <Alert
              tone="warning"
              title="The draft changed while you were editing"
              action={
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={discard}>
                    Load latest
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void save(data.automation.draftRevision)}
                  >
                    Save mine over it
                  </Button>
                </div>
              }
            >
              Someone (or the Builder) saved revision {data.automation.draftRevision}. Your unsaved
              edits are based on r{baseline.revision}.
            </Alert>
          ) : null}
          {recentChange && !dirty ? (
            <Alert
              tone="info"
              title={`${recentChange.source === "chat" ? "The Builder" : "You"} saved revision ${recentChange.revision}`}
              action={
                <div className="flex gap-2">
                  {editable &&
                  recentChange.revision === data.automation.draftRevision &&
                  recentChange.revision > 1 ? (
                    <Button
                      size="sm"
                      variant="outline"
                      loading={undoing}
                      onClick={() => void undoRecent()}
                    >
                      <Undo2 /> Undo
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => setRecentChange(null)}>
                    Dismiss
                  </Button>
                </div>
              }
            >
              {recentChange.summary ? `${recentChange.summary}. ` : ""}
              {recentChangeText ? `${recentChangeText}. Changed steps are highlighted.` : ""}
            </Alert>
          ) : null}
        </div>

        <Tabs
          value={tab}
          onValueChange={(value) => setQuery({ tab: value === "workflow" ? null : value })}
        >
          <TabsList>
            <TabsTrigger value="workflow">Workflow</TabsTrigger>
            <TabsTrigger value="test">Test</TabsTrigger>
            <TabsTrigger value="runs">Runs</TabsTrigger>
            <TabsTrigger value="versions">Versions</TabsTrigger>
          </TabsList>
          <TabsContent value="workflow" className="grid gap-4 pt-4">
            <IssueList issues={issues} onSelect={setSelection} />
            {dirty ? (
              <Alert tone="info">
                You have unsaved changes; problems shown are from the last save plus a shape check.
                Save to re-check references, permissions and connections.
              </Alert>
            ) : null}
            {working.steps.length && editable ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {stepStatuses ? (
                  <Button variant="ghost" size="sm" onClick={() => setLastTest(null)}>
                    Clear test results
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  loading={testing}
                  disabled={dirty}
                  onClick={() => void quickTest()}
                >
                  <FlaskConical /> Test with sample data
                </Button>
                {editable ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={dirty || hasErrors}
                    onClick={() => setLiveTest(true)}
                  >
                    Live test…
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
              <FlowEditor
                definition={working}
                catalog={data.catalog}
                issues={issues}
                selection={selection}
                onSelect={setSelection}
                onChange={setWorking}
                recentDiff={recentChange && !dirty ? recentChange.diff : null}
                editable={editable}
                stepStatuses={stepStatuses}
              />
              <Card className="h-fit p-4 xl:sticky xl:top-4">
                {selection?.kind === "trigger" ? (
                  <div className="grid gap-4">
                    <h2 className="text-sm font-semibold">Trigger</h2>
                    <TriggerEditor
                      trigger={working.trigger}
                      onChange={(trigger) => setWorking({ ...working, trigger })}
                      catalog={data.catalog}
                      definition={working}
                      disabled={!editable}
                      extra={
                        working.trigger.kind === "webhook" ? (
                          <WebhookPanel key={data.webhook?.url ?? "none"} detail={data} />
                        ) : working.trigger.kind === "zapier.event" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="justify-self-start"
                            onClick={() => nav.navigate("/automations/zapier")}
                          >
                            Zapier setup, URL and events
                          </Button>
                        ) : null
                      }
                    />
                    <IssueList issues={issuesFor(issues, null)} onSelect={setSelection} />
                  </div>
                ) : selectedStep ? (
                  <div className="grid gap-4">
                    <h2 className="text-sm font-semibold">{STEP_KIND_LABELS[selectedStep.kind]}</h2>
                    <StepEditor
                      key={selectedStep.id}
                      step={selectedStep}
                      definition={working}
                      catalog={data.catalog}
                      disabled={!editable}
                      onChange={(next) =>
                        setWorking({
                          ...working,
                          steps: updateStep(working.steps, selectedStep.id, () => next),
                        })
                      }
                    />
                    <IssueList
                      issues={issuesFor(issues, selectedStep.id)}
                      onSelect={setSelection}
                    />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Select the trigger or a step to see {editable ? "and edit " : ""}its settings.
                    Everything here is the same definition the Builder edits and the runtime runs.
                  </p>
                )}
              </Card>
            </div>
          </TabsContent>
          <TabsContent value="test" className="pt-4">
            <TestPanel
              detail={data}
              dirty={dirty}
              onLiveStarted={openRun}
              onFixStep={selectStep}
              onSimulated={setLastTest}
            />
          </TabsContent>
          <TabsContent value="runs" className="pt-4">
            <RunsPanel
              detail={data}
              selectedRunId={runId}
              onSelect={(id) => setQuery({ tab: "runs", run: id })}
              onFixStep={selectStep}
              refreshKey={startedRun ?? undefined}
            />
          </TabsContent>
          <TabsContent value="versions" className="pt-4">
            <VersionsPanel
              detail={data}
              dirty={dirty}
              onRestored={() => {
                setRecentChange(null);
                void detail.refetch();
              }}
            />
          </TabsContent>
        </Tabs>
      </div>
      {publishing ? (
        <PublishDialog
          open={publishing}
          onOpenChange={setPublishing}
          detail={data}
          userName={session?.profile?.name ?? "you"}
          onPublished={() => void detail.refetch()}
        />
      ) : null}
      <ManualRunDialog
        open={manualRun}
        onOpenChange={setManualRun}
        detail={data}
        onStarted={openRun}
      />
      {editable ? (
        <LiveTestDialog
          open={liveTest}
          onOpenChange={setLiveTest}
          detail={data}
          onStarted={openRun}
        />
      ) : null}
    </div>
  );
}
