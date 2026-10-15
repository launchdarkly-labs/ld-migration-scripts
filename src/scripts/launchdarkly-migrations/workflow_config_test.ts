import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  coerceProjectKey,
  findMergeCollisions,
  findMergedDestinations,
  hasMergeCollisions,
  normalizeWorkflowConfig,
  partitionWorkflowSteps,
  resolveDestinationProjectName,
  resolveProjectKeyMapping,
  resolveProjectKeys,
  resolveProjectPairs,
  usesProjectKeyMapping,
  usesProjectKeysList,
  withProjectKey,
  withProjectPair,
  type WorkflowConfig,
} from "../../utils/workflow_config.ts";

const baseConfig = (): WorkflowConfig => ({
  source: { domain: "app.launchdarkly.com" },
  destination: { domain: "app.launchdarkly.us" },
});

Deno.test("coerceProjectKey handles string and number YAML values", () => {
  assertEquals(coerceProjectKey("  payroll  "), "payroll");
  assertEquals(coerceProjectKey(123), "123");
  assertEquals(coerceProjectKey(null), undefined);
  assertEquals(coerceProjectKey(["x"]), undefined);
});

Deno.test("resolveProjectKeys from projectKeys list", () => {
  const config: WorkflowConfig = {
    ...baseConfig(),
    source: { projectKeys: ["a", "b", "a"] },
  };
  assertEquals(resolveProjectKeys(config), ["a", "b"]);
  assertEquals(usesProjectKeysList(config), true);
});

Deno.test("resolveProjectKeys from single projectKey", () => {
  const config: WorkflowConfig = {
    ...baseConfig(),
    source: { projectKey: "my-proj" },
  };
  assertEquals(resolveProjectKeys(config), ["my-proj"]);
  assertEquals(usesProjectKeysList(config), false);
});

Deno.test("resolveProjectKeys throws when missing", () => {
  assertThrows(
    () => resolveProjectKeys(baseConfig()),
    Error,
    "source.projectKey",
  );
});

Deno.test("resolveProjectPairs maps projectKeys to same-key pairs and ignores destination.projectKey", () => {
  const config: WorkflowConfig = {
    source: { projectKeys: ["a", "b", "a"] },
    destination: { projectKey: "ignored" },
  };
  assertEquals(resolveProjectPairs(config), [
    { source: "a", destination: "a" },
    { source: "b", destination: "b" },
  ]);
});

Deno.test("resolveProjectPairs uses single source and destination keys", () => {
  const config: WorkflowConfig = {
    source: { projectKey: "src" },
    destination: { projectKey: "dest" },
  };
  assertEquals(resolveProjectPairs(config), [{
    source: "src",
    destination: "dest",
  }]);
});

Deno.test("resolveProjectPairs falls back to source key when destination key is missing", () => {
  const config: WorkflowConfig = { source: { projectKey: "src" } };
  assertEquals(resolveProjectPairs(config), [{
    source: "src",
    destination: "src",
  }]);
});

Deno.test("resolveProjectPairs throws when no project key is set", () => {
  assertThrows(
    () => resolveProjectPairs(baseConfig()),
    Error,
    "source.projectKey",
  );
});

Deno.test("withProjectKey sets same key on source and destination", () => {
  const config: WorkflowConfig = normalizeWorkflowConfig({
    ...baseConfig(),
    source: { projectKeys: ["x"] },
  });
  const next = withProjectKey(config, "payroll");
  assertEquals(next.source.projectKey, "payroll");
  assertEquals(next.destination?.projectKey, "payroll");
  assertEquals(next.destination?.domain, "app.launchdarkly.us");
});

Deno.test("partitionWorkflowSteps splits account and project steps", () => {
  const steps = [
    "map-members",
    "extract-source",
    "migrate",
    "third-party-import",
    "unknown-step",
  ];
  const { accountSteps, projectSteps, unknownSteps } = partitionWorkflowSteps(
    steps,
  );
  assertEquals(accountSteps, ["map-members", "third-party-import"]);
  assertEquals(projectSteps, ["extract-source", "migrate"]);
  assertEquals(unknownSteps, ["unknown-step"]);
});

Deno.test("partitionWorkflowSteps preserves listed order within each group", () => {
  const { accountSteps, projectSteps } = partitionWorkflowSteps([
    "revert",
    "third-party-import",
    "migrate",
    "map-members",
    "extract-source",
  ]);
  assertEquals(accountSteps, ["third-party-import", "map-members"]);
  assertEquals(projectSteps, ["revert", "migrate", "extract-source"]);
});

Deno.test("resolveProjectKeys drops blank entries and coerces numeric YAML keys", () => {
  const config: WorkflowConfig = {
    source: {
      projectKeys: ["  a  ", "", "   ", 42 as unknown as string, "a"],
    },
  };
  assertEquals(resolveProjectKeys(config), ["a", "42"]);
});

