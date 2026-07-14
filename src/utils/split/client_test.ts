import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { SplitApiError, SplitClient } from "./client.ts";

type StubHandler = (req: Request) => Response;

/** Builds a SplitClient whose fetch is served by `handler`; records requests. */
function stubClient(handler: StubHandler): { client: SplitClient; requests: Request[] } {
  const requests: Request[] = [];
  const client = new SplitClient("test-key", {
    fetchFn: (req) => {
      requests.push(req);
      return Promise.resolve(handler(req));
    },
    delayFn: () => Promise.resolve(),
  });
  return { client, requests };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

Deno.test("sends Bearer auth and query params", async () => {
  const { client, requests } = stubClient(() =>
    json({ objects: [], offset: 0, limit: 50, totalCount: 0 })
  );

  await client.listFlags("ws-1", "checkout");

  assertEquals(requests.length, 1);
  assertEquals(requests[0].headers.get("authorization"), "Bearer test-key");
  const url = new URL(requests[0].url);
  assertEquals(url.pathname, "/internal/api/v2/splits/ws/ws-1");
  assertEquals(url.searchParams.get("tag"), "checkout");
  assertEquals(url.searchParams.get("limit"), "50");
  assertEquals(url.searchParams.get("offset"), "0");
});

Deno.test("paginates objects envelope until totalCount reached", async () => {
  const pages = [
    { objects: [{ name: "a" }, { name: "b" }], offset: 0, limit: 2, totalCount: 3 },
    { objects: [{ name: "c" }], offset: 2, limit: 2, totalCount: 3 },
  ];
  const { client, requests } = stubClient((req) => {
    const offset = Number(new URL(req.url).searchParams.get("offset"));
    return json(offset === 0 ? pages[0] : pages[1]);
  });

  const flags = await client.listFlags("ws-1");

  assertEquals(flags.map((f) => f.name), ["a", "b", "c"]);
  assertEquals(requests.length, 2);
});

Deno.test("pagination terminates on empty page even if totalCount is missing", async () => {
  const { client, requests } = stubClient((req) => {
    const offset = Number(new URL(req.url).searchParams.get("offset"));
    if (offset === 0) {
      return json({ objects: [{ name: "a" }], offset: 0, limit: 50 });
    }
    return json({ objects: [], offset, limit: 50 });
  });

  const flags = await client.listFlags("ws-1");

  assertEquals(flags.map((f) => f.name), ["a"]);
  assertEquals(requests.length, 2);
});

Deno.test("retries 429 with retry-after header, then succeeds", async () => {
  let calls = 0;
  const { client, requests } = stubClient(() => {
    calls++;
    if (calls === 1) {
      return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
    }
    return json({ objects: [], offset: 0, limit: 50, totalCount: 0 });
  });

  const flags = await client.listFlags("ws-1");

  assertEquals(flags, []);
  assertEquals(requests.length, 2);
});

Deno.test("throws SplitApiError with API message on non-2xx", async () => {
  const { client } = stubClient(() =>
    json({ code: 404, message: "Could not find environment Production" }, 404)
  );

  const err = await assertRejects(
    () => client.listFlagDefinitions("ws-1", "Production"),
    SplitApiError,
    "Could not find environment Production",
  );
  assertEquals(err.status, 404);
});

Deno.test("getSegmentKeys paginates the keys/count envelope", async () => {
  const { client, requests } = stubClient((req) => {
    const offset = Number(new URL(req.url).searchParams.get("offset"));
    if (offset === 0) {
      return json({ keys: [{ key: "u1" }, { key: "u2" }], count: 3, offset: 0, limit: 2 });
    }
    return json({ keys: [{ key: "u3" }], count: 3, offset: 2, limit: 2 });
  });

  const keys = await client.getSegmentKeys("env-1", "beta-users");

  assertEquals(keys, ["u1", "u2", "u3"]);
  assertEquals(requests.length, 2);
  assertEquals(
    new URL(requests[0].url).pathname,
    "/internal/api/v2/segments/env-1/beta-users/keys",
  );
});

Deno.test("non-paginated endpoints return plain arrays", async () => {
  const { client } = stubClient((req) => {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/environments/ws/ws-1")) {
      return json([{ id: "e1", name: "Prod-Default" }]);
    }
    return json([{ id: "t1", name: "user", displayAttributeId: "userId" }]);
  });

  const envs = await client.getEnvironments("ws-1");
  const tts = await client.getTrafficTypes("ws-1");

  assertEquals(envs[0].name, "Prod-Default");
  assertEquals(tts[0].name, "user");
});

Deno.test("listFlagSets tolerates data, objects, and bare-array envelopes", async () => {
  for (
    const body of [
      { data: [{ id: "fs1", name: "checkout" }] },
      { objects: [{ id: "fs1", name: "checkout" }] },
      [{ id: "fs1", name: "checkout" }],
    ]
  ) {
    const { client, requests } = stubClient(() => json(body));
    const sets = await client.listFlagSets("ws-1");
    assertEquals(sets.map((s) => s.name), ["checkout"]);
    const url = new URL(requests[0].url);
    assertEquals(url.pathname, "/internal/api/v3/flag-sets");
    assertEquals(url.searchParams.get("workspace_id"), "ws-1");
  }
});
