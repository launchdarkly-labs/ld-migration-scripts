// deno-lint-ignore-file require-await
// The mock HTTP client methods are async to satisfy the AgentControlHttpClient interface.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AGENT_CONTROL_MIGRATE_ORDER,
  agentControlExtractCliArgs,
  type AgentControlHttpClient,
  agentControlMigrateCliArgs,
  agentControlRoot,
  buildSourceVariationRefsFromTargeting,
  buildTargetingInstructionsForEnvironment,
  classifyUpsertStatus,
  collectReferencedModelConfigKeys,
  configsPath,
  emptyAgentControlSummary,
  isAgentControlUnavailable,
  isCriticalTargetingWarning,
  migrateAgentControlFromExtract,
  modelConfigsPath,
  recordOutcome,
  resolveVariationKey,
  sanitizeAgentControlPayload,
  sanitizeVariationPayload,
  shouldExtractAgentControl,
  targetingPath,
  upsertAgentControlResource,
  variationPath,
} from "./agent_control.ts";

Deno.test("sanitizeAgentControlPayload strips read-only fields", () => {
  const sanitized = sanitizeAgentControlPayload({
    key: "my-config",
    name: "My Config",
    _links: { self: { href: "/x" } },
    _id: "abc",
    _version: 3,
    version: 3,
    createdAt: 1,
    updatedAt: 2,
    _access: {},
    description: "keep me",
    variations: [{ key: "v1" }],
    environments: { production: {} },
  });
  assertEquals(sanitized, {
    key: "my-config",
    name: "My Config",
    description: "keep me",
  });
});

Deno.test("sanitizeVariationPayload keeps writable variation fields", () => {
  const sanitized = sanitizeVariationPayload({
    key: "var-1",
    name: "Var 1",
    _id: "uuid",
    modelConfigKey: "gpt",
    messages: [{ role: "user", content: "hi" }],
    _links: {},
  });
  assertEquals(sanitized, {
    key: "var-1",
    name: "Var 1",
    modelConfigKey: "gpt",
    messages: [{ role: "user", content: "hi" }],
  });
});

Deno.test("resolveVariationKey uses _ldMeta.variationKey and disabled", () => {
  assertEquals(
    resolveVariationKey({
      name: "Default",
      value: { _ldMeta: { enabled: true, variationKey: "default" } },
    }),
    "default",
  );
  assertEquals(
    resolveVariationKey({
      name: "disabled",
      value: { _ldMeta: { enabled: false } },
    }),
    "disabled",
  );
  assertEquals(resolveVariationKey({ key: "explicit" }), "explicit");
});

Deno.test("buildSourceVariationRefsFromTargeting preserves indexes without id match", () => {
  const refs = buildSourceVariationRefsFromTargeting(
    [
      {
        name: "disabled",
        _id: "targeting-disabled-id",
        value: { _ldMeta: { enabled: false } },
      },
      {
        name: "Default",
        _id: "targeting-default-id",
        value: { _ldMeta: { enabled: true, variationKey: "default" } },
      },
    ],
    [
      // File _id intentionally differs from targeting _id (live API quirk)
      { key: "default", name: "Default", _id: "file-default-id" },
    ],
  );
  assertEquals(refs.length, 2);
  assertEquals(refs[0], { key: "disabled", _id: "targeting-disabled-id" });
  assertEquals(refs[1], { key: "default", _id: "targeting-default-id" });
});

Deno.test("buildTargetingInstructionsForEnvironment remaps variation indexes", () => {
  const sourceVariations = buildSourceVariationRefsFromTargeting([
    {
      name: "disabled",
      _id: "src-off",
      value: { _ldMeta: { enabled: false } },
    },
    {
      name: "v1",
      _id: "src-on",
      value: { _ldMeta: { enabled: true, variationKey: "on" } },
    },
  ]);
  const destIds = new Map([
    ["disabled", "dest-off"],
    ["on", "dest-on"],
  ]);
  const { instructions, warnings } = buildTargetingInstructionsForEnvironment(
    {
      rules: [{
        description: "rule",
        variation: 1,
        clauses: [{
          attribute: "email",
          op: "in",
          values: ["a@b.com"],
          negate: false,
          id: "clause-id",
        }],
      }],
      targets: [{ variation: 1, values: ["user-1"], contextKind: "user" }],
      fallthrough: { variation: 1 },
      offVariation: 0,
    },
    sourceVariations,
    destIds,
  );
  assertEquals(warnings, []);
  assertEquals(instructions[0], {
    kind: "replaceRules",
    rules: [{
      description: "rule",
      variationId: "dest-on",
      clauses: [{
        attribute: "email",
        op: "in",
        values: ["a@b.com"],
        negate: false,
      }],
    }],
  });
  assertEquals(instructions[1], {
    kind: "replaceTargets",
    targets: [{
      variationId: "dest-on",
      values: ["user-1"],
      contextKind: "user",
    }],
  });
  assertEquals(instructions[2], {
    kind: "updateFallthroughVariationOrRollout",
    variationId: "dest-on",
  });
  assertEquals(instructions[3], {
    kind: "updateOffVariation",
    variationId: "dest-off",
  });
});

