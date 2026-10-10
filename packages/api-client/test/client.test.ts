import { describe, expect, it } from "vitest";
import { ApiClientError, createApiClient } from "../src";

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("api client", () => {
  it("calls actions as client.<module>.<name>(input)", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ id: "u1", name: "Bea" }));
    const client = createApiClient({ fetch });
    const profile = await client.profile.update({ title: "Founder" });
    expect(profile.name).toBe("Bea");
    expect(calls[0]?.url).toBe("/api/actions/profile.update");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ title: "Founder" }));
    await client.profile.get();
    expect(calls[1]?.init.body).toBe("{}");
  });

  it("throws ApiClientError with the server's code, fields and request id", async () => {
    const { fetch } = fakeFetch(() =>
      Response.json(
        {
          ok: false,
          error: {
            code: "invalid_input",
            message: "Enter your name.",
            fields: { name: "Enter your name." },
            requestId: "r1",
          },
        },
        { status: 400 },
      ),
    );
    const seen: ApiClientError[] = [];
    const client = createApiClient({ fetch, onError: (e) => seen.push(e) });
    const error = await client.profile.update({ name: "" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      code: "invalid_input",
      fields: { name: "Enter your name." },
      requestId: "r1",
      status: 400,
    });
    expect(seen).toHaveLength(1);
  });

  it("sends a bearer token when it has one", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({}));
    await createApiClient({ fetch, baseUrl: "https://app.test", token: () => "t1" }).profile.get();
    expect(calls[0]?.url).toBe("https://app.test/api/actions/profile.get");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer t1");
  });

  it("builds the Google start URL with the return path", () => {
    expect(createApiClient().auth.googleUrl("/oauth/consent?handle=h")).toBe(
      "/auth/google/start?returnTo=%2Foauth%2Fconsent%3Fhandle%3Dh",
    );
  });
});
