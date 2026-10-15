import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  manifestDestinationFlagKeys,
  readSyncManifest,
  type SyncManifest,
  syncManifestPath,
} from "./sync_manifest.ts";

const manifest: SyncManifest = {
  lastSyncTimestamp: "2026-10-15T10:00:00.000Z",
  sourceProject: "payroll",
  destProject: "new-project",
  flags: {
    shared: { version: 3, environments: {}, destKey: "imported-shared" },
    "only-payroll": { version: 1, environments: {} },
  },
};

Deno.test("syncManifestPath matches the file migrate writes", () => {
  assertEquals(
    syncManifestPath("payroll", "new-project"),
    "./data/launchdarkly-migrations/sync-manifest-payroll-new-project.json",
  );
  assertEquals(syncManifestPath("a", "b", "/tmp/x"), "/tmp/x/sync-manifest-a-b.json");
});

Deno.test("manifestDestinationFlagKeys prefers destKey over the source key", () => {
  assertEquals(manifestDestinationFlagKeys(manifest), ["imported-shared", "only-payroll"]);
});

Deno.test("readSyncManifest returns null when there is no manifest and parses one when there is", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await readSyncManifest("payroll", "new-project", dir), null);
    await Deno.writeTextFile(syncManifestPath("payroll", "new-project", dir), JSON.stringify(manifest));
    assertEquals(await readSyncManifest("payroll", "new-project", dir), manifest);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readSyncManifest throws on an unreadable manifest instead of treating it as missing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(syncManifestPath("a", "b", dir), "{not json");
    await assertRejects(() => readSyncManifest("a", "b", dir), SyntaxError);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
