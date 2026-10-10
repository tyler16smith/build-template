import { describe, expect, it } from "vitest";
import { isUuid, metricDataPoint, METRIC_SCHEMA } from "@template/contracts";
import { registryProblems } from "../src/actions/registry";
import { fingerprint, firstOwnFrame } from "../src/lib/errors";
import { Logger, setLogSink } from "../src/lib/log";
import { redactText } from "../src/lib/redact";
import { Browser, call, ORIGIN } from "./helpers";

describe("the request pipeline", () => {
  it("gives every response a request id, and every error body the same one", async () => {
    const response = await call(new Request(`${ORIGIN}/api/nowhere`));
    expect(response.status).toBe(404);
    const requestId = response.headers.get("x-request-id");
    expect(isUuid(requestId)).toBe(true);
    const body = (await response.json()) as { error: { code: string; requestId: string } };
    expect(body.error).toMatchObject({ code: "not_found", requestId });
  });

  it("answers the health check as app_runtime, with the version", async () => {
    const response = await call(new Request(`${ORIGIN}/api/health`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: "local", commit: "local" });
  });

  it("refuses a write from another origin (CSRF)", async () => {
    const response = await new Browser().fetch("/api/auth/sign-in", {
      json: { email: "bea@threepigs.example", password: "x" },
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });

  it("has a handler for every action contract", () => {
    expect(registryProblems()).toEqual([]);
  });
});

describe("logging", () => {
  it("never writes a password, a session token, an OAuth code or an email", () => {
    const lines: string[] = [];
    const previous = setLogSink((_level, line) => lines.push(line));
    try {
      const secrets = {
        password: "brick-by-brick-123",
        session: "Ux3kA9_s0meSessionTokenValue_7hQ2pL0vZ8yW",
        code: "u123e4567:g98765:Zm9vYmFyYmF6cXV4c2VjcmV0Y29kZQ",
        email: "bea@threepigs.example",
      };
      const log = new Logger({ requestId: "r1" });
      log.info("test.fields", {
        password: secrets.password,
        currentPassword: secrets.password,
        code: secrets.code,
        token: secrets.session,
        email: secrets.email,
        nested: {
          cookie: `__Host-session=${secrets.session}`,
          authorization: `Bearer ${secrets.session}`,
        },
      });
      log.error("test.text", {
        error: `failed for ${secrets.email} with cookie __Host-session=${secrets.session} at /auth/google/callback?code=${secrets.code}&state=abc`,
        detail: `Authorization: Bearer ${secrets.session}`,
      });
      // Context passed by mistake (a sign-in result holds the session) keeps only known ids.
      log
        .with({ userId: "u1", session: { token: secrets.session } } as never)
        .info("test.context", { session: { cookie: `__Host-session=${secrets.session}` } });
      const output = lines.join("\n");
      for (const secret of Object.values(secrets)) expect(output).not.toContain(secret);
      expect(output).toContain('"requestId":"r1"');
    } finally {
      setLogSink(previous);
    }
  });

  it("keeps ids readable", () => {
    for (const id of [
      "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      "0199d5a0-0000-7000-8000-000000000065",
    ])
      expect(redactText(id)).toBe(id);
    expect(redactText("call +1 (801) 555-0134 now")).toBe("call [number] now");
  });
});

describe("errors and metrics", () => {
  it("fingerprints by name, frame and route, not by message", async () => {
    const make = (message: string) => {
      const error = new TypeError(message);
      error.stack = `TypeError: ${message}\n    at handler (src/modules/profile/actions.ts:12:5)\n    at node_modules/hono/dist/index.js:1:1`;
      return error;
    };
    expect(firstOwnFrame(make("x").stack)).toBe("handler@src/modules/profile/actions.ts");
    const a = await fingerprint(make("user 1 broke"), "action:profile.get");
    const b = await fingerprint(make("user 2 broke"), "action:profile.get");
    const c = await fingerprint(make("user 1 broke"), "action:profile.update");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("writes points in METRIC_SCHEMA order, with the fingerprint only on failures", () => {
    const point = metricDataPoint({
      organizationId: "org",
      kind: "action",
      name: "profile.get",
      outcome: "expected_error",
      errorCode: "not_found",
      version: "abc123",
      fingerprint: "f00d",
      requestId: "req",
      durationMs: 12,
      status: 404,
      roundTrips: 1,
    });
    expect(point.blobs).toHaveLength(METRIC_SCHEMA.blobs.length);
    expect(point.doubles).toHaveLength(METRIC_SCHEMA.doubles.length);
    expect(point.blobs).toEqual([
      "action",
      "profile.get",
      "expected_error",
      "not_found",
      "abc123",
      "",
      "",
      "req",
    ]);
    expect(
      metricDataPoint({
        ...{
          organizationId: null,
          kind: "job",
          name: "cleanup",
          outcome: "failure",
          version: "v",
          fingerprint: "f00d",
          durationMs: 1,
        },
      }).blobs[6],
    ).toBe("f00d");
  });

  it("logs browser errors, and rate limits them", async () => {
    const browser = new Browser();
    const report = { kind: "error", message: "Boom at bea@threepigs.example", path: "/profile" };
    const first = await browser.fetch("/api/client-errors", { json: report });
    expect(first.status).toBe(204);
    let last = first.status;
    for (let i = 0; i < 4; i++)
      last = (await browser.fetch("/api/client-errors", { json: report })).status;
    expect(last).toBe(429);
  });
});
