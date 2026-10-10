import { z } from "zod";
import { AiConversation, AiSettings, AiUsageSummary, AssistantConfig } from "./ai";
import {
  ApprovalDecisionInput,
  AUTOMATION_LIMITS,
  AutomationCreateInput,
  DraftSaveInput,
  LiveTestInput,
  PauseInput,
  PublishInput,
  RestoreRevisionInput,
  RunManuallyInput,
  SimulateInput,
  type AutomationCatalog,
  type AutomationDetail,
  type AutomationList,
  type DraftSaveResult,
  type RunView,
} from "./automations";
import type { Permission } from "./permissions";
import {
  DeleteOrganizationInput,
  InviteCreateInput,
  InviteList,
  InviteRef,
  InviteSent,
  Invite,
  InvitesListInput,
  LeaveOrganizationInput,
  Member,
  MemberList,
  MemberRemoveInput,
  MembersListInput,
  MemberUpdateRoleInput,
  OrganizationExit,
  OrganizationGetInput,
  OrganizationUpdateInput,
  OrganizationView,
  Profile,
  ProfileGetInput,
  ProfileUpdateInput,
  TransferOwnershipInput,
} from "./schemas";
import type { Scope } from "./scopes";
import {
  ZAPIER_LIMITS,
  ZapierConnectionCreateInput,
  ZapierConnectionUpdateInput,
  type ZapierConnectionView,
  type ZapierEventView,
} from "./zapier";

/**
 * An action's public contract: what it's called, what it takes and returns, and which scope a
 * token needs. The server binds a handler to it (`defineAction` in `apps/server`), and the
 * registry serves it three ways: `POST /api/actions/<id>`, the MCP tool `<id with _>` and
 * `client.<module>.<name>()` in `@template/api-client`.
 */
export type ActionContract<
  Id extends string = string,
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
> = {
  id: Id;
  /** A sentence for the person and for the MCP client's model. */
  description: string;
  /** A short name for MCP tool listings. */
  title: string;
  input: Input;
  output: Output;
  scope: Scope;
  /** Reads only: marked `readOnlyHint` for MCP clients. */
  readOnly: boolean;
  /**
   * An agent (an MCP client, the Assistant, an automation) always asks the person before running
   * it. MCP marks it `destructiveHint`.
   */
  confirm?: boolean;
  /**
   * Named events a successful call emits: automation triggers (`specs/ai.md`). The event's data
   * is the action's output. `when` says when it's emitted, if not on every success.
   */
  events?: readonly ActionEvent[];
  /**
   * The permission it needs (`permissions.ts`); every member may run it when unset. Never a
   * role: which roles hold the permission is decided in one place. MCP `tools/list`, the
   * Assistant and the automation catalog only offer an action to people who may run it
   * (`mayRun`).
   */
  permission?: Permission;
  /** Not exposed as an MCP tool, an Assistant tool or an automation step (it needs the browser). */
  webOnly?: boolean;
  /** The largest request body it takes, when more than the default 16 KB (automation definitions). */
  maxInputBytes?: number;
};

export type ActionEvent = {
  id: string;
  title: string;
  when?: string;
  /**
   * Emitted by the code that knows it happened (`emitEvent`), not on every successful call:
   * `members.joined` is declared on `invites.create` but happens when the invite is accepted.
   */
  manual?: boolean;
};

export function defineActionContract<
  const Id extends `${string}.${string}`,
  Input extends z.ZodType,
  Output extends z.ZodType,
>(contract: ActionContract<Id, Input, Output>): ActionContract<Id, Input, Output> {
  return contract;
}

/**
 * An output the server builds and the client trusts: typed at compile time, passed through
 * unchecked at run time (JSON Schema `{}`). Only for web-only actions whose views are too large
 * to mirror in Zod (an automation's detail, its catalog); every other output is a real schema.
 */
export function trusted<T>() {
  return z.custom<T>(() => true);
}

const Ok = z.object({ ok: z.literal(true) });