Deno.test("all-blank projectKeys falls back to source.projectKey", () => {
  const config: WorkflowConfig = {
    source: { projectKeys: ["", "  "], projectKey: "single" },
  };
  assertEquals(usesProjectKeysList(config), false);
  assertEquals(resolveProjectKeys(config), ["single"]);
});

Deno.test("projectKeys takes precedence over source.projectKey", () => {
  const config: WorkflowConfig = {
    source: { projectKeys: ["a", "b"], projectKey: "ignored" },
  };
  assertEquals(resolveProjectKeys(config), ["a", "b"]);
});

Deno.test("withProjectKey creates destination when missing and does not mutate input", () => {
  const config: WorkflowConfig = {
    source: { projectKeys: ["x"], domain: "app.launchdarkly.com" },
  };
  const next = withProjectKey(config, "payroll");
  assertEquals(next.destination, { projectKey: "payroll" });
  assertEquals(next.source.domain, "app.launchdarkly.com");
  assertEquals(config.source.projectKey, undefined);
  assertEquals(config.destination, undefined);
});

Deno.test("coerceProjectKey rejects YAML booleans", () => {
  assertEquals(coerceProjectKey(true), undefined);
  assertEquals(coerceProjectKey(false), undefined);
});

Deno.test("resolveProjectKeys throws for a boolean source.projectKey", () => {
  const config: WorkflowConfig = {
    source: { projectKey: true as unknown as string },
  };
  assertThrows(() => resolveProjectKeys(config), Error, "source.projectKey");
});

Deno.test("boolean entries in projectKeys are dropped", () => {
  const config: WorkflowConfig = {
    source: { projectKeys: ["a", true as unknown as string, "b"] },
  };
  assertEquals(resolveProjectKeys(config), ["a", "b"]);
});

Deno.test("coerceProjectKey rejects blank strings and objects", () => {
  assertEquals(coerceProjectKey("   "), undefined);
  assertEquals(coerceProjectKey(""), undefined);
  assertEquals(coerceProjectKey(undefined), undefined);
  assertEquals(coerceProjectKey({ key: "x" }), undefined);
});

Deno.test("resolveDestinationProjectName: explicit name wins", () => {
  assertEquals(
    resolveDestinationProjectName({
      explicit: "  NR Import (test)  ",
      sourceName: "Source Name",
      sourceKey: "a",
      destKey: "b",
    }),
    "NR Import (test)",
  );
});

Deno.test("resolveDestinationProjectName: blank or non-string explicit is unset; numbers convert", () => {
  const base = { sourceName: "Source Name", sourceKey: "a", destKey: "a" };
  assertEquals(
    resolveDestinationProjectName({ ...base, explicit: "   " }),
    "Source Name",
  );
  assertEquals(
    resolveDestinationProjectName({ ...base, explicit: true }),
    "Source Name",
  );
  assertEquals(
    resolveDestinationProjectName({ ...base, explicit: 2026 }),
    "2026",
  );
});

Deno.test("resolveDestinationProjectName: different keys use the destination key", () => {
  assertEquals(
    resolveDestinationProjectName({
      sourceName: "nr-import-staging",
      sourceKey: "nr-import-staging",
      destKey: "nr-import-staging-test-dest",
    }),
    "nr-import-staging-test-dest",
  );
});

Deno.test("resolveDestinationProjectName: same keys use the source name, else the key", () => {
  assertEquals(
    resolveDestinationProjectName({
      sourceName: "Payroll",
      sourceKey: "payroll",
      destKey: "payroll",
    }),
    "Payroll",
  );
  assertEquals(
    resolveDestinationProjectName({
      sourceName: "  ",
      sourceKey: "payroll",
      destKey: "payroll",
    }),
    "payroll",
  );
  assertEquals(
    resolveDestinationProjectName({ sourceKey: "payroll", destKey: "payroll" }),
    "payroll",
  );
});

Deno.test("withProjectKey drops destination.projectName and does not mutate input", () => {
  const config: WorkflowConfig = {
    source: { projectKeys: ["x", "y"] },
    destination: {
      projectName: "Shared Name",
      domain: "ld-stg.launchdarkly.com",
    },
  };
  const next = withProjectKey(config, "x");
  assertEquals(next.destination, {
    projectKey: "x",
    domain: "ld-stg.launchdarkly.com",
  });
  assertEquals(config.destination, {
    projectName: "Shared Name",
    domain: "ld-stg.launchdarkly.com",
  });
});

const mappedConfig = (
  projectKeyMapping: Record<string, string>,
): WorkflowConfig => ({
  source: { projectKeys: ["mfe", "cd", "scripts"] },
  destination: { domain: "app.launchdarkly.com", projectKeyMapping },
});

Deno.test("projectKeyMapping: unmapped keys keep the same key", () => {
  assertEquals(resolveProjectPairs(mappedConfig({ cd: "cd-new" })), [
    { source: "mfe", destination: "mfe" },
    { source: "cd", destination: "cd-new" },
    { source: "scripts", destination: "scripts" },
  ]);
});