Deno.test("critical targeting warnings detected", () => {
  assertEquals(
    isCriticalTargetingWarning("Could not map fallthrough variation"),
    true,
  );
  assertEquals(isCriticalTargetingWarning("Could not map off variation"), true);
  assertEquals(
    isCriticalTargetingWarning("Skipping target with unmapped variation"),
    true,
  );
  assertEquals(isCriticalTargetingWarning("something else"), false);
});

Deno.test("collectReferencedModelConfigKeys reads modelKey from _ldMeta", () => {
  const keys = collectReferencedModelConfigKeys([
    {
      key: "v-1",
      value: { _ldMeta: { modelKey: "OpenAI.gpt-4.1", variationKey: "v-1" } },
    },
    { modelConfigKey: "custom-model" },
  ]);
  assertEquals([...keys].sort(), ["OpenAI.gpt-4.1", "custom-model"]);
});

Deno.test("classifyUpsertStatus and unavailable helpers", () => {
  assertEquals(classifyUpsertStatus(201), "created");
  assertEquals(classifyUpsertStatus(409), "updated");
  assertEquals(classifyUpsertStatus(403), "skipped");
  assertEquals(classifyUpsertStatus(404), "skipped");
  assertEquals(classifyUpsertStatus(500), "error");
  assertEquals(isAgentControlUnavailable(403), true);
  assertEquals(isAgentControlUnavailable(404), true);
  assertEquals(isAgentControlUnavailable(409), false);
});

Deno.test("recordOutcome increments summary counters", () => {
  const summary = emptyAgentControlSummary();
  recordOutcome(summary, "created");
  recordOutcome(summary, "updated");
  recordOutcome(summary, "skipped");
  recordOutcome(summary, "error");
  assertEquals(summary, { created: 1, updated: 1, skipped: 1, errors: 1 });
});

Deno.test("AGENT_CONTROL_MIGRATE_ORDER is models → configs → variations → targeting", () => {
  assertEquals([...AGENT_CONTROL_MIGRATE_ORDER], [
    "model-configs",
    "configs",
    "variations",
    "targeting",
  ]);
});

Deno.test("path builders match ai-configs layout", () => {
  const root = "/tmp/proj";
  assertEquals(agentControlRoot(root), "/tmp/proj/ai-configs");
  assertEquals(
    modelConfigsPath(root),
    "/tmp/proj/ai-configs/model-configs.json",
  );
  assertEquals(configsPath(root), "/tmp/proj/ai-configs/configs.json");
  assertEquals(
    variationPath(root, "cfg", "var1"),
    "/tmp/proj/ai-configs/variations/cfg/var1.json",
  );
  assertEquals(
    targetingPath(root, "cfg"),
    "/tmp/proj/ai-configs/targeting/cfg.json",
  );
});

Deno.test("upsertAgentControlResource creates when POST succeeds", async () => {
  const calls: string[] = [];
  const client: AgentControlHttpClient = {
    async post(path) {
      calls.push(`POST ${path}`);
      return { status: 201 };
    },
    async patch(path) {
      calls.push(`PATCH ${path}`);
      return { status: 200 };
    },
  };
  const outcome = await upsertAgentControlResource(
    client,
    "projects/dest/ai-configs",
    "projects/dest/ai-configs/k",
    { key: "k", name: "K", _links: {} },
    false,
  );
  assertEquals(outcome, "created");
  assertEquals(calls, ["POST projects/dest/ai-configs"]);
});

