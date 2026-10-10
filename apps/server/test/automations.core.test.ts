import { ActionError, emptyDefinition, type AutomationIssue } from "@template/contracts";
import { describe, expect, it } from "vitest";
import {
  checkFieldValues,
  ensureDeletable,
  ensureManualRun,
  ensurePayloadSize,
  ensureRunnable,
  liveTestDefinition,
  newAutomation,
  samplePathsObject,
  samplePayload,
  approvalDecision,
  approverAllowed,
  ensureCancellable,
  ensureDraftCurrent,
  ensurePublished,
  pauseChange,
  publication,
  triggerKeyOf,
} from "../src/modules/automations/core";

const now = new Date("2026-10-06T09:00:00Z");
const error: AutomationIssue = { severity: "error", message: "Pick an action." };
const warning: AutomationIssue = { severity: "warning", message: "Check the time zone." };

function code(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (failure) {
    return failure instanceof ActionError ? failure.code : "not an ActionError";
  }
}

describe("automations core", () => {
  it("keys triggers for dispatch", () => {
    expect(triggerKeyOf({ kind: "app.event", eventId: "profile.updated" } as never)).toBe(
      "app.event:profile.updated",
    );
    expect(triggerKeyOf({ kind: "manual" } as never)).toBe("manual");
  });

  it("refuses a draft save from an older revision", () => {
    expect(code(() => ensureDraftCurrent({ draftRevision: 3 }, 3))).toBeNull();
    expect(code(() => ensureDraftCurrent({ draftRevision: 4 }, 3))).toBe("conflict");
  });

  describe("publication", () => {
    const definition = emptyDefinition();
    const base = {
      automation: { draftRevision: 5 },
      reviewedRevision: 5,
      checked: { definition, issues: [warning] },
      latestVersion: 2,
      publisherId: "user-1",
      notes: "x".repeat(1200),
      now,
    };

    it("publishes the next version as the publisher", () => {
      const published = publication(base);
      expect(published.version).toBe(3);
      expect(published.versionRow).toMatchObject({
        version: 3,
        kind: "published",
        draftRevision: 5,
        publishedBy: "user-1",
      });
      expect(published.versionRow.notes).toHaveLength(1000);
      expect(published.automationChange).toMatchObject({
        activeVersion: 3,
        runAsUserId: "user-1",
        status: "active",
        consecutiveFailures: 0,
        updatedAt: now,
        triggerKey: triggerKeyOf(definition.trigger),
      });
    });

    it("starts at version 1", () => {
      expect(publication({ ...base, latestVersion: null }).version).toBe(1);
    });

    it("refuses a draft that changed after review", () => {
      expect(code(() => publication({ ...base, reviewedRevision: 4 }))).toBe("conflict");
    });

    it("refuses errors, with the issues attached, but not warnings", () => {
      let thrown: unknown;
      try {
        publication({ ...base, checked: { definition, issues: [error, warning] } });
      } catch (failure) {
        thrown = failure;
      }
      expect(thrown).toBeInstanceOf(ActionError);
      expect((thrown as ActionError).message).toContain("Fix 1 problem before publishing");
      expect((thrown as { issues?: unknown }).issues).toEqual([error, warning]);
      expect(code(() => publication({ ...base, checked: { definition: null, issues: [] } }))).toBe(
        "invalid_input",
      );
    });
  });

  it("pauses and resumes only published automations", () => {
    expect(code(() => ensurePublished({ activeVersion: null, runAsUserId: null }))).toBe(
      "conflict",
    );
    expect(ensurePublished({ activeVersion: 2, runAsUserId: "user-1" })).toEqual({
      activeVersion: 2,
    });
    expect(pauseChange(true, null, now)).toEqual({
      status: "paused",
      statusReason: null,
      updatedAt: now,
    });
    expect(pauseChange(false, [warning], now)).toMatchObject({
      status: "active",
      consecutiveFailures: 0,
    });
    expect(code(() => pauseChange(false, [error], now))).toBe("invalid_input");
  });

  it("lets only an approver decide a pending approval", () => {
    const viewer = { userId: "user-1", role: "member" as const };
    const byRole = { approvers: { roles: ["member" as const] }, status: "pending" as const };
    expect(approverAllowed(byRole.approvers, viewer)).toBe(true);
    expect(approverAllowed({ userIds: ["user-2"] }, viewer)).toBe(false);
    expect(approvalDecision(byRole, viewer, { decision: "approved", note: "ok" }, now)).toEqual({
      status: "approved",
      decidedBy: "user-1",
      decidedAt: now,
      note: "ok",
    });
    expect(
      code(() =>
        approvalDecision(
          { ...byRole, approvers: { userIds: ["user-2"] } },
          viewer,
          {
            decision: "approved",
          },
          now,
        ),
      ),
    ).toBe("forbidden");
    expect(
      code(() =>
        approvalDecision({ ...byRole, status: "approved" }, viewer, { decision: "rejected" }, now),
      ),
    ).toBe("conflict");
  });

  it("cancels only open runs", () => {
    expect(code(() => ensureCancellable({ status: "running" }))).toBeNull();
    expect(code(() => ensureCancellable({ status: "succeeded" }))).toBe("conflict");
  });

  it("starts a new automation as an empty draft", () => {
    const { row, revision } = newAutomation({ name: "  " }, { id: "a-1", ownerId: "user-1" });
    expect(row).toMatchObject({ id: "a-1", name: "Untitled automation", status: "draft" });
    expect(revision).toMatchObject({ revision: 1, source: "system", authorId: "user-1" });
  });

  it("deletes only drafts that were never published", () => {
    expect(code(() => ensureDeletable({ status: "draft", activeVersion: null }))).toBeNull();
    expect(code(() => ensureDeletable({ status: "paused", activeVersion: 1 }))).toBe("conflict");
  });

  it("live-tests only the reviewed revision, without errors", () => {
    const definition = emptyDefinition();
    expect(liveTestDefinition({ draftRevision: 2 }, 2, { definition, issues: [warning] })).toBe(
      definition,
    );
    expect(
      code(() => liveTestDefinition({ draftRevision: 3 }, 2, { definition, issues: [] })),
    ).toBe("conflict");
    expect(
      code(() => liveTestDefinition({ draftRevision: 2 }, 2, { definition, issues: [error] })),
    ).toBe("invalid_input");
  });

  it("runs by hand only active manual automations with valid fields", () => {
    expect(
      code(() => ensureRunnable({ status: "paused", activeVersion: 1, runAsUserId: "u" })),
    ).toBe("conflict");
    expect(ensureRunnable({ status: "active", activeVersion: 1, runAsUserId: "u" })).toEqual({
      activeVersion: 1,
      runAsUserId: "u",
    });
    const fields = [
      { key: "ticket", label: "Ticket", type: "text", required: true },
      { key: "to", label: "To", type: "email", required: false },
    ] as never;
    const manual = { ...emptyDefinition(), trigger: { kind: "manual", fields } } as never;
    expect(checkFieldValues(fields, { to: "nope" })).toEqual([
      "Ticket is required.",
      "To should be an email address.",
    ]);
    expect(code(() => ensureManualRun(manual, { ticket: "STRAW-1" }))).toBeNull();
    expect(code(() => ensureManualRun(manual, {}))).toBe("invalid_input");
    const scheduled = { ...emptyDefinition(), trigger: { kind: "schedule" } } as never;
    expect(code(() => ensureManualRun(scheduled, {}))).toBe("conflict");
    expect(code(() => ensurePayloadSize("x".repeat(70_000), "Too large."))).toBe("invalid_input");
  });

  it("builds sample payloads from paths and the trigger", () => {
    expect(
      samplePathsObject([
        { path: "trigger.data.name", type: "string" },
        { path: "trigger.data.items.0", type: "number" },
      ] as never),
    ).toMatchObject({ data: { name: expect.anything(), items: [expect.anything()] } });
    const known = {
      actor: { id: "user-1", name: "Bea" },
      organizationId: "org-1",
      latestZapierPayload: null,
      now,
    };
    expect(
      samplePayload(
        { ...emptyDefinition(), trigger: { kind: "webhook" } } as never,
        { triggers: [] },
        known,
      ),
    ).toEqual({ body: {}, deliveryId: "sample", receivedAt: now.toISOString() });
    const zapier = { ...emptyDefinition(), trigger: { kind: "zapier.event", when: [] } } as never;
    expect(
      samplePayload(zapier, { triggers: [] }, { ...known, latestZapierPayload: { real: true } }),
    ).toEqual({ real: true });
  });
});
