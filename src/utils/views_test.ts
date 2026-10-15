import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractViews } from "./views.ts";

/** Serves `routes` by path (query string stripped except offset) and records every URL fetched. */
function withViewsApi(
  routes: Record<string, (offset: number) => unknown>,
  fn: () => Promise<void>,
): Promise<string[]> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: Request | URL | string) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname + url.search);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const handler = routes[url.pathname];
    const body = handler ? handler(offset) : null;
    return Promise.resolve(
      body === null
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  }).then(() => calls);
}

const flagItems = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ resourceKey: `flag-${from + i}` }));

Deno.test("extractViews keeps paging linked flags when the beta endpoint omits totalCount", async () => {
  const calls = await withViewsApi({
    "/api/v2/projects/p/views": () => ({ items: [{ key: "v1", name: "View 1" }] }),
    // 50 + 10 items, no totalCount: the short second page ends the list
    "/api/v2/projects/p/views/v1/linked/flags": (offset) => ({ items: offset === 0 ? flagItems(0, 50) : flagItems(50, 10) }),
    "/api/v2/projects/p/views/v1/linked/segments": () => ({ items: [] }),
  }, async () => {
    const [view] = await extractViews("token", "app.launchdarkly.com", "p");
    assertEquals(view.flags.length, 60);
    assertEquals(view.flags[59], "flag-59");
  });
  const flagPages = calls.filter((c) => c.includes("/linked/flags"));
  assertEquals(flagPages.length, 2);
});

Deno.test("extractViews stops at totalCount when it is present", async () => {
  const calls = await withViewsApi({
    "/api/v2/projects/p/views": () => ({ items: [{ key: "v1", name: "View 1" }], totalCount: 1 }),
    "/api/v2/projects/p/views/v1/linked/flags": () => ({ items: flagItems(0, 50), totalCount: 50 }),
    "/api/v2/projects/p/views/v1/linked/segments": () => ({ items: [], totalCount: 0 }),
  }, async () => {
    const [view] = await extractViews("token", "app.launchdarkly.com", "p");
    assertEquals(view.flags.length, 50);
  });
  assertEquals(calls.filter((c) => c.includes("/linked/flags")).length, 1);
});