Deno.test("upsertAgentControlResource updates on 409", async () => {
  const calls: string[] = [];
  const client: AgentControlHttpClient = {
    async post(path) {
      calls.push(`POST ${path}`);
      return { status: 409 };
    },
    async patch(path) {
      calls.push(`PATCH ${path}`);
      return { status: 200 };
    },
  };
  const outcome = await upsertAgentControlResource(
    client,
    "projects/dest/ai-configs",
    "projects/dest/ai-configs/k",
    { key: "k", name: "K" },
    false,
  );
  assertEquals(outcome, "updated");
  assertEquals(calls, [
    "POST projects/dest/ai-configs",
    "PATCH projects/dest/ai-configs/k",
  ]);
});

Deno.test("upsertAgentControlResource skips immutable conflict after failed PATCH", async () => {
  const client: AgentControlHttpClient = {
    async post() {
      return { status: 409 };
    },
    async patch() {
      return { status: 400, body: "immutable" };
    },
  };
  const outcome = await upsertAgentControlResource(
    client,
    "projects/dest/ai-configs/model-configs",
    "projects/dest/ai-configs/model-configs/builtin",
    { key: "builtin", name: "Built-in" },
    false,
  );
  assertEquals(outcome, "skipped");
});

Deno.test("upsertAgentControlResource skips on 403/404", async () => {
  for (const status of [403, 404]) {
    const client: AgentControlHttpClient = {
      async post() {
        return { status };
      },
      async patch() {
        return { status: 200 };
      },
    };
    const outcome = await upsertAgentControlResource(
      client,
      "projects/dest/ai-configs",
      "projects/dest/ai-configs/k",
      { key: "k" },
      false,
    );
    assertEquals(outcome, "skipped");
  }
});

Deno.test("upsertAgentControlResource dry-run does not call client", async () => {
  let called = false;
  const client: AgentControlHttpClient = {
    async post() {
      called = true;
      return { status: 201 };
    },
    async patch() {
      called = true;
      return { status: 200 };
    },
  };
  const outcome = await upsertAgentControlResource(
    client,
    "projects/dest/ai-configs",
    "projects/dest/ai-configs/k",
    { key: "k" },
    true,
  );
  assertEquals(outcome, "created");
  assertEquals(called, false);
});

Deno.test("shouldExtractAgentControl mirrors segments enablement rules", () => {
  assertEquals(shouldExtractAgentControl({}), false);
  assertEquals(shouldExtractAgentControl({ includeAgentControl: true }), true);
  assertEquals(shouldExtractAgentControl({ migrateAgentControl: true }), true);
  assertEquals(
    shouldExtractAgentControl({
      includeAgentControl: false,
      migrateAgentControl: false,
    }),
    false,
  );
});

Deno.test("agentControlExtractCliArgs wiring", () => {
  assertEquals(agentControlExtractCliArgs({}), []);
  assertEquals(
    agentControlExtractCliArgs({ includeAgentControl: true }),
    ["--extract-agent-control=true"],
  );
  assertEquals(
    agentControlExtractCliArgs({ migrateAgentControl: true }),
    ["--extract-agent-control=true"],
  );
});

Deno.test("agentControlMigrateCliArgs wiring", () => {
  assertEquals(agentControlMigrateCliArgs(undefined), []);
  assertEquals(agentControlMigrateCliArgs(false), []);
  assertEquals(agentControlMigrateCliArgs(true), ["--migrate-agent-control"]);
});

