import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  detectFlagEdits,
  detectSegmentEdit,
  nextFlagTargetRecord,
  nextSegmentTargetRecord,
  NO_FLAG_EDITS,
  observeFlag,
  observeSegment,
  protectsFlagLevel,
} from "./target_guard.ts";

const destFlag = (
  overrides: { name?: string; on?: boolean; stageOn?: boolean } = {},
) => ({
  _version: 7,
  name: overrides.name ?? "Checkout",
  description: "",
  tags: ["b", "a"],
  temporary: false,
  variations: [{ _id: "v1", value: true }, { _id: "v2", value: false }],
  archived: false,
  deprecated: false,
  environments: {
    production: {
      version: 3,
      lastModified: 1_000,
      on: overrides.on ?? false,
      offVariation: 1,
      fallthrough: { variation: 0 },
      rules: [{
        _id: "r1",
        clauses: [{ _id: "c1", attribute: "key", op: "in", values: ["x"] }],
      }],
      targets: [],
      _summary: { variations: {} },
      salt: "s",
    },
    stage: {
      version: 5,
      lastModified: 2_000,
      on: overrides.stageOn ?? true,
      offVariation: 1,
      fallthrough: { variation: 0 },
      rules: [],
      targets: [],
    },
  },
});

const ENVS = ["production", "stage"];

Deno.test("observeFlag ignores generated IDs, tag order and non-content fields", async () => {
  const a = await observeFlag(destFlag(), ENVS);
  const b = destFlag();
  b.tags = ["a", "b"];
  b.variations = b.variations.map((v, i) => ({ ...v, _id: `other-${i}` }));
  b.environments.production.rules[0]._id = "other";
  b.environments.production.salt = "other";
  b.environments.production.version = 9;
  b._version = 12;
  const observedB = await observeFlag(b, ENVS);
  assertEquals(observedB.fingerprint, a.fingerprint);
  assertEquals(
    observedB.environments!.production.fingerprint,
    a.environments!.production.fingerprint,
  );
  assertEquals(observedB.environments!.production.version, 9);
});

Deno.test("detectFlagEdits finds an environment edited in the destination", async () => {
  const recorded = await observeFlag(destFlag(), ENVS);
  const entry = { dest: recorded };
  const now = await observeFlag(destFlag({ on: true }), ENVS);
  const edits = detectFlagEdits(entry, now, ENVS);
  assertEquals(edits, {
    flagLevel: false,
    environments: ["production"],
    deleted: false,
  });
  assertEquals(protectsFlagLevel(edits), true);
});

Deno.test("detectFlagEdits finds flag-level edits and nothing when unchanged", async () => {
  const recorded = await observeFlag(destFlag(), ENVS);
  const entry = { dest: recorded };
  assertEquals(
    detectFlagEdits(entry, await observeFlag(destFlag(), ENVS), ENVS),
    NO_FLAG_EDITS,
  );
  assertEquals(
    detectFlagEdits(
      entry,
      await observeFlag(destFlag({ name: "Renamed" }), ENVS),
      ENVS,
    ),
    { flagLevel: true, environments: [], deleted: false },
  );
});

Deno.test("detectFlagEdits protects nothing without a previous entry", async () => {
  assertEquals(
    detectFlagEdits(
      undefined,
      await observeFlag(destFlag({ on: true }), ENVS),
      ENVS,
    ),
    NO_FLAG_EDITS,
  );
});

Deno.test("detectFlagEdits reports a recorded copy that is gone as deleted", () => {
  assertEquals(detectFlagEdits({}, undefined, ENVS), {
    flagLevel: true,
    environments: [],
    deleted: true,
  });
});

Deno.test("detectFlagEdits falls back to the previous run's end for entries without a record", async () => {
  const now = await observeFlag(destFlag(), ENVS); // production modified at 1000, stage at 2000
  assertEquals(detectFlagEdits({}, now, ENVS, 1_500).environments, ["stage"]);
  assertEquals(detectFlagEdits({}, now, ENVS, 5_000), NO_FLAG_EDITS);
  // without a fallback time an unrecorded entry cannot be judged and is not protected
  assertEquals(detectFlagEdits({}, now, ENVS), NO_FLAG_EDITS);
});

