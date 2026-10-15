import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { rateLimitRequest } from "./utils.ts";

function withFetch(responses: Array<Response | Error>, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((_input: Request | URL | string, _init?: RequestInit) => {
    const next = responses[Math.min(calls, responses.length - 1)];
    calls++;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next.clone());
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  }).then(() => calls);
}

Deno.test("rateLimitRequest retries 5xx and network errors, then returns the successful response", async () => {
  const calls = await withFetch(
    [new Response("down", { status: 503 }), new TypeError("connection reset"), new Response("ok", { status: 200 })],
    async () => {
      const res = await rateLimitRequest(new Request("https://example.test/api/v2/flags/p"), "flags");
      assertEquals(res.status, 200);
      assertEquals(await res.text(), "ok");
    },
  );
  assertEquals(calls, 3);
});

Deno.test("rateLimitRequest gives up on persistent 5xx and returns the last response", async () => {
  const calls = await withFetch([new Response("down", { status: 502 })], async () => {
    const res = await rateLimitRequest(new Request("https://example.test/api/v2/flags/p"), "flags");
    assertEquals(res.status, 502);
  });
  assertEquals(calls, 4); // 1 + 3 retries
});

Deno.test("rateLimitRequest passes non-transient errors through untouched", async () => {
  const calls = await withFetch([new Response("forbidden", { status: 403 })], async () => {
    const res = await rateLimitRequest(new Request("https://example.test/api/v2/flags/p"), "flags");
    assertEquals(res.status, 403);
  });
  assertEquals(calls, 1);
});

Deno.test("rateLimitRequest does not replay POST or PATCH on transient failures", async () => {
  const calls = await withFetch([new Response("down", { status: 503 })], async () => {
    const res = await rateLimitRequest(
      new Request("https://example.test/api/v2/flags/p", { method: "POST", body: "{}" }),
      "flags",
    );
    assertEquals(res.status, 503);
  });
  assertEquals(calls, 1);
});
