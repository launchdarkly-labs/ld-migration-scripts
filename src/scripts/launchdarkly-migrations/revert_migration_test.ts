import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildRevertConfigs,
  findRemainingSiblingFlagKeys,
  selectRevertFlagKeys,
} from "./revert_migration.ts";
import type { WorkflowConfig } from "../../utils/workflow_config.ts";

const CONFIG_PATH = "workflow.yaml";

const multiProject = (): WorkflowConfig => ({
  source: { projectKeys: ["payroll", "benefits", "payroll"] },
  destination: { domain: "app.launchdarkly.us" },
});

const keysOf = (configs: ReturnType<typeof buildRevertConfigs>) =>
  configs.map((c) => ({
    projectKey: c.projectKey,
    sourceProjectKey: c.sourceProjectKey,
  }));

Deno.test("projectKeys without -p reverts each project with the same key", () => {
  const configs = buildRevertConfigs(multiProject(), {}, CONFIG_PATH);
  assertEquals(keysOf(configs), [
    { projectKey: "payroll", sourceProjectKey: "payroll" },
    { projectKey: "benefits", sourceProjectKey: "benefits" },
  ]);
  assertEquals(configs[0].domain, "app.launchdarkly.us");
  assertEquals(configs[0].configFile, CONFIG_PATH);
  assertEquals(configs[0].useSourceData, true);
});

Deno.test("projectKeys with -p reverts only that project", () => {
  const configs = buildRevertConfigs(
    multiProject(),
    { project: "benefits" },
    CONFIG_PATH,
  );
  assertEquals(keysOf(configs), [{
    projectKey: "benefits",
    sourceProjectKey: "benefits",
  }]);
});

Deno.test("-p plus -s overrides the source key", () => {
  const configs = buildRevertConfigs(
    multiProject(),
    { project: "benefits", sourceProject: "old-benefits" },
    CONFIG_PATH,
  );
  assertEquals(keysOf(configs), [{
    projectKey: "benefits",
    sourceProjectKey: "old-benefits",
  }]);
});

Deno.test("-s without -p is ignored when multiple projects are listed", () => {
  const configs = buildRevertConfigs(
    multiProject(),
    { sourceProject: "other" },
    CONFIG_PATH,
  );
  assertEquals(configs.map((c) => c.sourceProjectKey), ["payroll", "benefits"]);
});

Deno.test("numeric -p is coerced to a string key", () => {
  const configs = buildRevertConfigs(
    multiProject(),
    { project: 123 as unknown as string },
    CONFIG_PATH,
  );
  assertEquals(configs[0].projectKey, "123");
});

Deno.test("single projectKey uses source and destination keys", () => {
  const config: WorkflowConfig = {
    source: { projectKey: "us-production" },
    destination: { projectKey: "eu-production" },
  };
  assertEquals(keysOf(buildRevertConfigs(config, {}, CONFIG_PATH)), [
    { projectKey: "eu-production", sourceProjectKey: "us-production" },
  ]);
});

Deno.test("single projectKey with -p keeps the configured source key", () => {
  const config: WorkflowConfig = {
    source: { projectKey: "us-production" },
    destination: { projectKey: "eu-production" },
  };
  assertEquals(
    keysOf(buildRevertConfigs(config, { project: "eu-other" }, CONFIG_PATH)),
    [
      { projectKey: "eu-other", sourceProjectKey: "us-production" },
    ],
  );
});

Deno.test("single projectKey with -s overrides the source key", () => {
  const config: WorkflowConfig = {
    source: { projectKey: "us-production" },
    destination: { projectKey: "eu-production" },
  };
  assertEquals(
    buildRevertConfigs(config, { sourceProject: "us-old" }, CONFIG_PATH)[0]
      .sourceProjectKey,
    "us-old",
  );
});

Deno.test("missing destination key falls back to the source key", () => {
  const config: WorkflowConfig = { source: { projectKey: "my-proj" } };
  assertEquals(keysOf(buildRevertConfigs(config, {}, CONFIG_PATH)), [
    { projectKey: "my-proj", sourceProjectKey: "my-proj" },
  ]);
});

Deno.test("throws when no project key is set", () => {
  assertThrows(
    () => buildRevertConfigs({ source: {} }, {}, CONFIG_PATH),
    Error,
    "source.projectKey",
  );
});

