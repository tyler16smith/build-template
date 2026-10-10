import {
  flattenSteps,
  replaceStepList,
  stepListAt,
  updateStep,
  type AutomationCatalog,
  type AutomationDefinition,
  type AutomationIssue,
  type AutomationStep,
  type DefinitionDiff,
  type StepListRef,
  type StepRunStatus,
} from "@template/contracts";
import { Badge, Button, Card, cn } from "@template/ui";
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  CircleAlert,
  Plus,
  Trash2,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { useState } from "react";
import {
  blankStep,
  describeStep,
  describeTrigger,
  issuesFor,
  STEP_KIND_LABELS,
  STEP_STATUS_LABELS,
  stepStatusTone,
} from "./model";
import { CatalogPicker, decodeStepChoice, STEP_ICONS, stepItems } from "./pickers";

export type Selection = { kind: "trigger" } | { kind: "step"; id: string } | null;

function IssueBadges({ issues }: { issues: AutomationIssue[] }) {
  const errors = issues.filter((i) => i.severity === "error" && !i.incomplete).length;
  const todo = issues.filter((i) => i.severity === "error" && i.incomplete).length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  return (
    <>
      {errors ? (
        <Badge tone="danger">
          <CircleAlert aria-hidden /> {errors} to fix
        </Badge>
      ) : null}
      {todo ? <Badge tone="info">needs setup</Badge> : null}
      {warnings ? (
        <Badge tone="warning">
          <TriangleAlert aria-hidden /> {warnings}
        </Badge>
      ) : null}
    </>
  );
}

function Connector() {
  return <div aria-hidden className="mx-auto h-4 w-px bg-border-strong/60" />;
}

type Adding = { ref: StepListRef; at: number } | null;

/**
 * The workflow drawn from the same definition the runtime executes: the trigger, then each step
 * in execution order. If / otherwise shows its two paths side by side; For each shows the steps
 * it repeats inside it. Every gap has a + that opens a searchable list of steps.
 */
