import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  actionsJsonSchema,
  isUuid,
  normalizeScopes,
  ProfileUpdateInput,
  SignUpInput,
  toolName,
  uuidv7,
} from "../src";

describe("uuidv7", () => {
  it("is a valid UUID with version 7 and sorts by time", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(isUuid(a)).toBe(true);
    expect(a[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(a[19]);
    expect(a < b).toBe(true);
  });
});

describe("scopes", () => {
  it("always grants read and drops unknown scopes", () => {
    expect(normalizeScopes([])).toEqual(["profile:read", "organization:read"]);
    expect(normalizeScopes(["profile:write", "admin:everything"])).toEqual([
      "profile:read",
      "profile:write",
      "organization:read",
    ]);
  });
});

describe("schemas", () => {
  it("normalizes email and enforces the password length", () => {
    const parsed = SignUpInput.safeParse({
      name: " Bea ",
      email: " Bea@ThreePigs.Example ",
      password: "short",
    });
    expect(parsed.success).toBe(false);
    const ok = SignUpInput.parse({
      name: " Bea ",
      email: " Bea@ThreePigs.Example ",
      password: "brick-by-brick",
    });
    expect(ok).toEqual({
      name: "Bea",
      email: "bea@threepigs.example",
      password: "brick-by-brick",
    });
  });

  it("needs something to change in a profile update", () => {
    expect(ProfileUpdateInput.safeParse({}).success).toBe(false);
    expect(ProfileUpdateInput.safeParse({ title: "" }).success).toBe(true);
  });
});

describe("actions", () => {
  it("names tools from ids", () => {
    expect(Object.keys(ACTIONS).map(toolName)).toEqual([
      "profile_get",
      "profile_update",
      "organization_get",
      "organization_update",
      "organization_transferOwnership",
      "organization_leave",
      "organization_delete",
      "members_list",
      "members_updateRole",
      "members_remove",
      "invites_list",
      "invites_create",
      "invites_resend",
      "invites_revoke",
      "automations_list",
      "automations_catalog",
      "automations_get",
      "automations_create",
      "automations_saveDraft",
      "automations_restore",
      "automations_delete",
      "automations_publish",
      "automations_setPaused",
      "automations_simulate",
      "automations_liveTest",
      "automations_run",
      "automations_runs",
      "automations_getRun",
      "automations_cancelRun",
      "automations_decideApproval",
      "automations_webhook",
      "automations_rotateWebhook",
      "zapier_list",
      "zapier_create",
      "zapier_update",
      "zapier_delete",
      "zapier_regenerateSecret",
      "zapier_events",
      "zapier_sendTestEvent",
      "zapier_sendTest",
      "assistant_config",
      "assistant_conversations",
      "assistant_deleteConversation",
      "assistant_usage",
      "assistant_saveSettings",
    ]);
  });

  it("keeps actions.schema.json up to date", () => {
    const committed = readFileSync(new URL("../actions.schema.json", import.meta.url), "utf8");
    expect(JSON.parse(committed)).toEqual(JSON.parse(JSON.stringify(actionsJsonSchema())));
  });
});