Deno.test("viewKeys come from migration.targetView unless -v is given", () => {
  const config: WorkflowConfig = {
    source: { projectKey: "a" },
    destination: { projectKey: "b" },
    migration: { targetView: "migration-view" },
  };
  assertEquals(buildRevertConfigs(config, {}, CONFIG_PATH)[0].viewKeys, [
    "migration-view",
  ]);
  assertEquals(
    buildRevertConfigs(config, { views: "v1,v2" }, CONFIG_PATH)[0].viewKeys,
    ["v1", "v2"],
  );
  assertEquals(
    buildRevertConfigs({ source: { projectKey: "a" } }, {}, CONFIG_PATH)[0]
      .viewKeys,
    undefined,
  );
});

const singleWithRevert = (
  revert: WorkflowConfig["revert"],
): WorkflowConfig => ({
  source: { projectKey: "a" },
  destination: { projectKey: "b" },
  migration: { targetView: "migration-view" },
  revert,
});

Deno.test("revert.dryRun is used when --dry-run is not passed", () => {
  const configs = buildRevertConfigs(
    singleWithRevert({ dryRun: true }),
    {},
    CONFIG_PATH,
  );
  assertEquals(configs[0].dryRun, true);
});

Deno.test("--no-dry-run overrides revert.dryRun: true", () => {
  const configs = buildRevertConfigs(
    singleWithRevert({ dryRun: true }),
    { dryRun: false },
    CONFIG_PATH,
  );
  assertEquals(configs[0].dryRun, false);
});

Deno.test("revert.deleteViews is used unless the CLI flag overrides it", () => {
  const config = singleWithRevert({ deleteViews: true });
  assertEquals(
    buildRevertConfigs(config, {}, CONFIG_PATH)[0].deleteViews,
    true,
  );
  assertEquals(
    buildRevertConfigs(config, { deleteViews: false }, CONFIG_PATH)[0]
      .deleteViews,
    false,
  );
});

Deno.test("view keys: -v beats revert.viewKeys, which beats migration.targetView", () => {
  const config = singleWithRevert({ viewKeys: ["r1", "r2"] });
  assertEquals(buildRevertConfigs(config, {}, CONFIG_PATH)[0].viewKeys, [
    "r1",
    "r2",
  ]);
  assertEquals(
    buildRevertConfigs(config, { views: "cli-view" }, CONFIG_PATH)[0].viewKeys,
    ["cli-view"],
  );
});

Deno.test("empty revert.viewKeys falls back to migration.targetView", () => {
  const configs = buildRevertConfigs(
    singleWithRevert({ viewKeys: [] }),
    {},
    CONFIG_PATH,
  );
  assertEquals(configs[0].viewKeys, ["migration-view"]);
});

Deno.test("without a revert: block, dryRun and deleteViews default to false", () => {
  const configs = buildRevertConfigs(
    singleWithRevert(undefined),
    {},
    CONFIG_PATH,
  );
  assertEquals(configs[0].dryRun, false);
  assertEquals(configs[0].deleteViews, false);
});

Deno.test("revert: block settings apply to every project in projectKeys", () => {
  const config: WorkflowConfig = {
    ...multiProject(),
    revert: { dryRun: true, deleteViews: true, viewKeys: ["shared-view"] },
  };
  const configs = buildRevertConfigs(config, {}, CONFIG_PATH);
  assertEquals(configs.length, 2);
  for (const c of configs) {
    assertEquals(c.dryRun, true);
    assertEquals(c.deleteViews, true);
    assertEquals(c.viewKeys, ["shared-view"]);
  }
});

Deno.test("boolean -p is treated as missing", () => {
  const configs = buildRevertConfigs(
    multiProject(),
    { project: true as unknown as string },
    CONFIG_PATH,
  );
  assertEquals(configs.map((c) => c.projectKey), ["payroll", "benefits"]);
});

Deno.test("CLI flags are shared across all project configs", () => {
  const configs = buildRevertConfigs(
    multiProject(),
    {
      dryRun: true,
      deleteViews: true,
      domain: "custom.example.com",
      useSourceData: false,
    },
    CONFIG_PATH,
  );
  for (const c of configs) {
    assertEquals(c.dryRun, true);
    assertEquals(c.deleteViews, true);
    assertEquals(c.domain, "custom.example.com");
    assertEquals(c.useSourceData, false);
  }
});

const mapped = (): WorkflowConfig => ({
  source: {
    projectKeys: ["ld-mfe-examples", "cd-example", "scripts-source"],
  },
  destination: {
    domain: "app.launchdarkly.com",
    projectKeyMapping: {
      "cd-example": "new-project",
      "scripts-source": "new-project",
    },
  },
});

