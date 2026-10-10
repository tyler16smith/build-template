import { ActionError, emptyDefinition, ZAPIER_LIMITS } from "@template/contracts";
import { describe, expect, it } from "vitest";
import {
  connectionChange,
  connectionUsage,
  connectionView,
  deletion,
  ensureDirection,
  hookHint,
  newConnection,
  testSendOutcome,
} from "../src/modules/zapier/core";

const now = new Date("2026-10-06T09:00:00Z");

function code(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (failure) {
    return failure instanceof ActionError ? failure.code : "not an ActionError";
  }
}

const onConnection = (connectionId?: string) => ({
  ...emptyDefinition(),
  trigger: { kind: "zapier.event", connectionId, when: [] },
});
const sendingTo = (connectionId: string) => ({
  ...emptyDefinition(),
  steps: [{ id: "send", kind: "zapier.send", connectionId }],
});

describe("zapier core", () => {
  it("counts which active automations use each connection", () => {
    const used = connectionUsage(
      [onConnection("a"), onConnection(), sendingTo("b"), sendingTo("a")].map((definition) => ({
        definition: definition as never,
      })),
    );
    expect(used.any).toBe(1);
    expect(Object.fromEntries(used.byConnection)).toEqual({ a: 2, b: 1 });
  });

  it("shows a connection without its secret, counting automations that take any inbound one", () => {
    const row = {
      id: "a",
      direction: "inbound" as const,
      name: "Huff & Puff Testing",
      status: "active" as const,
      hint: "1977",
      createdBy: "user-1",
      createdAt: now,
      lastUsedAt: now,
      lastProvider: "hubspot",
      lastEventType: "deal.closed_won",
    };
    const view = connectionView(row, "https://app.test", new Map([["user-1", "Bea"]]), {
      any: 1,
      byConnection: new Map([["a", 2]]),
    });
    expect(view).toMatchObject({
      url: "https://app.test/hooks/zapier/a/events",
      createdBy: "Bea",
      automationCount: 3,
      lastEvent: { provider: "hubspot", eventType: "deal.closed_won" },
    });
    const outbound = connectionView(
      { ...row, direction: "outbound", createdBy: null },
      "https://app.test",
      new Map(),
      { any: 1, byConnection: new Map() },
    );
    expect(outbound).toMatchObject({
      url: null,
      createdBy: "Former member",
      automationCount: 0,
      lastEvent: null,
    });
  });

  it("names new connections and caps how many a company has", () => {
    expect(newConnection({ direction: "inbound" }, 0).name).toBe("Zapier events");
    expect(newConnection({ direction: "outbound", url: "x", name: " Sheets " }, 0).name).toBe(
      "Sheets",
    );
    expect(
      code(() =>
        newConnection({ direction: "inbound" }, ZAPIER_LIMITS.maxConnectionsPerOrganization),
      ),
    ).toBe("conflict");
    expect(hookHint("https://hooks.zapier.com/hooks/catch/123456/abcdef/")).toBe("abcdef");
  });

  it("changes only what was given", () => {
    expect(connectionChange({ status: "disabled" }, now)).toEqual({
      status: "disabled",
      updatedAt: now,
    });
  });

  it("keeps secrets inbound and test sends outbound", () => {
    expect(code(() => ensureDirection({ direction: "inbound" }, "inbound"))).toBeNull();
    expect(code(() => ensureDirection({ direction: "outbound" }, "inbound"))).toBe("conflict");
  });

  it("fails the active automations that use a deleted connection", () => {
    const { stopped, change } = deletion(
      { id: "a", name: "Huff & Puff Testing" },
      [
        { id: "uses-trigger", definition: onConnection("a") as never },
        { id: "uses-step", definition: sendingTo("a") as never },
        { id: "other", definition: onConnection("b") as never },
      ],
      now,
    );
    expect(stopped).toEqual(["uses-trigger", "uses-step"]);
    expect(change).toMatchObject({ status: "failed", updatedAt: now });
    expect(change.statusReason).toContain("Huff & Puff Testing");
  });

  it("explains a test send Zapier didn't accept", () => {
    expect(testSendOutcome(200)).toBe(200);
    expect(code(() => testSendOutcome(null))).toBe("conflict");
    expect(code(() => testSendOutcome(410))).toBe("conflict");
  });
});