export const profileGet = defineActionContract({
  id: "profile.get",
  title: "Get profile",
  description:
    "Get the signed-in person's profile: name, job title, email, whether the email is verified, and their company and role.",
  input: ProfileGetInput,
  output: Profile,
  scope: "profile:read",
  readOnly: true,
});

export const profileUpdate = defineActionContract({
  id: "profile.update",
  title: "Update profile",
  description:
    "Change the signed-in person's name or job title. Email changes need the verification link, so they're made in the browser.",
  input: ProfileUpdateInput,
  output: Profile,
  scope: "profile:write",
  readOnly: false,
  // An agent asks before changing how the person appears to everyone else.
  confirm: true,
  events: [{ id: "profile.updated", title: "Profile updated" }],
});

// ---------------------------------------------------------------- organization (specs/organizations.md)
// None takes an organization id: the organization is always the caller's (`ctx.organization`).

export const organizationGet = defineActionContract({
  id: "organization.get",
  title: "Get company",
  description:
    "Get the company this connection is for: its name, slug, and the caller's role and permissions there.",
  input: OrganizationGetInput,
  output: OrganizationView,
  scope: "organization:read",
  readOnly: true,
});

export const organizationUpdate = defineActionContract({
  id: "organization.update",
  title: "Update company",
  description:
    "Rename the company or change its slug (lowercase letters, numbers and hyphens). Owners and admins.",
  input: OrganizationUpdateInput,
  output: OrganizationView,
  scope: "organization:write",
  readOnly: false,
  confirm: true,
  permission: "organization.manage",
});

export const organizationTransferOwnership = defineActionContract({
  id: "organization.transferOwnership",
  title: "Transfer ownership",
  description:
    "Make another member the owner. The current owner becomes an admin, and both get an email.",
  input: TransferOwnershipInput,
  output: MemberList,
  scope: "organization:write",
  readOnly: false,
  confirm: true,
  permission: "organization.transfer",
  webOnly: true,
});

export const organizationLeave = defineActionContract({
  id: "organization.leave",
  title: "Leave company",
  description:
    "Leave the company. The last owner can't leave until someone else is an owner. The session opens another company, if the person has one.",
  input: LeaveOrganizationInput,
  output: OrganizationExit,
  scope: "organization:write",
  readOnly: false,
  confirm: true,
  webOnly: true,
});

export const organizationDelete = defineActionContract({
  id: "organization.delete",
  title: "Delete company",
  description:
    "Delete the company: every member loses access at once, connections are revoked and automations stop. It can be restored by support for 30 days, then it's gone.",
  input: DeleteOrganizationInput,
  output: OrganizationExit,
  scope: "organization:write",
  readOnly: false,
  confirm: true,
  permission: "organization.delete",
  webOnly: true,
});

export const membersList = defineActionContract({
  id: "members.list",
  title: "List members",
  description: "List the company's members: name, email, job title and role.",
  input: MembersListInput,
  output: MemberList,
  scope: "organization:read",
  readOnly: true,
});

export const membersUpdateRole = defineActionContract({
  id: "members.updateRole",
  title: "Change a member's role",
  description:
    "Change a member's role (owner, admin or member). Admins can promote members to admin but can't change other admins or owners; only owners can make someone an owner. A company always keeps at least one owner.",
  input: MemberUpdateRoleInput,
  output: Member,
  scope: "organization:write",
  readOnly: false,
  confirm: true,
  permission: "members.manage",
  events: [{ id: "members.roleChanged", title: "Member's role changed" }],
});

export const membersRemove = defineActionContract({
  id: "members.remove",
  title: "Remove a member",
  description:
    "Remove someone from the company. They lose access at once: their sessions here end and their connected apps for this company are disconnected.",
  input: MemberRemoveInput,
  output: Member,
  scope: "organization:write",
  readOnly: false,
  confirm: true,
  permission: "members.manage",
  events: [{ id: "members.removed", title: "Member removed" }],
});

export const invitesList = defineActionContract({
  id: "invites.list",
  title: "List invitations",
  description: "List the company's pending and expired invitations.",
  input: InvitesListInput,
  output: InviteList,
  scope: "organization:read",
  readOnly: true,
  permission: "members.manage",
});