export function FlowEditor({
  definition,
  catalog,
  issues,
  selection,
  onSelect,
  onChange,
  recentDiff,
  editable,
  stepStatuses,
}: {
  definition: AutomationDefinition;
  catalog: AutomationCatalog;
  issues: AutomationIssue[];
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onChange: (next: AutomationDefinition) => void;
  recentDiff: DefinitionDiff | null;
  editable: boolean;
  /** Each step's status in the latest test, shown on its card. */
  stepStatuses?: Record<string, { status: StepRunStatus; simulated: boolean }>;
}) {
  const [adding, setAdding] = useState<Adding>(null);
  const changedIds = new Set(
    [...(recentDiff?.added ?? []), ...(recentDiff?.changed ?? [])].map((s) => s.id),
  );
  const flat = flattenSteps(definition.steps);
  const insideLoop = (ref: StepListRef) => {
    if (!ref.parentId) return false;
    const parent = flat.find((f) => f.step.id === ref.parentId);
    return parent?.step.kind === "forEach" || Boolean(parent?.loopId);
  };

  const setList = (ref: StepListRef, list: AutomationStep[]) =>
    onChange({ ...definition, steps: replaceStepList(definition.steps, ref, list) });
  const move = (ref: StepListRef, index: number, delta: number) => {
    const list = [...stepListAt(definition.steps, ref)];
    const [step] = list.splice(index, 1);
    if (!step) return;
    list.splice(index + delta, 0, step);
    setList(ref, list);
  };
  const remove = (id: string) => {
    onChange({ ...definition, steps: updateStep(definition.steps, id, () => null) });
    if (selection?.kind === "step" && selection.id === id) onSelect(null);
  };
  const add = (pickedId: string) => {
    if (!adding) return;
    const choice = decodeStepChoice(pickedId);
    const step = blankStep(
      choice.kind,
      definition,
      catalog,
      choice.kind === "action" ? choice.actionId : undefined,
    );
    const list = [...stepListAt(definition.steps, adding.ref)];
    list.splice(adding.at, 0, step);
    setList(adding.ref, list);
    onSelect({ kind: "step", id: step.id });
  };

  const addButton = (ref: StepListRef, at: number, label: string) =>
    editable ? (
      <div className="flex justify-center">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={() => setAdding({ ref, at })}
          className="rounded-full border border-dashed border-border-strong/60 bg-surface"
        >
          <Plus />
        </Button>
      </div>
    ) : null;

  const renderList = (steps: AutomationStep[], ref: StepListRef, where: string) => (
    <ol className="grid gap-0" aria-label={where}>
      {steps.map((step, index) => (
        <li key={step.id}>
          {index === 0 && ref.parentId ? null : <Connector />}
          {addButton(ref, index, `Add a step before ${step.name}`)}
          {editable ? <Connector /> : null}
          {renderStep(step, ref, index, steps.length)}
        </li>
      ))}
      <li>
        {steps.length || !ref.parentId ? <Connector /> : null}
        {addButton(
          ref,
          steps.length,
          steps.length ? `Add a step at the end of ${where}` : `Add the first step to ${where}`,
        )}
        {steps.length === 0 && !ref.parentId ? (
          <p className="mt-2 text-center text-sm text-muted-foreground">
            {editable ? "Add a step, or describe what should happen in the chat." : "No steps yet."}
          </p>
        ) : null}
      </li>
    </ol>
  );

  const renderStep = (step: AutomationStep, ref: StepListRef, index: number, count: number) => {
    const Icon = STEP_ICONS[step.kind];
    const selected = selection?.kind === "step" && selection.id === step.id;
    const result = stepStatuses?.[step.id];
    const card = (
      <Card
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => onSelect({ kind: "step", id: step.id })}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
            e.preventDefault();
            onSelect({ kind: "step", id: step.id });
          }
        }}
        className={cn(
          "min-w-0 cursor-pointer p-3 transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-ring",
          selected && "ring-2 ring-primary",
          changedIds.has(step.id) && !selected && "ring-2 ring-info/60",
        )}
      >
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-md",
              step.kind === "approval" || step.kind === "delay"
                ? "bg-warning-soft text-warning"
                : ["condition", "map", "branch", "forEach"].includes(step.kind)
                  ? "bg-muted text-muted-foreground"
                  : "bg-info-soft text-info",
            )}
          >
            <Icon aria-hidden className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {STEP_KIND_LABELS[step.kind]}
              </p>
              {step.runIf?.length ? <Badge tone="outline">conditional</Badge> : null}
              {changedIds.has(step.id) ? <Badge tone="info">changed</Badge> : null}
              {result ? (
                <Badge tone={stepStatusTone(result.status)}>
                  Test: {STEP_STATUS_LABELS[result.status]}
                  {result.simulated && result.status !== "simulated" ? " (simulated)" : ""}
                </Badge>
              ) : null}
              <IssueBadges issues={issuesFor(issues, step.id)} />
            </div>
            <p className="truncate text-sm font-medium">{step.name}</p>
            <p className="truncate text-xs text-muted-foreground">{describeStep(step, catalog)}</p>
          </div>
          {editable ? (
            <div
              className="flex shrink-0 flex-col gap-0.5 sm:flex-row"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move ${step.name} up`}
                disabled={index === 0}
                onClick={() => move(ref, index, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move ${step.name} down`}
                disabled={index === count - 1}
                onClick={() => move(ref, index, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${step.name}`}
                onClick={() => remove(step.id)}
              >
                <Trash2 />
              </Button>
            </div>
          ) : null}
        </div>
      </Card>
    );
    if (step.kind === "branch")
      return (
        <div className="grid gap-0">
          {card}
          <Connector />
          <div className="grid gap-3 rounded-xl border border-dashed border-border-strong/60 p-2 sm:p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            {(["then", "else"] as const).map((key) => (
              <section
                key={key}
                aria-label={`${step.name}: ${key === "then" ? "if yes" : "otherwise"}`}
                className="grid min-w-0 content-start gap-2 rounded-lg bg-surface-sunken p-2"
              >
                <p className="text-center text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {key === "then" ? "If yes" : "Otherwise"}
                </p>
                {renderList(
                  step[key],
                  { parentId: step.id, key },
                  `${step.name}, ${key === "then" ? "if yes" : "otherwise"}`,
                )}
              </section>
            ))}
          </div>
        </div>
      );
    if (step.kind === "forEach")
      return (
        <div className="grid gap-0">
          {card}
          <Connector />
          <section
            aria-label={`${step.name}: repeated steps`}
            className="grid min-w-0 gap-2 rounded-xl border border-dashed border-border-strong/60 bg-surface-sunken p-2 sm:p-3"
          >
            <p className="text-center text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              For each item
            </p>
            {renderList(step.steps, { parentId: step.id, key: "steps" }, `${step.name}, each item`)}
          </section>
        </div>
      );
    return card;
  };

  const triggerIssues = issuesFor(issues, null);
  return (
    <div className="grid gap-0">
      <Card
        role="button"
        tabIndex={0}
        aria-pressed={selection?.kind === "trigger"}
        onClick={() => onSelect({ kind: "trigger" })}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect({ kind: "trigger" });
          }
        }}
        className={cn(
          "cursor-pointer p-3 transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-ring",
          selection?.kind === "trigger" && "ring-2 ring-primary",
          recentDiff?.triggerChanged && selection?.kind !== "trigger" && "ring-2 ring-info/60",
        )}
      >
        <div className="flex items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/12 text-primary">
            {definition.trigger.kind === "schedule" ? (
              <CalendarClock aria-hidden className="size-4" />
            ) : (
              <Zap aria-hidden className="size-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                When
              </p>
              {recentDiff?.triggerChanged ? <Badge tone="info">changed</Badge> : null}
              <IssueBadges issues={triggerIssues} />
            </div>
            <p className="text-sm font-medium">{describeTrigger(definition.trigger, catalog)}</p>
          </div>
        </div>
      </Card>
      {renderList(definition.steps, { parentId: null, key: null }, "Workflow steps")}
      <CatalogPicker
        open={adding !== null}
        onOpenChange={(open) => !open && setAdding(null)}
        title="Add a step"
        description="Search actions, logic and built-in steps."
        placeholder="Search steps, e.g. update profile, wait, email, AI"
        items={adding ? stepItems(catalog, { insideLoop: insideLoop(adding.ref) }) : []}
        onPick={add}
      />
    </div>
  );
}
