import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ldAPIRequest, rateLimitRequest } from "./utils.ts";

function withFetch(
  responses: Array<Response | Error>,
  fn: () => Promise<void>,
) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((_input: Request | URL | string, _init?: RequestInit) => {
    const next = responses[Math.min(calls, responses.length - 1)];
    calls++;
    return next instanceof Error
      ? Promise.reject(next)
      : Promise.resolve(next.clone());
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  }).then(() => calls);
}

Deno.test("rateLimitRequest retries 5xx and network errors, then returns the successful response", async () => {
  const calls = await withFetch(
    [
      new Response("down", { status: 503 }),
      new TypeError("connection reset"),
      new Response("ok", { status: 200 }),
    ],
    async () => {
      const res = await rateLimitRequest(
        new Request("https://example.test/api/v2/flags/p"),
        "flags",
      );
      assertEquals(res.status, 200);
      assertEquals(await res.text(), "ok");
    },
  );
  assertEquals(calls, 3);
});

Deno.test("rateLimitRequest gives up on persistent 5xx and returns the last response", async () => {
  const calls = await withFetch(
    [new Response("down", { status: 502 })],
    async () => {
      const res = await rateLimitRequest(
        new Request("https://example.test/api/v2/flags/p"),
        "flags",
      );
      assertEquals(res.status, 502);
    },
  );
  assertEquals(calls, 4); // 1 + 3 retries
});

Deno.test("rateLimitRequest passes non-transient errors through untouched", async () => {
  const calls = await withFetch(
    [new Response("forbidden", { status: 403 })],
    async () => {
      const res = await rateLimitRequest(
        new Request("https://example.test/api/v2/flags/p"),
        "flags",
      );
      assertEquals(res.status, 403);
    },
  );
  assertEquals(calls, 1);
});

// A response whose headers arrive but whose body stream fails partway, as when a connection drops
function bodyDropsMidway(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"key":'));
      controller.error(new TypeError("error reading a body from connection"));
    },
  });
  return new Response(stream, { status: 200 });
}

// Like withFetch, but builds each response fresh (a failing stream cannot be cloned and replayed)
function withFetchFactory(
  responses: Array<() => Response>,
  fn: () => Promise<void>,
) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    const next = responses[Math.min(calls, responses.length - 1)];
    calls++;
    return Promise.resolve(next());
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  }).then(() => calls);
}

Deno.test("rateLimitRequest retries a GET whose body fails to arrive", async () => {
  const calls = await withFetchFactory(
    [
      bodyDropsMidway,
      () => new Response('{"key":"flag-a"}', { status: 200 }),
    ],
    async () => {
      const res = await rateLimitRequest(
        new Request("https://example.test/api/v2/flags/p/flag-a"),
        "flags",
      );
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { key: "flag-a" });
    },
  );
  assertEquals(calls, 2);
});

// The --incremental lifecycle/tags check of an unchanged flag: read the destination flag, then parse it
Deno.test("the lifecycle/tags read of a destination flag survives a body that drops once", async () => {
  const flag = { key: "flag-a", archived: false, deprecated: false, tags: [] };
  const calls = await withFetchFactory(
    [
      bodyDropsMidway,
      () => new Response(JSON.stringify(flag), { status: 200 }),
    ],
    async () => {
      const res = await rateLimitRequest(
        ldAPIRequest("api-key", "example.test", "flags/dest/flag-a"),
        "flags",
      );
      assertEquals(res.status, 200);
      assertEquals(await res.json(), flag);
    },
  );
  assertEquals(calls, 2);
});

Deno.test("AgentControl reads (ai-configs route) survive a body that drops once", async () => {
  const targeting = { environments: {}, variations: [] };
  const calls = await withFetchFactory(
    [
      bodyDropsMidway,
      bodyDropsMidway,
      () => new Response(JSON.stringify(targeting), { status: 200 }),
    ],
    async () => {
      const res = await rateLimitRequest(
        ldAPIRequest(
          "api-key",
          "example.test",
          "projects/p/ai-configs/cfg/targeting",
          true,
        ),
        "ai-configs",
      );
      assertEquals(await res.json(), targeting);
    },
  );
  assertEquals(calls, 3);
});