export const invitesCreate = defineActionContract({
  id: "invites.create",
  title: "Invite someone",
  description:
    "Email someone an invitation to join the company as a member or an admin. The link works for 7 days. Inviting an address that already has a pending invitation sends it again.",
  input: InviteCreateInput,
  output: InviteSent,
  scope: "organization:write",
  readOnly: false,
  // It sends an email.
  confirm: true,
  permission: "members.manage",
  events: [
    {
      id: "members.joined",
      title: "Member joined",
      when: "when someone accepts an invitation",
      manual: true,
    },
  ],
});

export const invitesResend = defineActionContract({
  id: "invites.resend",
  title: "Resend an invitation",
  description:
    "Send an invitation again with a new link (the old link stops working) that works for another 7 days.",
  input: InviteRef,
  output: Invite,
  scope: "organization:write",
  readOnly: false,
  permission: "members.manage",
});

export const invitesRevoke = defineActionContract({
  id: "invites.revoke",
  title: "Revoke an invitation",
  description: "Cancel an invitation, so its link stops working.",
  input: InviteRef,
  output: Ok,
  scope: "organization:write",
  readOnly: false,
  confirm: true,
  permission: "members.manage",
});

// ---------------------------------------------------------------- automations (specs/ai.md)
// Web-only: people build and run automations in the app. Members see automations and their runs;
// `automations.manage` changes them. None takes an organization id.

const AutomationRef = z.object({ automationId: z.uuid("Pick an automation.") });
const RunRef = z.object({ runId: z.uuid("Pick a run.") });
const AutomationRuns = z.object({ runs: z.array(trusted<RunView>()) });
const WebhookSecret = z.object({ url: z.string(), secret: z.string() });
const DEFINITION_BYTES = AUTOMATION_LIMITS.maxDefinitionBytes + 4_000;
const PAYLOAD_BYTES = AUTOMATION_LIMITS.maxPayloadBytes + 1_000;

const automation = {
  scope: "organization:write",
  readOnly: false,
  webOnly: true,
  permission: "automations.manage",
} as const;
const automationRead = { scope: "organization:read", readOnly: true, webOnly: true } as const;

export const automationsList = defineActionContract({
  id: "automations.list",
  title: "List automations",
  description:
    "The company's automations, with their last run, and the approvals waiting on the person.",
  input: z.object({}),
  output: trusted<AutomationList>(),
  ...automationRead,
});

export const automationsCatalog = defineActionContract({
  id: "automations.catalog",
  title: "Automation catalog",
  description: "What the person may compose into an automation: triggers, steps and actions.",
  input: z.object({}),
  output: trusted<AutomationCatalog>(),
  ...automationRead,
});

export const automationsGet = defineActionContract({
  id: "automations.get",
  title: "Get an automation",
  description: "An automation's draft, published versions, revisions and problems.",
  input: AutomationRef,
  output: trusted<AutomationDetail>(),
  ...automationRead,
});

export const automationsCreate = defineActionContract({
  id: "automations.create",
  title: "Create an automation",
  description: "Start a new automation with an empty draft.",
  input: AutomationCreateInput,
  output: z.object({ id: z.string(), draftRevision: z.number() }),
  ...automation,
});

export const automationsSaveDraft = defineActionContract({
  id: "automations.saveDraft",
  title: "Save an automation's draft",
  description:
    "Save a full definition as the next draft revision. A save based on an older revision is refused.",
  input: DraftSaveInput.extend(AutomationRef.shape),
  output: trusted<DraftSaveResult>(),
  maxInputBytes: DEFINITION_BYTES,
  ...automation,
});

export const automationsRestore = defineActionContract({
  id: "automations.restore",
  title: "Restore a draft revision",
  description: "Make an earlier draft revision the current draft again.",
  input: RestoreRevisionInput.extend(AutomationRef.shape),
  output: trusted<DraftSaveResult>(),
  ...automation,
});