Deno.test("projectKeyMapping: several sources can merge into one destination", () => {
  const pairs = resolveProjectPairs(
    mappedConfig({ cd: "new-project", scripts: "new-project" }),
  );
  assertEquals(pairs.map((p) => p.destination), [
    "mfe",
    "new-project",
    "new-project",
  ]);
  assertEquals(
    findMergedDestinations(pairs),
    new Map([["new-project", ["cd", "scripts"]]]),
  );
});

Deno.test("projectKeyMapping: keys and values are trimmed, numbers coerced", () => {
  assertEquals(
    resolveProjectKeyMapping(
      mappedConfig({ "  cd  ": "  new-project ", scripts: 7 as unknown as string }),
    ),
    { cd: "new-project", scripts: "7" },
  );
});

Deno.test("projectKeyMapping: unknown source key throws", () => {
  assertThrows(
    () => resolveProjectPairs(mappedConfig({ typo: "new-project" })),
    Error,
    `"typo" is not listed in source.projectKeys`,
  );
});

Deno.test("projectKeyMapping: blank or non-string value throws", () => {
  assertThrows(
    () => resolveProjectPairs(mappedConfig({ cd: "  " })),
    Error,
    `value for "cd"`,
  );
  assertThrows(
    () => resolveProjectPairs(mappedConfig({ cd: true as unknown as string })),
    Error,
    `value for "cd"`,
  );
});

Deno.test("projectKeyMapping is ignored without projectKeys", () => {
  const config: WorkflowConfig = {
    source: { projectKey: "src" },
    destination: { projectKey: "dest", projectKeyMapping: { src: "other" } },
  };
  assertEquals(usesProjectKeyMapping(config), true);
  assertEquals(resolveProjectKeyMapping(config), {});
  assertEquals(resolveProjectPairs(config), [{ source: "src", destination: "dest" }]);
});

Deno.test("no projectKeyMapping keeps same-key pairs and no merges", () => {
  const config: WorkflowConfig = { source: { projectKeys: ["a", "b"] } };
  assertEquals(usesProjectKeyMapping(config), false);
  assertEquals(resolveProjectPairs(config), [
    { source: "a", destination: "a" },
    { source: "b", destination: "b" },
  ]);
  assertEquals(findMergedDestinations(resolveProjectPairs(config)).size, 0);
});

Deno.test("withProjectPair sets keys, names from projectNames, and strips the maps", () => {
  const config: WorkflowConfig = {
    source: { projectKeys: ["cd", "scripts"], domain: "ld-stg.launchdarkly.com" },
    destination: {
      domain: "app.launchdarkly.com",
      projectName: "ignored",
      projectKeyMapping: { cd: "new-project" },
      projectNames: { "new-project": "  New Project " },
    },
  };
  const next = withProjectPair(config, { source: "cd", destination: "new-project" });
  assertEquals(next.source.projectKey, "cd");
  assertEquals(next.destination, {
    domain: "app.launchdarkly.com",
    projectKey: "new-project",
    projectName: "New Project",
  });

  const unnamed = withProjectPair(config, { source: "scripts", destination: "scripts" });
  assertEquals(unnamed.destination, {
    domain: "app.launchdarkly.com",
    projectKey: "scripts",
  });
  assertEquals(config.destination?.projectKeyMapping, { cd: "new-project" });
});

const writeSource = async (
  baseDir: string,
  key: string,
  flags: unknown,
  segments: Record<string, string[]> = {},
) => {
  await Deno.mkdir(`${baseDir}/${key}/segments`, { recursive: true });
  await Deno.writeTextFile(`${baseDir}/${key}/flags.json`, JSON.stringify(flags));
  for (const [env, keys] of Object.entries(segments)) {
    await Deno.writeTextFile(
      `${baseDir}/${key}/segments/${env}.json`,
      JSON.stringify({ items: keys.map((k) => ({ key: k })) }),
    );
  }
};

Deno.test("findMergeCollisions reports overlapping flag and segment keys", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeSource(dir, "a", ["shared", "only-a"], { test: ["seg", "a-seg"], production: ["p"] });
    await writeSource(dir, "b", { items: [{ key: "shared" }, { key: "only-b" }] }, {
      test: ["seg"],
      production: ["other"],
    });
    const collisions = await findMergeCollisions("b", ["a"], dir);
    assertEquals(collisions, { flags: ["shared"], segments: { test: ["seg"] } });
    assertEquals(hasMergeCollisions(collisions), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findMergeCollisions is empty when keys do not overlap", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeSource(dir, "a", ["a1"], { test: ["a-seg"] });
    await writeSource(dir, "b", ["b1"]);
    const collisions = await findMergeCollisions("b", ["a"], dir);
    assertEquals(collisions, { flags: [], segments: {} });
    assertEquals(hasMergeCollisions(collisions), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findMergeCollisions throws when a source was not extracted", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeSource(dir, "b", ["b1"]);
    await assertRejects(
      () => findMergeCollisions("b", ["missing"], dir),
      Error,
      `run the extract-source step for "missing"`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