Deno.test("migrateAgentControlFromExtract dry-run makes no write calls", async () => {
  const sourceKey = `ac-dryrun-${crypto.randomUUID().slice(0, 8)}`;
  const sourceRoot =
    `./data/launchdarkly-migrations/source/project/${sourceKey}`;
  const aiRoot = `${sourceRoot}/ai-configs`;

  try {
    await Deno.mkdir(`${aiRoot}/variations/cfg-a`, { recursive: true });
    await Deno.mkdir(`${aiRoot}/targeting`, { recursive: true });
    await Deno.writeTextFile(
      `${aiRoot}/model-configs.json`,
      JSON.stringify({
        items: [
          { key: "OpenAI.gpt-4.1", name: "GPT" },
          { key: "unused-catalog-model", name: "Unused" },
        ],
      }),
    );
    await Deno.writeTextFile(
      `${aiRoot}/configs.json`,
      JSON.stringify({ items: [{ key: "cfg-a", name: "Config A" }] }),
    );
    await Deno.writeTextFile(
      `${aiRoot}/variations/cfg-a/var-1.json`,
      JSON.stringify({
        key: "var-1",
        name: "v1",
        _id: "file-var-id-different",
        value: {
          _ldMeta: { modelKey: "OpenAI.gpt-4.1", variationKey: "var-1" },
        },
      }),
    );
    await Deno.writeTextFile(
      `${aiRoot}/targeting/cfg-a.json`,
      JSON.stringify({
        key: "cfg-a",
        variations: [
          {
            name: "disabled",
            _id: "src-disabled",
            value: { _ldMeta: { enabled: false } },
          },
          {
            name: "v1",
            _id: "src-var-1",
            value: {
              _ldMeta: {
                enabled: true,
                variationKey: "var-1",
                modelKey: "OpenAI.gpt-4.1",
              },
            },
          },
        ],
        environments: {
          production: {
            fallthrough: { variation: 1 },
            offVariation: 0,
            rules: [],
            targets: [],
          },
        },
      }),
    );

    const calls: string[] = [];
    const client: AgentControlHttpClient = {
      async post(path) {
        calls.push(`POST ${path}`);
        return { status: 201 };
      },
      async patch(path) {
        calls.push(`PATCH ${path}`);
        return { status: 200 };
      },
      async semanticPatch(path) {
        calls.push(`SEMANTIC ${path}`);
        return { status: 200 };
      },
      async get(path) {
        calls.push(`GET ${path}`);
        return { status: 200, json: { variations: [] } };
      },
    };

    const { summary, manifest, aborted } = await migrateAgentControlFromExtract(
      {
        apiKey: "test",
        domain: "app.launchdarkly.com",
        sourceProjectKey: sourceKey,
        destProjectKey: "dest",
        dryRun: true,
        client,
      },
    );

    // Existence lookups are reads; nothing is written
    assertEquals(calls.filter((c) => !c.startsWith("GET ")), []);
    assertEquals(summary.errors, 0);
    assertEquals(aborted, false);
    // The mock reports every config and model config as existing, so a dry run reports them as updates;
    // only the variation (not looked up individually) is reported as created
    assertEquals(summary.created, 1);
    assertEquals(summary.updated, 3);
    // A dry run records nothing, so a later --incremental run cannot skip unsynced work
    assertEquals(Object.keys(manifest.modelConfigs), []);
    assertEquals(Object.keys(manifest.configs), []);
  } finally {
    await Deno.remove(sourceRoot, { recursive: true }).catch(() => {});
  }
});

Deno.test("migrateAgentControlFromExtract empty extract is a no-op", async () => {
  const sourceKey = `ac-empty-${crypto.randomUUID().slice(0, 8)}`;
  const { summary, aborted } = await migrateAgentControlFromExtract({
    apiKey: "test",
    domain: "app.launchdarkly.com",
    sourceProjectKey: sourceKey,
    destProjectKey: "dest",
    dryRun: true,
    client: {
      async post() {
        throw new Error("should not be called");
      },
      async patch() {
        throw new Error("should not be called");
      },
    },
  });
  assertEquals(summary, emptyAgentControlSummary());
  assertEquals(aborted, false);
});

Deno.test("migrateAgentControlFromExtract upserts via injected client", async () => {
  const sourceKey = `ac-upsert-${crypto.randomUUID().slice(0, 8)}`;
  const sourceRoot =
    `./data/launchdarkly-migrations/source/project/${sourceKey}`;
  const aiRoot = `${sourceRoot}/ai-configs`;

  try {
    await Deno.mkdir(aiRoot, { recursive: true });
    await Deno.writeTextFile(
      `${aiRoot}/model-configs.json`,
      JSON.stringify({ items: [{ key: "model-1", name: "Model 1" }] }),
    );
    await Deno.writeTextFile(
      `${aiRoot}/configs.json`,
      JSON.stringify({ items: [{ key: "cfg-a", name: "Config A" }] }),
    );

    const calls: string[] = [];
    const client: AgentControlHttpClient = {
      async post(path) {
        calls.push(`POST ${path}`);
        return { status: 201 };
      },
      async patch(path) {
        calls.push(`PATCH ${path}`);
        return { status: 200 };
      },
    };

    const { summary } = await migrateAgentControlFromExtract({
      apiKey: "test",
      domain: "app.launchdarkly.com",
      sourceProjectKey: sourceKey,
      destProjectKey: "dest-proj",
      dryRun: false,
      client,
    });

    assertEquals(summary.created, 2);
    assertEquals(summary.errors, 0);
    assertEquals(calls[0], "POST projects/dest-proj/ai-configs/model-configs");
    assertEquals(calls[1], "POST projects/dest-proj/ai-configs");
  } finally {
    await Deno.remove(sourceRoot, { recursive: true }).catch(() => {});
  }
});
