import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assertNotSelfMigration, getAccountId } from "./account_guard.ts";

const accountFetch = (accounts: Record<string, string>, calls: string[] = []) =>
  ((input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    const token = new Headers(init?.headers).get("Authorization") ?? "";
    const accountId = accounts[token];
    return Promise.resolve(
      accountId
        ? new Response(JSON.stringify({ accountId }), { status: 200 })
        : new Response("unauthorized", { status: 401 }),
    );
  }) as typeof fetch;

const deps = (fetchFn: typeof fetch, warnings: string[] = []) => ({
  fetchFn,
  getSourceKey: () => Promise.resolve("src-token"),
  getDestinationKey: () => Promise.resolve("dest-token"),
  warn: (m: string) => warnings.push(m),
});

const samePairs = [{ source: "a", destination: "a" }];

Deno.test("getAccountId reads accountId from caller-identity", async () => {
  const calls: string[] = [];
  const id = await getAccountId(
    "src-token",
    "ld-stg.launchdarkly.com",
    accountFetch({ "src-token": "acct-1" }, calls),
  );
  assertEquals(id, "acct-1");
  assertEquals(calls, [
    "https://ld-stg.launchdarkly.com/api/v2/caller-identity",
  ]);
});

Deno.test("same account and same key throws", async () => {
  await assertRejects(
    () =>
      assertNotSelfMigration(
        [...samePairs, { source: "b", destination: "new-b" }],
        "ld-stg.launchdarkly.com",
        "ld-stg.launchdarkly.com",
        deps(accountFetch({ "src-token": "acct", "dest-token": "acct" })),
      ),
    Error,
    "migrating a would write into the source project",
  );
});

Deno.test("different accounts pass", async () => {
  await assertNotSelfMigration(
    samePairs,
    undefined,
    "app.launchdarkly.com",
    deps(accountFetch({ "src-token": "acct-1", "dest-token": "acct-2" })),
  );
});

Deno.test("same account passes when every pair maps to a new key", async () => {
  const calls: string[] = [];
  await assertNotSelfMigration(
    [{ source: "a", destination: "a-copy" }],
    "app.launchdarkly.com",
    "app.launchdarkly.com",
    deps(accountFetch({ "src-token": "acct", "dest-token": "acct" }, calls)),
  );
  assertEquals(calls, []);
});

Deno.test("different domains make no API calls", async () => {
  const calls: string[] = [];
  await assertNotSelfMigration(
    samePairs,
    "ld-stg.launchdarkly.com",
    "app.launchdarkly.com",
    deps(accountFetch({}, calls)),
  );
  assertEquals(calls, []);
});

Deno.test("a failed lookup warns and continues", async () => {
  const warnings: string[] = [];
  await assertNotSelfMigration(
    samePairs,
    "app.launchdarkly.com",
    undefined,
    deps(accountFetch({ "src-token": "acct" }), warnings),
  );
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("caller-identity returned 401"), true);
});

Deno.test("same account with a chained mapping (a -> b, b -> c) throws and names the pair", async () => {
  await assertRejects(
    () =>
      assertNotSelfMigration(
        [{ source: "a", destination: "b" }, { source: "b", destination: "c" }],
        "app.launchdarkly.com",
        "app.launchdarkly.com",
        deps(accountFetch({ "src-token": "acct", "dest-token": "acct" })),
      ),
    Error,
    "migrating a -> b would write into the source project",
  );
});

Deno.test("chained mapping passes when the accounts differ", async () => {
  await assertNotSelfMigration(
    [{ source: "a", destination: "b" }, { source: "b", destination: "c" }],
    "app.launchdarkly.com",
    "app.launchdarkly.com",
    deps(accountFetch({ "src-token": "acct-1", "dest-token": "acct-2" })),
  );
});

Deno.test("destinations that are not source keys make no API calls", async () => {
  const calls: string[] = [];
  await assertNotSelfMigration(
    [{ source: "a", destination: "x" }, { source: "b", destination: "y" }],
    "app.launchdarkly.com",
    "app.launchdarkly.com",
    deps(accountFetch({ "src-token": "acct", "dest-token": "acct" }, calls)),
  );
  assertEquals(calls, []);
});
