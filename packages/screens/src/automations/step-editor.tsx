import {
  AI_FIELD_TYPES,
  CONDITION_OPERATORS,
  DELAY_UNITS,
  describeSchedule,
  HTTP_METHODS,
  nextScheduledRun,
  normalizeEventName,
  TEMPLATE_HELPERS,
  TRIGGER_FIELD_TYPES,
  validTimeZone,
  type Approvers,
  type AutomationCatalog,
  type AutomationDefinition,
  type AutomationStep,
  type AutomationTrigger,
  type CatalogTrigger,
  type Condition,
  type ConditionOperator,
  type JsonValue,
  type Role,
  type ScheduleTrigger,
  type TriggerField,
} from "@template/contracts";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Combobox,
  Field,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  Switch,
  Textarea,
  toast,
} from "@template/ui";
import { Braces, Plus, Search, Send, Trash2, Zap } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { errorMessage, useApi, useNav } from "../context";
import { availablePaths, describeTrigger, type PathGroup } from "./model";
import { CatalogPicker, triggerItems } from "./pickers";

type Paths = PathGroup[];

/** A searchable list of the values this step can use; picking one inserts `{{ path }}`. */
function DataPicker({
  paths,
  onPick,
  label,
  disabled,
}: {
  paths: Paths;
  onPick: (path: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const needle = query.trim().toLowerCase();
  const shown = paths
    .map((group) => ({
      ...group,
      paths: group.paths.filter(
        (p) =>
          !needle ||
          p.path.toLowerCase().includes(needle) ||
          (p.description ?? "").toLowerCase().includes(needle) ||
          group.group.toLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.paths.length);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          aria-label={`Insert data into ${label}`}
          disabled={disabled}
        >
          <Braces />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-96 max-w-[90vw] gap-2 p-2">
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            autoFocus
            aria-label="Search data"
            placeholder="Search data from the trigger and earlier steps"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <div className="max-h-72 overflow-y-auto">
          {shown.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">Nothing matches.</p>
          ) : (
            shown.map((group) => (
              <div key={group.group} className="mb-2">
                <p className="px-1 text-xs font-semibold text-muted-foreground">{group.group}</p>
                {group.paths.map((p) => {
                  const leaf = p.path.split(".").slice(-2).join(" › ");
                  return (
                    <button
                      key={p.path}
                      type="button"
                      onClick={() => {
                        onPick(p.path);
                        setOpen(false);
                        setQuery("");
                      }}
                      title={p.path}
                      className="grid w-full gap-0 rounded px-1 py-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <span className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate font-medium">{leaf}</span>
                        <span className="shrink-0 text-muted-foreground">{p.type}</span>
                      </span>
                      {p.description ? (
                        <span className="truncate text-[11px] text-muted-foreground">
                          {p.description}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <p className="px-1 text-[11px] text-muted-foreground">
          Transform with helpers: {TEMPLATE_HELPERS.join(", ")}, e.g.{" "}
          {"{{run.startedAt | addDays:2}}"}
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** A text input that accepts `{{ path }}` templates, with a picker for the data this step can use. */
function TemplateInput({
  label,
  value,
  onChange,
  paths,
  multiline,
  hint,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  paths: Paths;
  multiline?: boolean;
  hint?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const insert = (path: string) => {
    const token = `{{${path}}}`;
    const element = multiline ? areaRef.current : inputRef.current;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    onChange(`${value.slice(0, start)}${token}${value.slice(end)}`);
  };
  const control = multiline ? (
    <Textarea
      ref={areaRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={4}
      className="font-mono text-xs"
      disabled={disabled}
      placeholder={placeholder}
    />
  ) : (
    <Input
      ref={inputRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="font-mono text-xs"
      disabled={disabled}
      placeholder={placeholder}
    />
  );
  return (
    <div className="flex items-end gap-1">
      <Field label={label} hint={hint} className="min-w-0 flex-1">
        {control}
      </Field>
      <DataPicker paths={paths} onPick={insert} label={label} disabled={disabled} />
    </div>
  );
}

const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  equals: "is",
  notEquals: "is not",
  contains: "contains",
  notContains: "doesn't contain",
  in: "is one of",
  exists: "is set",
  notExists: "is empty",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  matches: "matches pattern",
};

function conditionValue(op: ConditionOperator, raw: string): JsonValue {
  if (op === "in")
    return raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  if (["gt", "gte", "lt", "lte"].includes(op) && raw.trim() !== "" && !Number.isNaN(Number(raw)))
    return Number(raw);
  return raw;
}

function ConditionsEditor({
  conditions,
  onChange,
  paths,
  disabled,
  addLabel = "Add condition",
}: {
  conditions: Condition[];
  onChange: (next: Condition[]) => void;
  paths: Paths;
  disabled?: boolean;
  addLabel?: string;
}) {
  const options = paths.flatMap((g) =>
    g.paths.map((p) => ({
      value: p.path,
      label: p.path,
      group: g.group,
      keywords: [p.description ?? ""],
    })),
  );
  return (
    <div className="grid gap-2">
      {conditions.map((condition, index) => {
        const set = (patch: Partial<Condition>) =>
          onChange(conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)));
        const known = options.some((o) => o.value === condition.path);
        return (
          <div
            key={index}
            className="grid grid-cols-1 items-center gap-1 rounded-md border border-border p-2 sm:grid-cols-[1fr_9rem_1fr_auto] sm:border-0 sm:p-0"
          >
            <Combobox
              aria-label="Value to check"
              value={condition.path}
              onValueChange={(path) => path && set({ path })}
              options={
                known ? options : [{ value: condition.path, label: condition.path }, ...options]
              }
              placeholder="Choose data"
              disabled={disabled}
            />
            <Select
              aria-label="Comparison"
              value={condition.op}
              onValueChange={(op) =>
                set({
                  op: op as ConditionOperator,
                  value: conditionValue(
                    op as ConditionOperator,
                    Array.isArray(condition.value)
                      ? condition.value.join(", ")
                      : String(condition.value ?? ""),
                  ),
                })
              }
              options={CONDITION_OPERATORS.map((op) => ({ value: op, label: OPERATOR_LABELS[op] }))}
              disabled={disabled}
            />
            <Input
              aria-label="Compared with"
              placeholder={condition.op === "in" ? "a, b, c" : "value or {{data}}"}
              value={
                condition.value === undefined || condition.value === null
                  ? ""
                  : Array.isArray(condition.value)
                    ? condition.value.join(", ")
                    : typeof condition.value === "string"
                      ? condition.value
                      : JSON.stringify(condition.value)
              }
              onChange={(e) => set({ value: conditionValue(condition.op, e.target.value) })}
              disabled={disabled || condition.op === "exists" || condition.op === "notExists"}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove condition"
              onClick={() => onChange(conditions.filter((_, i) => i !== index))}
              disabled={disabled}
            >
              <Trash2 />
            </Button>
          </div>
        );
      })}
      {disabled ? null : (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() =>
            onChange([
              ...conditions,
              { path: options[0]?.value ?? "trigger", op: "equals", value: "" },
            ])
          }
        >
          <Plus /> {addLabel}
        </Button>
      )}
    </div>
  );
}

function asText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Parses JSON where it plainly is JSON (a list, object, number or boolean), else keeps text. */
export function fromText(text: string): JsonValue {
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed) || /^(true|false|null|-?\d+(\.\d+)?)$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed) as JsonValue;
    } catch {
      return text;
    }
  }
  return text;
}

const ROLE_CHOICES: { value: string; label: string; roles: Role[] }[] = [
  { value: "role:owner", label: "Every owner", roles: ["owner"] },
  { value: "role:admin", label: "Every admin", roles: ["admin"] },
  { value: "role:owner,admin", label: "Every owner and admin", roles: ["owner", "admin"] },
  { value: "role:owner,admin,member", label: "Everyone", roles: ["owner", "admin", "member"] },
];

/** Roles or one named member, for approvals and notifications. */
function PeoplePicker({
  label,
  value,
  onChange,
  catalog,
  disabled,
}: {
  label: string;
  value: Approvers;
  onChange: (next: Approvers) => void;
  catalog: AutomationCatalog;
  disabled?: boolean;
}) {
  const current = "roles" in value ? `role:${value.roles.join(",")}` : `user:${value.userIds[0]}`;
  const options = [
    ...ROLE_CHOICES.map((c) => ({ value: c.value, label: c.label })),
    ...catalog.members.map((m) => ({ value: `user:${m.id}`, label: `${m.name} (${m.role})` })),
  ];
  if (!options.some((o) => o.value === current))
    options.unshift({
      value: current,
      label:
        "roles" in value ? `Every ${value.roles.join(" and ")}` : `${value.userIds.length} people`,
    });
  return (
    <Field label={label}>
      <Select
        value={current}
        onValueChange={(next) =>
          onChange(
            next.startsWith("role:")
              ? { roles: next.slice(5).split(",") as Role[] }
              : { userIds: [next.slice(5)] },
          )
        }
        options={options}
        disabled={disabled}
      />
    </Field>
  );
}

/** Named values (Prepare values, the Zapier body): a name, a template, remove. */
function KeyValueEditor({
  values,
  onChange,
  paths,
  disabled,
  addLabel,
}: {
  values: Record<string, JsonValue>;
  onChange: (next: Record<string, JsonValue>) => void;
  paths: Paths;
  disabled?: boolean;
  addLabel: string;
}) {
  return (
    <div className="grid gap-2">
      {Object.entries(values).map(([key, value]) => (
        <div key={key} className="grid grid-cols-[8rem_1fr_auto] items-end gap-1">
          <Input
            aria-label="Value name"
            defaultValue={key}
            className="font-mono text-xs"
            disabled={disabled}
            onBlur={(e) => {
              const renamed = e.target.value.trim();
              if (!renamed || renamed === key) return;
              onChange(
                Object.fromEntries(
                  Object.entries(values).map(([k, v]) => (k === key ? [renamed, v] : [k, v])),
                ),
              );
            }}
          />
          <TemplateInput
            label={key}
            value={asText(value)}
            onChange={(next) => onChange({ ...values, [key]: fromText(next) })}
            paths={paths}
            disabled={disabled}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${key}`}
            onClick={() =>
              onChange(Object.fromEntries(Object.entries(values).filter(([k]) => k !== key)))
            }
            disabled={disabled}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      {disabled ? null : (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() => onChange({ ...values, [`value${Object.keys(values).length + 1}`]: "" })}
        >
          <Plus /> {addLabel}
        </Button>
      )}
    </div>
  );
}

// ---------- trigger ----------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function ScheduleEditor({
  trigger,
  onChange,
  disabled,
}: {
  trigger: ScheduleTrigger;
  onChange: (next: ScheduleTrigger) => void;
  disabled?: boolean;
}) {
  const zones = useMemo(() => {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    const list = supported ? supported("timeZone") : [];
    return [...new Set(["UTC", browserTimeZone(), trigger.timezone, ...list])].map((zone) => ({
      value: zone,
      label: zone.replace(/_/g, " "),
    }));
  }, [trigger.timezone]);
  const next = validTimeZone(trigger.timezone) ? nextScheduledRun(trigger, new Date()) : null;
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Repeats">
          <Select
            value={trigger.frequency}
            onValueChange={(frequency) =>
              onChange({ ...trigger, frequency: frequency as ScheduleTrigger["frequency"] })
            }
            options={[
              { value: "hourly", label: "Every hour" },
              { value: "daily", label: "Every day" },
              { value: "weekly", label: "Every week" },
              { value: "monthly", label: "Every month" },
            ]}
            disabled={disabled}
          />
        </Field>
        {trigger.frequency === "hourly" ? (
          <Field label="Minutes past the hour">
            <Input
              type="number"
              min={0}
              max={59}
              value={trigger.minute}
              onChange={(e) =>
                onChange({
                  ...trigger,
                  minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)),
                })
              }
              disabled={disabled}
            />
          </Field>
        ) : (
          <Field label="At">
            <Input
              type="time"
              value={trigger.time}
              onChange={(e) => e.target.value && onChange({ ...trigger, time: e.target.value })}
              disabled={disabled}
            />
          </Field>
        )}
      </div>
      {trigger.frequency === "weekly" ? (
        <fieldset className="grid gap-1.5">
          <legend className="text-sm font-medium">On</legend>
          <div className="flex flex-wrap gap-1">
            {WEEKDAYS.map((day, index) => {
              const on = trigger.weekdays.includes(index);
              return (
                <Button
                  key={day}
                  size="sm"
                  variant={on ? "secondary" : "outline"}
                  aria-pressed={on}
                  disabled={disabled || (on && trigger.weekdays.length === 1)}
                  onClick={() =>
                    onChange({
                      ...trigger,
                      weekdays: on
                        ? trigger.weekdays.filter((d) => d !== index)
                        : [...trigger.weekdays, index].sort(),
                    })
                  }
                >
                  {day}
                </Button>
              );
            })}
          </div>
        </fieldset>
      ) : null}
      {trigger.frequency === "monthly" ? (
        <Field label="Day of the month" hint="31 runs on the last day of shorter months.">
          <Input
            type="number"
            min={1}
            max={31}
            value={trigger.dayOfMonth}
            onChange={(e) =>
              onChange({
                ...trigger,
                dayOfMonth: Math.min(31, Math.max(1, Number(e.target.value) || 1)),
              })
            }
            disabled={disabled}
          />
        </Field>
      ) : null}
      <Field label="Time zone">
        <Combobox
          value={trigger.timezone}
          onValueChange={(timezone) => timezone && onChange({ ...trigger, timezone })}
          options={zones}
          disabled={disabled}
        />
      </Field>
      <Alert tone="info" title={describeSchedule(trigger)}>
        {next
          ? `Once published, the next run is ${next.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} (your time).`
          : "Choose a valid time zone."}
      </Alert>
    </div>
  );
}

function FieldsEditor({
  fields,
  onChange,
  disabled,
}: {
  fields: TriggerField[];
  onChange: (next: TriggerField[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-2">
      {fields.map((field, index) => {
        const set = (patch: Partial<TriggerField>) =>
          onChange(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)));
        return (
          <div key={index} className="grid grid-cols-[1fr_1fr_auto_auto_auto] items-center gap-1">
            <Input
              aria-label="Key"
              value={field.key}
              onChange={(e) => set({ key: e.target.value })}
              className="font-mono text-xs"
              disabled={disabled}
            />
            <Input
              aria-label="Label"
              value={field.label}
              onChange={(e) => set({ label: e.target.value })}
              disabled={disabled}
            />
            <Select
              aria-label="Type"
              value={field.type}
              onValueChange={(type) => set({ type: type as TriggerField["type"] })}
              options={TRIGGER_FIELD_TYPES.map((t) => ({ value: t, label: t }))}
              className="w-28"
              disabled={disabled}
            />
            <label className="flex items-center gap-1 text-xs">
              <Checkbox
                checked={field.required}
                onCheckedChange={(on) => set({ required: on === true })}
                disabled={disabled}
              />{" "}
              required
            </label>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove field"
              onClick={() => onChange(fields.filter((_, i) => i !== index))}
              disabled={disabled}
            >
              <Trash2 />
            </Button>
          </div>
        );
      })}
      {disabled ? null : (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() =>
            onChange([
              ...fields,
              {
                key: `field${fields.length + 1}`,
                label: "New field",
                type: "text",
                required: false,
              },
            ])
          }
        >
          <Plus /> Add field
        </Button>
      )}
    </div>
  );
}

/** The trigger a picker choice stands for, keeping what still applies from the current one. */
export function triggerFromChoice(id: string, current: AutomationTrigger): AutomationTrigger {
  if (id === "manual" || id === "webhook")
    return {
      kind: id,
      fields: current.kind === "manual" || current.kind === "webhook" ? current.fields : [],
    };
  if (id === "schedule")
    return current.kind === "schedule"
      ? current
      : {
          kind: "schedule",
          frequency: "daily",
          time: "09:00",
          minute: 0,
          weekdays: [1],
          dayOfMonth: 1,
          timezone: browserTimeZone(),
        };
  if (id === "zapier.event")
    return current.kind === "zapier.event"
      ? current
      : { kind: "zapier.event", connectionId: null, provider: "", eventType: "", when: [] };
  return { kind: "app.event", eventId: id.slice("app.event:".length), when: [] };
}

export function TriggerEditor({
  trigger,
  onChange,
  catalog,
  definition,
  disabled,
  extra,
}: {
  trigger: AutomationTrigger;
  onChange: (next: AutomationTrigger) => void;
  catalog: AutomationCatalog;
  definition: AutomationDefinition;
  disabled?: boolean;
  extra?: ReactNode;
}) {
  const [choosing, setChoosing] = useState(false);
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <p className="text-sm font-medium">Starts</p>
        <div className="flex items-center gap-2 rounded-md border border-border p-2">
          <span className="min-w-0 flex-1 text-sm">{describeTrigger(trigger, catalog)}</span>
          {disabled ? null : (
            <Button size="sm" variant="outline" onClick={() => setChoosing(true)}>
              Change
            </Button>
          )}
        </div>
      </div>
      {trigger.kind === "app.event" ? (
        <div className="grid gap-2">
          <p className="text-sm font-medium">Only when (optional)</p>
          <ConditionsEditor
            conditions={trigger.when}
            onChange={(when) => onChange({ ...trigger, when })}
            paths={availablePaths(definition, catalog, null)}
            disabled={disabled}
          />
        </div>
      ) : trigger.kind === "zapier.event" ? (
        <ZapierEventEditor
          trigger={trigger}
          onChange={onChange}
          catalog={catalog}
          definition={definition}
          disabled={disabled}
        />
      ) : trigger.kind === "schedule" ? (
        <ScheduleEditor trigger={trigger} onChange={onChange} disabled={disabled} />
      ) : (
        <div className="grid gap-2">
          <p className="text-sm font-medium">
            {trigger.kind === "manual"
              ? "Fields asked when someone runs it"
              : "Expected JSON body fields"}
          </p>
          <FieldsEditor
            fields={trigger.fields}
            onChange={(fields) => onChange({ ...trigger, fields })}
            disabled={disabled}
          />
        </div>
      )}
      {extra}
      <CatalogPicker
        open={choosing}
        onOpenChange={setChoosing}
        title="Choose what starts it"
        description="Events from your actions are the most useful; schedules, webhooks, Zapier and manual runs work with anything."
        placeholder="Search events, e.g. profile updated, every Monday, Zapier"
        items={triggerItems(catalog)}
        onPick={(id) => onChange(triggerFromChoice(id, trigger))}
      />
    </div>
  );
}

type ZapierTrigger = Extract<AutomationTrigger, { kind: "zapier.event" }>;

const ANY_CONNECTION = "__any";

/** Which Zapier connection, app and event type start the automation, plus optional filters. */
function ZapierEventEditor({
  trigger,
  onChange,
  catalog,
  definition,
  disabled,
}: {
  trigger: ZapierTrigger;
  onChange: (next: AutomationTrigger) => void;
  catalog: AutomationCatalog;
  definition: AutomationDefinition;
  disabled?: boolean;
}) {
  const nav = useNav();
  const source = catalog.triggers.find(
    (t): t is Extract<CatalogTrigger, { kind: "zapier.event" }> => t.kind === "zapier.event",
  );
  const connections = source?.connections ?? [];
  const seen = (source?.seen ?? []).filter(
    (e) => !trigger.connectionId || e.connectionId === trigger.connectionId,
  );
  const suggestions = [
    ...new Map(seen.map((e) => [`${e.provider}|${e.eventType}`, e])).values(),
  ].slice(0, 6);
  return (
    <div className="grid gap-4">
      {connections.length === 0 ? (
        <Alert
          tone="warning"
          title="Connect Zapier first"
          action={
            <Button size="sm" variant="outline" onClick={() => nav.navigate("/automations/zapier")}>
              Set up Zapier
            </Button>
          }
        >
          Create a Zapier connection to get the URL and secret your Zap posts to.
        </Alert>
      ) : (
        <Field
          label="Zapier connection"
          hint="Which connection's events start this. Any connection works when you have one Zap per app."
        >
          <Select
            value={trigger.connectionId ?? ANY_CONNECTION}
            onValueChange={(value) =>
              onChange({ ...trigger, connectionId: value === ANY_CONNECTION ? null : value })
            }
            options={[
              { value: ANY_CONNECTION, label: "Any Zapier connection" },
              ...connections.map((c) => ({
                value: c.id,
                label: c.status === "disabled" ? `${c.name} (disabled)` : c.name,
              })),
            ]}
            disabled={disabled}
          />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field
          label="App (optional)"
          hint="The provider your Zap sends, e.g. hubspot. Empty matches any app."
        >
          <Input
            value={trigger.provider}
            placeholder="hubspot"
            onChange={(e) => onChange({ ...trigger, provider: normalizeEventName(e.target.value) })}
            disabled={disabled}
          />
        </Field>
        <Field label="Event type" hint="The eventType your Zap sends, e.g. deal.closed_won.">
          <Input
            value={trigger.eventType}
            placeholder="deal.closed_won"
            onChange={(e) =>
              onChange({ ...trigger, eventType: normalizeEventName(e.target.value) })
            }
            disabled={disabled}
          />
        </Field>
      </div>
      {suggestions.length ? (
        <div className="grid gap-1.5">
          <p className="text-sm font-medium">Recently received</p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((e) => {
              const active = trigger.provider === e.provider && trigger.eventType === e.eventType;
              return (
                <Button
                  key={`${e.provider}|${e.eventType}`}
                  size="sm"
                  variant={active ? "secondary" : "outline"}
                  onClick={() =>
                    onChange({ ...trigger, provider: e.provider, eventType: e.eventType })
                  }
                  disabled={disabled}
                >
                  <Zap /> {[e.provider, e.eventType].filter(Boolean).join(" · ")}
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="grid gap-2">
        <p className="text-sm font-medium">Only when (optional)</p>
        <ConditionsEditor
          conditions={trigger.when}
          onChange={(when) => onChange({ ...trigger, when })}
          paths={availablePaths(definition, catalog, null)}
          disabled={disabled}
        />
      </div>
      <Explainer>
        Every field in the event's <code>data</code> is available to later steps under Trigger.
        {seen.length === 0
          ? " Send a test event from the Zapier page to see its fields in the data picker."
          : ""}
      </Explainer>
    </div>
  );
}

// ---------- steps ----------

function Explainer({ children }: { children: ReactNode }) {
  return <Alert tone="info">{children}</Alert>;
}

type ZapierSendStep = Extract<AutomationStep, { kind: "zapier.send" }>;

/** The outbound hook a Zapier step posts to, and a test send that completes its setup. */
function ZapierSendEditor({
  step,
  onChange,
  catalog,
  paths,
  disabled,
}: {
  step: ZapierSendStep;
  onChange: (next: AutomationStep) => void;
  catalog: AutomationCatalog;
  paths: Paths;
  disabled?: boolean;
}) {
  const api = useApi();
  const nav = useNav();
  const [sending, setSending] = useState(false);
  const hooks = catalog.zapierHooks;
  const hook = hooks.find((h) => h.id === step.connectionId);
  const sendTest = async () => {
    if (!step.connectionId) return;
    setSending(true);
    try {
      const { status } = await api.zapier.sendTest({
        connectionId: step.connectionId,
        sample: step.body,
      });
      toast("Sent to Zapier", {
        description: `Zapier answered ${status}. Open your Zap's Catch Hook to see the fields.`,
        tone: "success",
      });
    } catch (failure) {
      toast("Couldn't send to Zapier", { description: errorMessage(failure), tone: "danger" });
    } finally {
      setSending(false);
    }
  };
  return (
    <>
      {hooks.length === 0 ? (
        <Alert
          tone="warning"
          title="Add a Zapier Catch Hook first"
          action={
            <Button size="sm" variant="outline" onClick={() => nav.navigate("/automations/zapier")}>
              Set up Zapier
            </Button>
          }
        >
          In Zapier, start a Zap with Webhooks by Zapier → Catch Hook, and save its URL here.
        </Alert>
      ) : (
        <Field label="Zapier hook" hint="The Catch Hook this step posts its body to.">
          <Select
            value={step.connectionId ?? ANY_CONNECTION}
            onValueChange={(value) =>
              onChange({ ...step, connectionId: value === ANY_CONNECTION ? null : value })
            }
            options={[
              { value: ANY_CONNECTION, label: "Choose a hook" },
              ...hooks.map((h) => ({
                value: h.id,
                label: h.status === "disabled" ? `${h.name} (disabled)` : h.name,
              })),
            ]}
            disabled={disabled}
          />
        </Field>
      )}
      <div className="grid gap-2">
        <p className="text-sm font-medium">Body fields</p>
        <KeyValueEditor
          values={step.body}
          onChange={(body) => onChange({ ...step, body })}
          paths={paths}
          disabled={disabled}
          addLabel="Add field"
        />
      </div>
      {hook && !disabled ? (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          loading={sending}
          onClick={() => void sendTest()}
        >
          <Send /> Send a test to Zapier
        </Button>
      ) : null}
      <Explainer>
        Zapier receives these fields as JSON. Templates are sent as written in a test, with their
        values in a real run.
        {hook && !hook.connected ? " This hook hasn't received anything yet." : ""}
      </Explainer>
    </>
  );
}

export function StepEditor({
  step,
  definition,
  catalog,
  onChange,
  disabled,
}: {
  step: AutomationStep;
  definition: AutomationDefinition;
  catalog: AutomationCatalog;
  onChange: (next: AutomationStep) => void;
  disabled?: boolean;
}) {
  const paths = availablePaths(definition, catalog, step.id);
  const header = (
    <div className="grid grid-cols-2 gap-2">
      <Field label="Name">
        <Input
          value={step.name}
          onChange={(e) => onChange({ ...step, name: e.target.value })}
          disabled={disabled}
        />
      </Field>
      <Field label="Step id" hint="Later steps refer to this id.">
        <Input value={step.id} readOnly className="font-mono text-xs" />
      </Field>
    </div>
  );

  let body: ReactNode = null;
  switch (step.kind) {
    case "condition":
    case "branch":
      body = (
        <>
          <Field label="Match">
            <Select
              value={step.match}
              onValueChange={(match) => onChange({ ...step, match: match as "all" | "any" })}
              options={[
                { value: "all", label: "All conditions" },
                { value: "any", label: "Any condition" },
              ]}
              disabled={disabled}
            />
          </Field>
          <ConditionsEditor
            conditions={step.conditions}
            onChange={(conditions) => onChange({ ...step, conditions })}
            paths={paths}
            disabled={disabled}
          />
          <Explainer>
            {step.kind === "condition"
              ? "If this doesn't hold, the run ends here successfully (inside For each, it skips to the next item)."
              : "When this holds, the “If yes” steps run; otherwise the “Otherwise” steps do. Add steps to each path in the workflow."}
          </Explainer>
        </>
      );
      break;
    case "forEach":
      body = (
        <>
          <TemplateInput
            label="Items"
            value={step.items}
            onChange={(items) => onChange({ ...step, items })}
            paths={paths}
            hint="A list from the trigger or an earlier step, e.g. {{trigger.data.lines}}."
            placeholder="{{trigger.data.lineItems}}"
            disabled={disabled}
          />
          <Field
            label="At most this many items"
            hint="Items past the limit are skipped and noted in the run."
          >
            <Input
              type="number"
              min={1}
              max={100}
              value={step.maxItems}
              onChange={(e) =>
                onChange({
                  ...step,
                  maxItems: Math.min(100, Math.max(1, Number(e.target.value) || 1)),
                })
              }
              disabled={disabled}
            />
          </Field>
          <Explainer>
            Steps inside run once per item. They can use the current item as “Current item” data.
            After the loop, later steps can read its results.
          </Explainer>
        </>
      );
      break;
    case "delay": {
      const mode = step.until !== undefined ? "until" : "for";
      body = (
        <>
          <Field label="Wait">
            <Select
              value={mode}
              onValueChange={(next) =>
                onChange(
                  next === "until"
                    ? { ...step, until: "{{trigger.data.dueAt}}" }
                    : { ...step, until: undefined },
                )
              }
              options={[
                { value: "for", label: "For an amount of time" },
                { value: "until", label: "Until a date and time" },
              ]}
              disabled={disabled}
            />
          </Field>
          {mode === "until" ? (
            <TemplateInput
              label="Until"
              value={step.until ?? ""}
              onChange={(until) => onChange({ ...step, until })}
              paths={paths}
              hint="An ISO date and time, or data with a helper, e.g. {{trigger.data.dueAt | addDays:-1}}."
              disabled={disabled}
            />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Amount">
                <Input
                  type="number"
                  min={1}
                  value={step.amount}
                  onChange={(e) =>
                    onChange({ ...step, amount: Math.max(1, Number(e.target.value) || 1) })
                  }
                  disabled={disabled}
                />
              </Field>
              <Field label="Unit">
                <Select
                  value={step.unit}
                  onValueChange={(unit) =>
                    onChange({ ...step, unit: unit as (typeof DELAY_UNITS)[number] })
                  }
                  options={DELAY_UNITS.map((u) => ({ value: u, label: u }))}
                  disabled={disabled}
                />
              </Field>
            </div>
          )}
          <Explainer>
            The run pauses durably, up to 90 days, and picks up where it left off. Tests skip the
            wait.
          </Explainer>
        </>
      );
      break;
    }
    case "map":
      body = (
        <KeyValueEditor
          values={step.fields}
          onChange={(fields) => onChange({ ...step, fields })}
          paths={paths}
          disabled={disabled}
          addLabel="Add value"
        />
      );
      break;
    case "approval":
      body = (
        <>
          <PeoplePicker
            label="Who can approve"
            value={step.approvers}
            onChange={(approvers) => onChange({ ...step, approvers })}
            catalog={catalog}
            disabled={disabled}
          />
          <TemplateInput
            label="Message to the approver"
            value={step.message}
            onChange={(message) => onChange({ ...step, message })}
            paths={paths}
            multiline
            disabled={disabled}
          />
          <Field label="Give up after (hours)">
            <Input
              type="number"
              min={1}
              max={720}
              value={step.timeoutHours}
              onChange={(e) => onChange({ ...step, timeoutHours: Number(e.target.value) || 1 })}
              disabled={disabled}
            />
          </Field>
          <Explainer>
            Approvers get an email with a link to the run. It waits until someone decides; declining
            or timing out ends it without the later steps.
          </Explainer>
        </>
      );
      break;
    case "notify":
      body = (
        <>
          <PeoplePicker
            label="Email"
            value={step.to}
            onChange={(to) => onChange({ ...step, to })}
            catalog={catalog}
            disabled={disabled}
          />
          <TemplateInput
            label="Subject"
            value={step.subject}
            onChange={(subject) => onChange({ ...step, subject })}
            paths={paths}
            disabled={disabled}
          />
          <TemplateInput
            label="Message (optional)"
            value={step.body}
            onChange={(body) => onChange({ ...step, body })}
            paths={paths}
            multiline
            disabled={disabled}
          />
        </>
      );
      break;
    case "email.send":
      body = (
        <>
          <TemplateInput
            label="To"
            value={step.to}
            onChange={(to) => onChange({ ...step, to })}
            paths={paths}
            hint="Comma-separated addresses. Each gets their own copy."
            disabled={disabled}
          />
          <TemplateInput
            label="Subject"
            value={step.subject}
            onChange={(subject) => onChange({ ...step, subject })}
            paths={paths}
            disabled={disabled}
          />
          <TemplateInput
            label="Body"
            value={step.body}
            onChange={(body) => onChange({ ...step, body })}
            paths={paths}
            multiline
            disabled={disabled}
          />
        </>
      );
      break;
    case "ai.generate":
      body = (
        <>
          <TemplateInput
            label="Instruction"
            value={step.instruction}
            onChange={(instruction) => onChange({ ...step, instruction })}
            paths={paths}
            multiline
            placeholder="Summarize this request in one sentence and say whether it's urgent."
            disabled={disabled}
          />
          <TemplateInput
            label="What it reads"
            value={step.input}
            onChange={(input) => onChange({ ...step, input })}
            paths={paths}
            multiline
            hint="Data from the trigger or earlier steps. The AI sees only this and the instruction."
            disabled={disabled}
          />
          <Field label="Answer as">
            <Select
              value={step.output}
              onValueChange={(output) => onChange({ ...step, output: output as "text" | "fields" })}
              options={[
                { value: "text", label: "Text" },
                { value: "fields", label: "Named fields (for conditions and mappings)" },
              ]}
              disabled={disabled}
            />
          </Field>
          {step.output === "fields" ? (
            <div className="grid gap-2">
              {step.fields.map((field, index) => {
                const set = (patch: Partial<typeof field>) =>
                  onChange({
                    ...step,
                    fields: step.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)),
                  });
                return (
                  <div
                    key={index}
                    className="grid grid-cols-[8rem_7rem_1fr_auto] items-center gap-1"
                  >
                    <Input
                      aria-label="Field name"
                      value={field.key}
                      onChange={(e) => set({ key: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })}
                      className="font-mono text-xs"
                      disabled={disabled}
                    />
                    <Select
                      aria-label="Type"
                      value={field.type}
                      onValueChange={(type) =>
                        set({ type: type as (typeof AI_FIELD_TYPES)[number] })
                      }
                      options={AI_FIELD_TYPES.map((t) => ({ value: t, label: t }))}
                      disabled={disabled}
                    />
                    <Input
                      aria-label="What it means"
                      placeholder="What it means"
                      value={field.description}
                      onChange={(e) => set({ description: e.target.value })}
                      disabled={disabled}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${field.key}`}
                      onClick={() =>
                        onChange({ ...step, fields: step.fields.filter((_, i) => i !== index) })
                      }
                      disabled={disabled}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                );
              })}
              {disabled ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  className="justify-self-start"
                  onClick={() =>
                    onChange({
                      ...step,
                      fields: [
                        ...step.fields,
                        { key: `field${step.fields.length + 1}`, type: "text", description: "" },
                      ],
                    })
                  }
                >
                  <Plus /> Add field
                </Button>
              )}
            </div>
          ) : null}
          <Explainer>
            Uses the organization's AI model and counts toward its AI budget. Tests return sample
            answers without calling the model.
          </Explainer>
        </>
      );
      break;
    case "http.request":
      body = (
        <>
          <div className="grid grid-cols-[7rem_1fr] items-end gap-2">
            <Field label="Method">
              <Select
                value={step.method}
                onValueChange={(method) =>
                  onChange({ ...step, method: method as (typeof HTTP_METHODS)[number] })
                }
                options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
                disabled={disabled}
              />
            </Field>
            <TemplateInput
              label="Address"
              value={step.url}
              onChange={(url) => onChange({ ...step, url })}
              paths={paths}
              placeholder="https://api.example.com/hooks/new-order"
              disabled={disabled}
            />
          </div>
          <div className="grid gap-2">
            <p className="text-sm font-medium">Headers</p>
            {Object.entries(step.headers).map(([name, value]) => (
              <div key={name} className="grid grid-cols-[10rem_1fr_auto] items-end gap-1">
                <Input
                  aria-label="Header name"
                  defaultValue={name}
                  className="font-mono text-xs"
                  disabled={disabled}
                  onBlur={(e) => {
                    const renamed = e.target.value.trim();
                    if (!renamed || renamed === name) return;
                    onChange({
                      ...step,
                      headers: Object.fromEntries(
                        Object.entries(step.headers).map(([k, v]) =>
                          k === name ? [renamed, v] : [k, v],
                        ),
                      ),
                    });
                  }}
                />
                <TemplateInput
                  label={name}
                  value={value}
                  onChange={(next) =>
                    onChange({ ...step, headers: { ...step.headers, [name]: next } })
                  }
                  paths={paths}
                  disabled={disabled}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${name}`}
                  onClick={() =>
                    onChange({
                      ...step,
                      headers: Object.fromEntries(
                        Object.entries(step.headers).filter(([k]) => k !== name),
                      ),
                    })
                  }
                  disabled={disabled}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            {disabled ? null : (
              <Button
                variant="outline"
                size="sm"
                className="justify-self-start"
                onClick={() =>
                  onChange({
                    ...step,
                    headers: {
                      ...step.headers,
                      [Object.keys(step.headers).length
                        ? `X-Header-${Object.keys(step.headers).length + 1}`
                        : "Authorization"]: "",
                    },
                  })
                }
              >
                <Plus /> Add header
              </Button>
            )}
          </div>
          {step.method !== "GET" ? (
            <TemplateInput
              label="Body (optional)"
              value={asText(step.body)}
              onChange={(body) =>
                onChange({ ...step, body: body.trim() ? fromText(body) : undefined })
              }
              paths={paths}
              multiline
              hint="JSON is sent as application/json. Values from data keep their type."
              disabled={disabled}
            />
          ) : null}
          <label className="flex items-start gap-3 rounded-md border border-border p-3">
            <Switch
              checked={step.failOnError}
              onCheckedChange={(failOnError) => onChange({ ...step, failOnError })}
              disabled={disabled}
            />
            <span className="grid gap-0.5 text-sm">
              <span className="font-medium">Fail the run on an error response</span>
              <span className="text-muted-foreground">
                Off: the step succeeds and later steps can check its status.
              </span>
            </span>
          </label>
          {Object.keys(step.headers).some((h) => /authorization|api-key|token/i.test(h)) ? (
            <Alert tone="warning">
              Header values are stored in the automation, so anyone who can edit it can read them.
              Use a key made for this purpose that you can revoke.
            </Alert>
          ) : null}
        </>
      );
      break;
    case "action": {
      const action = catalog.actions.find((a) => a.actionId === step.actionId);
      const schema = action?.inputSchema as
        | {
            properties?: Record<string, { description?: string; type?: string }>;
            required?: string[];
          }
        | undefined;
      const fields = Object.keys({ ...(schema?.properties ?? {}), ...step.input });
      body = (
        <>
          <Field label="Action">
            <Combobox
              value={step.actionId}
              onValueChange={(actionId) =>
                actionId &&
                onChange({
                  ...step,
                  actionId,
                  input: {},
                  name: catalog.actions.find((a) => a.actionId === actionId)?.title ?? step.name,
                })
              }
              options={[
                ...(action
                  ? []
                  : [{ value: step.actionId, label: `${step.actionId} (not available)` }]),
                ...catalog.actions.map((a) => ({
                  value: a.actionId,
                  label: `${a.title}${a.readOnly ? " (find)" : ""}`,
                  keywords: [a.actionId, a.description],
                })),
              ]}
              disabled={disabled}
            />
          </Field>
          {action?.confirm ? (
            <Alert tone="warning">
              This action is consequential: consider an approval step before it.
            </Alert>
          ) : null}
          {action && !action.readOnly ? <Badge tone="outline">Changes data</Badge> : null}
          {fields.map((field) => (
            <TemplateInput
              key={field}
              label={`${field}${schema?.required?.includes(field) ? " *" : ""}`}
              hint={
                schema?.properties?.[field]?.description ??
                (schema?.properties?.[field] ? undefined : "Not part of this action's input")
              }
              value={asText(step.input[field])}
              onChange={(next) =>
                onChange({
                  ...step,
                  input: {
                    ...step.input,
                    [field]:
                      schema?.properties?.[field]?.type &&
                      schema.properties[field].type !== "string"
                        ? fromText(next)
                        : next,
                  },
                })
              }
              paths={paths}
              disabled={disabled}
            />
          ))}
        </>
      );
      break;
    }
    case "zapier.send":
      body = (
        <ZapierSendEditor
          step={step}
          onChange={onChange}
          catalog={catalog}
          paths={paths}
          disabled={disabled}
        />
      );
      break;
  }

  const hasRetries = !["approval", "delay", "branch", "forEach", "condition", "map"].includes(
    step.kind,
  );
  return (
    <div className="grid gap-4">
      {header}
      {body}
      {step.kind !== "approval" &&
      !(disabled && !step.runIf?.length && !step.retry && !step.timeoutSeconds) ? (
        <details className="rounded-md border border-border p-2 text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {hasRetries ? "Run-if conditions and retries" : "Run-if conditions"}
          </summary>
          <div className="mt-2 grid gap-3">
            <ConditionsEditor
              conditions={step.runIf ?? []}
              onChange={(runIf) => onChange({ ...step, runIf: runIf.length ? runIf : undefined })}
              paths={paths}
              disabled={disabled}
              addLabel="Only run this step if…"
            />
            {hasRetries ? (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Retries" hint="For temporary failures only.">
                  <Input
                    type="number"
                    min={0}
                    max={10}
                    value={step.retry?.limit ?? ""}
                    placeholder="default"
                    onChange={(e) =>
                      onChange({
                        ...step,
                        retry:
                          e.target.value === ""
                            ? undefined
                            : {
                                limit: Number(e.target.value),
                                delaySeconds: step.retry?.delaySeconds ?? 5,
                                backoff: step.retry?.backoff ?? "exponential",
                              },
                      })
                    }
                    disabled={disabled}
                  />
                </Field>
                <Field label="Timeout (seconds)">
                  <Input
                    type="number"
                    min={5}
                    max={900}
                    value={step.timeoutSeconds ?? ""}
                    placeholder="120"
                    onChange={(e) =>
                      onChange({
                        ...step,
                        timeoutSeconds: e.target.value === "" ? undefined : Number(e.target.value),
                      })
                    }
                    disabled={disabled}
                  />
                </Field>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
