import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  RUN_RECORD_SCHEMA_VERSION,
  runMode,
  type RunRecord,
  runRecordPaths,
  writeRunRecord,
} from "./run_record.ts";

Deno.test("runMode names the run by its scope", () => {
  assertEquals(runMode({ dryRun: true, incremental: true }), "dry-run");
  assertEquals(runMode({ includeFlags: "a,b", incremental: true }), "targeted");
  assertEquals(runMode({ since: "2026-10-01" }), "since");
  assertEquals(runMode({ incremental: true }), "incremental");
  assertEquals(runMode({}), "full");
});

Deno.test("runRecordPaths uses a file-name-safe timestamp and one directory per project pair", () => {
  assertEquals(
    runRecordPaths("2026-10-23T09:15:00.123Z", "default", "default", "/d"),
    {
      path: "/d/runs/default/default/2026-10-23T09-15-00-123Z.json",
      latestPath: "/d/runs/default/default/latest.json",
    },
  );
  // a-b -> c and a -> b-c no longer share a latest record
  assertEquals(
    runRecordPaths("2026-10-23T09:15:00.123Z", "a-b", "c", "/d").latestPath ===
      runRecordPaths("2026-10-23T09:15:00.123Z", "a", "b-c", "/d").latestPath,
    false,
  );
});

Deno.test("writeRunRecord writes the record and the latest copy", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const record = {
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      startedAt: "2026-10-23T09:15:00.000Z",
      source: { projectKey: "src" },
      destination: { projectKey: "dst", domain: "app.eu.launchdarkly.com" },
    } as RunRecord;
    const path = await writeRunRecord(record, dir);
    assertEquals(JSON.parse(await Deno.readTextFile(path)), record);
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${dir}/runs/src/dst/latest.json`)),
      record,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