Deno.test("rateLimitRequest throws once body reads keep failing", async () => {
  const calls = await withFetchFactory([bodyDropsMidway], async () => {
    await assertRejects(
      () =>
        rateLimitRequest(
          new Request("https://example.test/api/v2/flags/p/flag-a"),
          "flags",
        ),
      TypeError,
      "error reading a body from connection",
    );
  });
  assertEquals(calls, 4); // 1 + 3 retries
});

Deno.test("a PATCH whose response body drops is not replayed, and keeps its status", async () => {
  const calls = await withFetchFactory([bodyDropsMidway], async () => {
    const res = await rateLimitRequest(
      new Request("https://example.test/api/v2/flags/p/flag-a", {
        method: "PATCH",
        body: "[]",
      }),
      "flags",
    );
    assertEquals(res.status, 200);
    assertStringIncludes(
      await res.text(),
      "response body could not be read: error reading a body from connection",
    );
  });
  assertEquals(calls, 1);
});

Deno.test("a rejected POST whose error body drops can still be reported", async () => {
  const calls = await withFetchFactory(
    [() => {
      const r = bodyDropsMidway();
      return new Response(r.body, { status: 400 });
    }],
    async () => {
      const res = await rateLimitRequest(
        new Request("https://example.test/api/v2/flags/p", {
          method: "POST",
          body: "{}",
        }),
        "flags",
      );
      assertEquals(res.status, 400);
      assertStringIncludes(await res.text(), "could not be read");
    },
  );
  assertEquals(calls, 1);
});

Deno.test("a GET whose JSON body arrives cut short is retried", async () => {
  const json = { "content-type": "application/json" };
  const calls = await withFetchFactory(
    [
      () => new Response('{"key":"flag-a","variations":[', { headers: json }),
      () => new Response('{"key":"flag-a"}', { headers: json }),
    ],
    async () => {
      const res = await rateLimitRequest(
        new Request("https://example.test/api/v2/flags/p/flag-a"),
        "flags",
      );
      assertEquals(await res.json(), { key: "flag-a" });
    },
  );
  assertEquals(calls, 2);
});

Deno.test("a GET whose JSON body is always cut short fails with the parse error", async () => {
  const calls = await withFetchFactory(
    [() =>
      new Response('{"key":', {
        headers: { "content-type": "application/json" },
      })],
    async () => {
      await assertRejects(
        () =>
          rateLimitRequest(
            new Request("https://example.test/api/v2/flags/p/flag-a"),
            "flags",
          ),
        SyntaxError,
      );
    },
  );
  assertEquals(calls, 4); // 1 + 3 retries
});

Deno.test("a GET body that is not JSON is returned as is", async () => {
  await withFetchFactory(
    [() => new Response("plain", { headers: { "content-type": "text/csv" } })],
    async () => {
      const res = await rateLimitRequest(
        new Request("https://example.test/api/v2/export"),
        "flags",
      );
      assertEquals(await res.text(), "plain");
    },
  );
  // NDJSON (big segment exports) is several documents, not one
  const ndjson = '{"key":"a"}\n{"key":"b"}\n';
  const calls = await withFetchFactory(
    [() =>
      new Response(ndjson, {
        headers: { "content-type": "application/x-ndjson" },
      })],
    async () => {
      const res = await rateLimitRequest(
        new Request("https://example.test/api/v2/export"),
        "big-segments",
      );
      assertEquals(await res.text(), ndjson);
    },
  );
  assertEquals(calls, 1);
});

Deno.test("rateLimitRequest returns empty bodies (204) without failing", async () => {
  await withFetchFactory(
    [() => new Response(null, { status: 204 })],
    async () => {
      const res = await rateLimitRequest(
        new Request("https://example.test/api/v2/flags/p/flag-a", {
          method: "DELETE",
        }),
        "flags",
      );
      assertEquals(res.status, 204);
      assertEquals(await res.text(), "");
    },
  );
});

Deno.test("rateLimitRequest does not replay POST or PATCH on transient failures", async () => {
  const calls = await withFetch(
    [new Response("down", { status: 503 })],
    async () => {
      const res = await rateLimitRequest(
        new Request("https://example.test/api/v2/flags/p", {
          method: "POST",
          body: "{}",
        }),
        "flags",
      );
      assertEquals(res.status, 503);
    },
  );
  assertEquals(calls, 1);
});