Deno.test("detectFlagEdits keeps owned parts owned even after the edit is undone", async () => {
  const now = await observeFlag(destFlag(), ENVS);
  const entry = { dest: now, targetOwned: { environments: ["stage"] } };
  assertEquals(detectFlagEdits(entry, now, ENVS).environments, ["stage"]);
  // an environment no longer migrated is not reported
  assertEquals(detectFlagEdits(entry, now, ["production"]), NO_FLAG_EDITS);
});

Deno.test("detectFlagEdits does not take an applied approval request of the migration for an edit", async () => {
  const recorded = await observeFlag(destFlag(), ENVS);
  const now = await observeFlag(destFlag({ on: true }), ENVS);
  assertEquals(
    detectFlagEdits(
      { dest: recorded, awaitingApproval: ["production"] },
      now,
      ENVS,
    ),
    NO_FLAG_EDITS,
  );
});

Deno.test("nextFlagTargetRecord records the observed state and keeps owned parts", async () => {
  const before = await observeFlag(destFlag(), ENVS);
  const after = await observeFlag(destFlag({ on: true, stageOn: false }), ENVS);
  const edits = { flagLevel: false, environments: ["stage"], deleted: false };
  const record = nextFlagTargetRecord({ dest: before }, edits, after);
  assertEquals(record.targetOwned, { environments: ["stage"] });
  // production takes the state after this run's write; stage keeps the record from before the edit
  assertEquals(
    record.dest!.environments!.production,
    after.environments!.production,
  );
  assertEquals(record.dest!.environments!.stage, before.environments!.stage);
  assertEquals(record.dest!.fingerprint, after.fingerprint);
  // the next run compares against that record: production unchanged, stage still owned
  assertEquals(
    detectFlagEdits(record, after, ENVS),
    { flagLevel: false, environments: ["stage"], deleted: false },
  );
});

Deno.test("nextFlagTargetRecord keeps the previous record when the copy was not read", async () => {
  const before = await observeFlag(destFlag(), ENVS);
  assertEquals(
    nextFlagTargetRecord({ dest: before }, NO_FLAG_EDITS, undefined),
    {
      dest: before,
    },
  );
  assertEquals(nextFlagTargetRecord(undefined, NO_FLAG_EDITS, undefined), {});
  assertEquals(
    nextFlagTargetRecord({ dest: before }, {
      flagLevel: true,
      environments: [],
      deleted: true,
    }, undefined)
      .targetOwned,
    { flag: true, deleted: true },
  );
});

Deno.test("nextFlagTargetRecord records approval requests for re-baselining", async () => {
  const now = await observeFlag(destFlag(), ENVS);
  assertEquals(
    nextFlagTargetRecord(undefined, NO_FLAG_EDITS, now, ["stage", "stage"])
      .awaitingApproval,
    ["stage"],
  );
});

const destSegment = (included: string[]) => ({
  key: "beta",
  name: "Beta",
  tags: [],
  included,
  excluded: [],
  rules: [],
  version: 4,
  lastModifiedDate: 3_000,
});

Deno.test("detectSegmentEdit compares the recorded fingerprint, else the previous run's end", async () => {
  const recorded = await observeSegment(destSegment(["a"]));
  assertEquals(detectSegmentEdit({ dest: recorded }, recorded), "none");
  assertEquals(
    detectSegmentEdit(
      { dest: recorded },
      await observeSegment(destSegment(["a", "b"])),
    ),
    "edited",
  );
  assertEquals(detectSegmentEdit({ dest: recorded }, undefined), "deleted");
  assertEquals(detectSegmentEdit(undefined, recorded), "none");
  assertEquals(detectSegmentEdit({}, recorded, 2_000), "edited");
  assertEquals(detectSegmentEdit({}, recorded, 4_000), "none");
  assertEquals(
    detectSegmentEdit({ targetOwned: "edited" }, recorded),
    "edited",
  );
});

Deno.test("nextSegmentTargetRecord keeps the old record once owned", async () => {
  const before = await observeSegment(destSegment(["a"]));
  const after = await observeSegment(destSegment(["a", "b"]));
  assertEquals(nextSegmentTargetRecord({ dest: before }, "none", after), {
    dest: after,
  });
  assertEquals(nextSegmentTargetRecord({ dest: before }, "edited", after), {
    dest: before,
    targetOwned: "edited",
  });
  assertEquals(nextSegmentTargetRecord(undefined, "none", undefined), {});
});