export const automationsDelete = defineActionContract({
  id: "automations.delete",
  title: "Delete an automation",
  description: "Delete an automation and stop its runs.",
  input: AutomationRef,
  output: Ok,
  ...automation,
});

export const automationsPublish = defineActionContract({
  id: "automations.publish",
  title: "Publish an automation",
  description: "Publish the reviewed draft revision as the next version, run as the publisher.",
  input: PublishInput.extend(AutomationRef.shape),
  output: z.object({ version: z.number() }),
  ...automation,
});

export const automationsSetPaused = defineActionContract({
  id: "automations.setPaused",
  title: "Pause or resume an automation",
  description: "Pause a published automation, or resume it if its published version still works.",
  input: PauseInput.extend(AutomationRef.shape),
  output: z.object({ status: z.enum(["paused", "active"]) }),
  ...automation,
});

export const automationsSimulate = defineActionContract({
  id: "automations.simulate",
  title: "Simulate an automation",
  description: "Run the draft against a sample payload with every effect simulated.",
  input: SimulateInput.extend(AutomationRef.shape),
  output: trusted<RunView>(),
  maxInputBytes: PAYLOAD_BYTES,
  ...automation,
});

export const automationsLiveTest = defineActionContract({
  id: "automations.liveTest",
  title: "Test an automation for real",
  description: "Run a draft revision once with real effects, after the person confirmed them.",
  input: LiveTestInput.extend(AutomationRef.shape),
  output: z.object({ runId: z.string() }),
  maxInputBytes: PAYLOAD_BYTES,
  ...automation,
});

export const automationsRun = defineActionContract({
  id: "automations.run",
  title: "Run an automation",
  description: "Start a manual automation with its trigger's fields.",
  input: RunManuallyInput.extend(AutomationRef.shape),
  output: z.object({ runId: z.string() }),
  maxInputBytes: PAYLOAD_BYTES,
  ...automation,
});

export const automationsRuns = defineActionContract({
  id: "automations.runs",
  title: "List an automation's runs",
  description: "An automation's recent runs, newest first.",
  input: AutomationRef,
  output: AutomationRuns,
  ...automationRead,
});

export const automationsGetRun = defineActionContract({
  id: "automations.getRun",
  title: "Get a run",
  description: "A run's steps, approvals and outcome.",
  input: RunRef,
  output: trusted<RunView>(),
  ...automationRead,
});

export const automationsCancelRun = defineActionContract({
  id: "automations.cancelRun",
  title: "Cancel a run",
  description: "Stop a run that hasn't finished.",
  input: RunRef,
  output: z.object({ status: z.literal("cancelled") }),
  ...automation,
});

export const automationsDecideApproval = defineActionContract({
  id: "automations.decideApproval",
  title: "Approve or decline",
  description: "Decide an approval step a run is waiting on, as one of its approvers.",
  input: ApprovalDecisionInput.extend({
    ...RunRef.shape,
    approvalId: z.uuid("Pick an approval."),
  }),
  output: z.object({ status: z.enum(["approved", "rejected"]) }),
  scope: "organization:write",
  readOnly: false,
  webOnly: true,
});

export const automationsWebhook = defineActionContract({
  id: "automations.webhook",
  title: "Get an automation's webhook",
  description: "The webhook trigger's URL and signing secret.",
  input: AutomationRef,
  output: WebhookSecret,
  ...automation,
  readOnly: true,
});

export const automationsRotateWebhook = defineActionContract({
  id: "automations.rotateWebhook",
  title: "Rotate a webhook secret",
  description: "Replace the webhook trigger's signing secret; the old one stops working.",
  input: AutomationRef,
  output: WebhookSecret,
  ...automation,
});

// ---------------------------------------------------------------- Zapier (specs/ai.md)

const ConnectionRef = z.object({ connectionId: z.uuid("Pick a connection.") });

export const zapierList = defineActionContract({
  id: "zapier.list",
  title: "List Zapier connections",
  description: "The company's Zapier connections, inbound and outbound.",
  input: z.object({}),
  output: z.object({ connections: z.array(trusted<ZapierConnectionView>()) }),
  ...automationRead,
});