Deno.test("projectKeyMapping: revert without -p uses mapped destinations", () => {
  assertEquals(keysOf(buildRevertConfigs(mapped(), {}, CONFIG_PATH)), [
    { projectKey: "ld-mfe-examples", sourceProjectKey: "ld-mfe-examples" },
    { projectKey: "new-project", sourceProjectKey: "cd-example" },
    { projectKey: "new-project", sourceProjectKey: "scripts-source" },
  ]);
});

Deno.test("projectKeyMapping: -p of a merged destination reverts every mapped source", () => {
  assertEquals(
    keysOf(buildRevertConfigs(mapped(), { project: "new-project" }, CONFIG_PATH)),
    [
      { projectKey: "new-project", sourceProjectKey: "cd-example" },
      { projectKey: "new-project", sourceProjectKey: "scripts-source" },
    ],
  );
});

Deno.test("projectKeyMapping: -p plus -s reverts only that source", () => {
  assertEquals(
    keysOf(
      buildRevertConfigs(
        mapped(),
        { project: "new-project", sourceProject: "cd-example" },
        CONFIG_PATH,
      ),
    ),
    [{ projectKey: "new-project", sourceProjectKey: "cd-example" }],
  );
});

Deno.test("projectKeyMapping: unmatched -p falls back to the same source key", () => {
  assertEquals(
    keysOf(buildRevertConfigs(mapped(), { project: "elsewhere" }, CONFIG_PATH)),
    [{ projectKey: "elsewhere", sourceProjectKey: "elsewhere" }],
  );
});

Deno.test("projectKeyMapping: merged destinations list their other sources as siblings", () => {
  const configs = buildRevertConfigs(mapped(), {}, CONFIG_PATH);
  assertEquals(configs.map((c) => c.siblingSourceKeys), [
    undefined,
    ["scripts-source"],
    ["cd-example"],
  ]);
  assertEquals(
    buildRevertConfigs(
      mapped(),
      { project: "new-project", sourceProject: "cd-example" },
      CONFIG_PATH,
    )[0].siblingSourceKeys,
    ["scripts-source"],
  );
});

Deno.test("same-key projectKeys have no siblings", () => {
  for (const c of buildRevertConfigs(multiProject(), {}, CONFIG_PATH)) {
    assertEquals(c.siblingSourceKeys, undefined);
  }
});

Deno.test("findRemainingSiblingFlagKeys keeps views while another source's flags remain", () => {
  assertEquals(
    findRemainingSiblingFlagKeys(["b1", "b2", "b1"], new Set(["a1"])),
    ["b1", "b2"],
  );
});

Deno.test("findRemainingSiblingFlagKeys ignores keys this revert removes", () => {
  assertEquals(
    findRemainingSiblingFlagKeys(["a1"], new Set(["a1", "a2"])),
    [],
  );
  assertEquals(findRemainingSiblingFlagKeys([], new Set(["a1"])), []);
});

Deno.test("selectRevertFlagKeys keeps every manifest key, even ones a sibling also lists", () => {
  assertEquals(
    selectRevertFlagKeys(
      { keys: ["imported-shared", "only-b", "only-b"], fromManifest: true },
      [{ keys: ["shared", "only-a"], fromManifest: false }],
    ),
    { keys: ["imported-shared", "only-b"], ambiguous: [] },
  );
});

Deno.test("selectRevertFlagKeys leaves extracted keys that a sibling also lists in place", () => {
  assertEquals(
    selectRevertFlagKeys(
      { keys: ["shared", "only-b"], fromManifest: false },
      [{ keys: ["shared", "only-a"], fromManifest: false }, { keys: ["only-c"], fromManifest: true }],
    ),
    { keys: ["only-b"], ambiguous: ["shared"] },
  );
});

Deno.test("selectRevertFlagKeys treats a sibling's manifest destination key as taken", () => {
  // Sibling A's manifest says its flag landed as "shared" (no prefix); B's raw "shared" might be A's flag
  assertEquals(
    selectRevertFlagKeys(
      { keys: ["shared"], fromManifest: false },
      [{ keys: ["shared"], fromManifest: true }],
    ),
    { keys: [], ambiguous: ["shared"] },
  );
  // A's manifest says its copy is "imported-shared", so B's raw "shared" is B's own
  assertEquals(
    selectRevertFlagKeys(
      { keys: ["shared"], fromManifest: false },
      [{ keys: ["imported-shared"], fromManifest: true }],
    ),
    { keys: ["shared"], ambiguous: [] },
  );
});

Deno.test("selectRevertFlagKeys without siblings keeps all extracted keys", () => {
  assertEquals(
    selectRevertFlagKeys({ keys: ["a", "b", "a"], fromManifest: false }, []),
    { keys: ["a", "b"], ambiguous: [] },
  );
});