export const zapierCreate = defineActionContract({
  id: "zapier.create",
  title: "Add a Zapier connection",
  description:
    "Add an inbound connection (its secret is returned this once) or an outbound Catch Hook.",
  input: ZapierConnectionCreateInput,
  output: z.object({
    connection: trusted<ZapierConnectionView>(),
    secret: z.string().nullable(),
  }),
  ...automation,
});

export const zapierUpdate = defineActionContract({
  id: "zapier.update",
  title: "Change a Zapier connection",
  description: "Rename a connection, or turn it on or off.",
  input: ZapierConnectionUpdateInput.extend(ConnectionRef.shape),
  output: trusted<ZapierConnectionView>(),
  ...automation,
});

export const zapierDelete = defineActionContract({
  id: "zapier.delete",
  title: "Remove a Zapier connection",
  description: "Remove a connection; automations that use it are paused.",
  input: ConnectionRef,
  output: z.object({ stoppedAutomations: z.number() }),
  ...automation,
});

export const zapierRegenerateSecret = defineActionContract({
  id: "zapier.regenerateSecret",
  title: "Regenerate a connection's secret",
  description: "Replace an inbound connection's secret; the old one stops working.",
  input: ConnectionRef,
  output: z.object({ secret: z.string(), hint: z.string() }),
  ...automation,
});

export const zapierEvents = defineActionContract({
  id: "zapier.events",
  title: "List a connection's events",
  description: "An inbound connection's recent events and the runs they started.",
  input: ConnectionRef,
  output: z.object({ events: z.array(trusted<ZapierEventView>()) }),
  ...automationRead,
});

export const zapierSendTestEvent = defineActionContract({
  id: "zapier.sendTestEvent",
  title: "Send a test event",
  description: "Send a test event through the inbound pipeline; it starts nothing.",
  input: ConnectionRef.extend({ body: z.unknown().optional() }),
  output: trusted<ZapierEventView>(),
  maxInputBytes: ZAPIER_LIMITS.maxBodyBytes + 1_000,
  ...automation,
});

export const zapierSendTest = defineActionContract({
  id: "zapier.sendTest",
  title: "Send a test to a Catch Hook",
  description: "Post a sample body to an outbound connection's Catch Hook.",
  input: ConnectionRef.extend({ sample: z.record(z.string(), z.unknown()).optional() }),
  output: z.object({ status: z.number() }),
  ...automation,
});

// ---------------------------------------------------------------- the Assistant (specs/ai.md)

export const assistantConfig = defineActionContract({
  id: "assistant.config",
  title: "Assistant settings for the panel",
  description: "Whether the Assistant is on here, its models and the default.",
  input: z.object({}),
  output: AssistantConfig,
  scope: "profile:read",
  readOnly: true,
  webOnly: true,
});

export const assistantConversations = defineActionContract({
  id: "assistant.conversations",
  title: "List conversations",
  description: "The person's own Assistant conversations here, newest first.",
  input: z.object({}),
  output: z.object({ conversations: z.array(AiConversation) }),
  scope: "profile:read",
  readOnly: true,
  webOnly: true,
});

export const assistantDeleteConversation = defineActionContract({
  id: "assistant.deleteConversation",
  title: "Delete a conversation",
  description: "Delete one of the person's own Assistant conversations.",
  input: z.object({
    conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Pick a conversation."),
  }),
  output: Ok,
  scope: "profile:write",
  readOnly: false,
  webOnly: true,
});

export const assistantUsage = defineActionContract({
  id: "assistant.usage",
  title: "AI spending",
  description: "This month's AI spend, today's requests and the limits.",
  input: z.object({}),
  output: AiUsageSummary,
  scope: "organization:read",
  readOnly: true,
  webOnly: true,
  permission: "ai.usage",
});

export const assistantSaveSettings = defineActionContract({
  id: "assistant.saveSettings",
  title: "Change AI settings",
  description: "Set the default model, the monthly budget and the daily request cap.",
  input: AiSettings,
  output: AiUsageSummary,
  scope: "organization:write",
  readOnly: false,
  webOnly: true,
  permission: "ai.manage",
});

/** Every action, keyed by id. Add a module's contracts here. */
export const ACTIONS = {
  [profileGet.id]: profileGet,
  [profileUpdate.id]: profileUpdate,
  [organizationGet.id]: organizationGet,
  [organizationUpdate.id]: organizationUpdate,
  [organizationTransferOwnership.id]: organizationTransferOwnership,
  [organizationLeave.id]: organizationLeave,
  [organizationDelete.id]: organizationDelete,
  [membersList.id]: membersList,
  [membersUpdateRole.id]: membersUpdateRole,
  [membersRemove.id]: membersRemove,
  [invitesList.id]: invitesList,
  [invitesCreate.id]: invitesCreate,
  [invitesResend.id]: invitesResend,
  [invitesRevoke.id]: invitesRevoke,
  [automationsList.id]: automationsList,
  [automationsCatalog.id]: automationsCatalog,
  [automationsGet.id]: automationsGet,
  [automationsCreate.id]: automationsCreate,
  [automationsSaveDraft.id]: automationsSaveDraft,
  [automationsRestore.id]: automationsRestore,
  [automationsDelete.id]: automationsDelete,
  [automationsPublish.id]: automationsPublish,
  [automationsSetPaused.id]: automationsSetPaused,
  [automationsSimulate.id]: automationsSimulate,
  [automationsLiveTest.id]: automationsLiveTest,
  [automationsRun.id]: automationsRun,
  [automationsRuns.id]: automationsRuns,
  [automationsGetRun.id]: automationsGetRun,
  [automationsCancelRun.id]: automationsCancelRun,
  [automationsDecideApproval.id]: automationsDecideApproval,
  [automationsWebhook.id]: automationsWebhook,
  [automationsRotateWebhook.id]: automationsRotateWebhook,
  [zapierList.id]: zapierList,
  [zapierCreate.id]: zapierCreate,
  [zapierUpdate.id]: zapierUpdate,
  [zapierDelete.id]: zapierDelete,
  [zapierRegenerateSecret.id]: zapierRegenerateSecret,
  [zapierEvents.id]: zapierEvents,
  [zapierSendTestEvent.id]: zapierSendTestEvent,
  [zapierSendTest.id]: zapierSendTest,
  [assistantConfig.id]: assistantConfig,
  [assistantConversations.id]: assistantConversations,
  [assistantDeleteConversation.id]: assistantDeleteConversation,
  [assistantUsage.id]: assistantUsage,
  [assistantSaveSettings.id]: assistantSaveSettings,
} as const;

export type Actions = typeof ACTIONS;
export type ActionId = keyof Actions;
export type ActionInput<Id extends ActionId> = z.input<Actions[Id]["input"]>;
export type ActionOutput<Id extends ActionId> = z.output<Actions[Id]["output"]>;

/** `profile.update` → `profile_update`: MCP tool names can't contain dots everywhere. */
export function toolName(id: string): string {
  return id.replace(/\./g, "_");
}

/** Every action's input and output as JSON Schema, for clients that generate their types. */
export function actionsJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Actions",
    description:
      "Every action's input and output. Generated by `pnpm --filter @template/contracts build`; don't edit.",
    actions: Object.fromEntries(
      Object.values(ACTIONS).map((action) => [
        action.id,
        {
          title: action.title,
          description: action.description,
          scope: action.scope,
          readOnly: action.readOnly,
          confirm: action.confirm ?? false,
          permission: action.permission ?? null,
          events: action.events ?? [],
          endpoint: `/api/actions/${action.id}`,
          tool: action.webOnly ? null : toolName(action.id),
          input: z.toJSONSchema(action.input, { io: "input", unrepresentable: "any" }),
          output: z.toJSONSchema(action.output, { io: "output", unrepresentable: "any" }),
        },
      ]),
    ),
  };
}
