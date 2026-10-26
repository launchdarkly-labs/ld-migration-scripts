// deno-lint-ignore-file require-await
// The mock HTTP client methods are async to satisfy the AgentControlHttpClient interface.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
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
  mergeFlagRulesIntoTargeting,
  migrateAgentControlFromExtract,
  modelConfigsPath,
  recordOutcome,
  resolveVariationKey,
  sanitizeAgentControlPayload,
  sanitizeVariationPayload,
  shouldExtractAgentControl,
  targetingHasRules,
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
  const { instructions, issues } = buildTargetingInstructionsForEnvironment(
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
  assertEquals(issues, []);
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

// Source variations: 0 disabled, 1 "on", 2 "gone" (has no destination copy)
const partialRefs = [
  { key: "disabled", _id: "src-off" },
  { key: "on", _id: "src-on" },
  { key: "gone", _id: "src-gone" },
];
const partialDestIds = new Map([["disabled", "dest-off"], ["on", "dest-on"]]);

Deno.test("targeting keeps the default rule and mappable rules when one rule's variation is missing", () => {
  const { instructions, issues } = buildTargetingInstructionsForEnvironment(
    {
      rules: [
        { description: "keep", variation: 1, clauses: [] },
        { description: "lost", variation: 2, clauses: [] },
      ],
      fallthrough: { variation: 1 },
      offVariation: 0,
    },
    partialRefs,
    partialDestIds,
  );
  const kinds = instructions.map((i) => i.kind);
  assertEquals(kinds, [
    "replaceRules",
    "replaceTargets",
    "updateFallthroughVariationOrRollout",
    "updateOffVariation",
  ]);
  assertEquals(
    (instructions[0].rules as Array<Record<string, unknown>>).map((r) =>
      r.description
    ),
    ["keep"],
  );
  assertEquals(issues.length, 1);
  assertEquals(issues[0].severity, "error");
  assertEquals(issues[0].part, "rule");
  assertEquals(issues[0].variationKey, "gone");
  assert(issues[0].message.includes('Rule 2 ("lost")'));
});

Deno.test("targeting reports a default rule or off variation it cannot map, and still applies the rest", () => {
  const { instructions, issues } = buildTargetingInstructionsForEnvironment(
    {
      rules: [{ variation: 1, clauses: [] }],
      targets: [{ variation: 2, values: ["u1", "u2"] }],
      fallthrough: { variation: 2 },
      offVariation: 2,
    },
    partialRefs,
    partialDestIds,
  );
  assertEquals(instructions.map((i) => i.kind), [
    "replaceRules",
    "replaceTargets",
  ]);
  assertEquals(
    issues.map((i) => `${i.severity}:${i.part}:${i.variationKey}`),
    [
      "error:target:gone",
      "error:fallthrough:gone",
      "error:offVariation:gone",
    ],
  );
});

Deno.test("targeting never sends a rollout with an unmapped weight, or a rule that serves nothing", () => {
  const { instructions, issues } = buildTargetingInstructionsForEnvironment(
    {
      rules: [
        {
          rollout: {
            variations: [
              { variation: 1, weight: 60000 },
              { variation: 2, weight: 40000 },
            ],
          },
          clauses: [],
        },
        { clauses: [] },
      ],
      fallthrough: {
        rollout: {
          variations: [
            { variation: 1, weight: 50000 },
            { variation: 2, weight: 50000 },
          ],
        },
      },
    },
    partialRefs,
    partialDestIds,
  );
  assertEquals(instructions[0], { kind: "replaceRules", rules: [] });
  assertEquals(
    instructions.some((i) => i.kind === "updateFallthroughVariationOrRollout"),
    false,
  );
  assertEquals(issues.map((i) => i.part), ["rule", "rule", "fallthrough"]);
  assert(issues.every((i) => i.severity === "error"));
  assert(issues[1].message.includes("neither a variation nor a rollout"));
});

Deno.test("targeting maps full rollouts, event tracking and on/off, and warns about per-rule event tracking", () => {
  const { instructions, issues } = buildTargetingInstructionsForEnvironment(
    {
      enabled: false,
      trackEvents: true,
      trackEventsFallthrough: false,
      rules: [{
        variation: 1,
        trackEvents: true,
        clauses: [],
      }],
      fallthrough: {
        rollout: {
          bucketBy: "key",
          variations: [
            { variation: 0, weight: 25000 },
            { variation: 1, weight: 75000 },
          ],
        },
      },
    },
    partialRefs,
    partialDestIds,
  );
  assertEquals(
    instructions.find((i) => i.kind === "updateFallthroughVariationOrRollout"),
    {
      kind: "updateFallthroughVariationOrRollout",
      rolloutWeights: { "dest-off": 25000, "dest-on": 75000 },
      rolloutBucketBy: "key",
    },
  );
  assertEquals(
    instructions.find((i) => i.kind === "updateTrackEvents"),
    { kind: "updateTrackEvents", trackEvents: true },
  );
  assertEquals(
    instructions.find((i) => i.kind === "updateTrackEventsFallthrough"),
    { kind: "updateTrackEventsFallthrough", trackEvents: false },
  );
  assertEquals(instructions.at(-1), { kind: "disableTargeting" });
  assertEquals(
    issues.map((i) => `${i.severity}:${i.part}`),
    ["warning:trackEvents"],
  );
});

// Agent-mode targeting variations carry their metadata as the value itself (shape seen on staging)
const agentTargetingVariations = [
  {
    _id: "dbe46fa9",
    name: "disabled",
    value: { enabled: false },
  },
  {
    _id: "c2c58a26",
    name: "Friendly Support Bot",
    value: {
      enabled: true,
      mode: "agent",
      modelKey: "Anthropic.claude-haiku-4-5-20251001",
      variationKey: "friendly-support-bot",
    },
  },
];

Deno.test("resolveVariationKey reads agent-mode targeting values, which have no _ldMeta wrapper", () => {
  assertEquals(
    agentTargetingVariations.map((v) => resolveVariationKey(v)),
    ["disabled", "friendly-support-bot"],
  );
  assertEquals(
    [...collectReferencedModelConfigKeys(agentTargetingVariations)],
    ["Anthropic.claude-haiku-4-5-20251001"],
  );
});

Deno.test("agent-mode targeting resolves keys from the value, not from config-detail IDs that change on edit", () => {
  // The config detail reports the edited variation under a different (per-version) ID
  const refs = buildSourceVariationRefsFromTargeting(agentTargetingVariations, [
    { key: "friendly-support-bot", _id: "594d8670", name: "Renamed bot" },
  ]);
  assertEquals(refs, [
    { key: "disabled", _id: "dbe46fa9" },
    { key: "friendly-support-bot", _id: "c2c58a26" },
  ]);
});

Deno.test("staging fixture: rules come from the backing flag and the whole environment maps", async () => {
  const dir = new URL("./testdata/agent_control/", import.meta.url);
  const targeting = JSON.parse(
    await Deno.readTextFile(new URL("staging_targeting.json", dir)),
  );
  const flag = JSON.parse(
    await Deno.readTextFile(new URL("staging_flag.json", dir)),
  );
  const env = targeting.environments.test;

  // The targeting resource does not say what its rules serve
  assertEquals(
    env.rules.map((r: Record<string, unknown>) => Object.keys(r).sort()),
    [["clauses", "trackEvents"], ["clauses", "trackEvents"]],
  );
  assert(targetingHasRules(targeting));
  assertEquals(mergeFlagRulesIntoTargeting(targeting, flag), []);

  const refs = buildSourceVariationRefsFromTargeting(targeting.variations);
  assertEquals(refs.map((r) => r.key), ["disabled", "v-gemini", "v-claude"]);
  const destIds = new Map(refs.map((r) => [r.key, `dest-${r.key}`]));
  const { instructions, issues } = buildTargetingInstructionsForEnvironment(
    env,
    refs,
    destIds,
  );
  assertEquals(issues, []);
  const byKind = Object.fromEntries(instructions.map((i) => [i.kind, i]));
  assertEquals(byKind.replaceRules.rules, [
    {
      clauses: [{
        attribute: "country",
        op: "in",
        values: ["US"],
        contextKind: "user",
        negate: false,
      }],
      description: "claude rule",
      variationId: "dest-v-claude",
    },
    {
      clauses: [{
        attribute: "plan",
        op: "in",
        values: ["pro"],
        contextKind: "user",
        negate: false,
      }],
      description: "rollout rule",
      rolloutWeights: { "dest-v-gemini": 50000, "dest-v-claude": 50000 },
      rolloutContextKind: "user",
    },
  ]);
  // User targets are listed in both `targets` and `contextTargets`; sent once
  assertEquals(byKind.replaceTargets.targets, [
    { variationId: "dest-v-claude", values: ["alice"], contextKind: "user" },
  ]);
  assertEquals(byKind.updateFallthroughVariationOrRollout, {
    kind: "updateFallthroughVariationOrRollout",
    variationId: "dest-v-gemini",
  });
  assertEquals(byKind.updateOffVariation.variationId, "dest-v-claude");
  assertEquals(byKind.updateTrackEvents.trackEvents, true);
  assertEquals(instructions.at(-1), { kind: "enableTargeting" });

  // Production was turned off on staging
  const prod = buildTargetingInstructionsForEnvironment(
    targeting.environments.production,
    refs,
    destIds,
  );
  assertEquals(prod.instructions.at(-1), { kind: "disableTargeting" });
});

Deno.test("flag rules that do not line up with the targeting rules are reported, not guessed", () => {
  const targeting = {
    environments: {
      test: { rules: [{ clauses: [{ id: "c1" }], trackEvents: false }] },
    },
  };
  const flag = {
    variations: [{ _id: "v0" }],
    environments: {
      test: { rules: [{ variation: 0, clauses: [{ _id: "other" }] }] },
    },
  };
  assertEquals(mergeFlagRulesIntoTargeting(targeting, flag), ["test"]);
  assertEquals(
    (targeting.environments.test.rules[0] as Record<string, unknown>)
      .variation,
    undefined,
  );
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
  // A 403/404 on a write fails that write; it does not mean AgentControl is unavailable
  assertEquals(classifyUpsertStatus(403), "error");
  assertEquals(classifyUpsertStatus(404), "error");
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

Deno.test("AGENT_CONTROL_MIGRATE_ORDER is models → configs → variations → targeting → variation state", () => {
  assertEquals([...AGENT_CONTROL_MIGRATE_ORDER], [
    "model-configs",
    "configs",
    "variations",
    "targeting",
    "variation-state",
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

Deno.test("upsertAgentControlResource leaves an immutable model config alone after a rejected PATCH", async () => {
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
    { immutableSkip: true },
  );
  assertEquals(outcome, "skipped");
});

Deno.test("upsertAgentControlResource reports a rejected PATCH of a config or variation as an error", async () => {
  for (const status of [400, 405, 422]) {
    const failures: Array<{ status: number; body?: string }> = [];
    const client: AgentControlHttpClient = {
      async post() {
        return { status: 409 };
      },
      async patch() {
        return { status, body: `{"message":"model not found"}` };
      },
    };
    const outcome = await upsertAgentControlResource(
      client,
      "projects/dest/ai-configs/cfg/variations",
      "projects/dest/ai-configs/cfg/variations/v1",
      { key: "v1" },
      false,
      { onFailure: (f) => failures.push(f) },
    );
    assertEquals(outcome, "error");
    assertEquals(failures.length, 1);
    assertEquals(failures[0].status, status);
    assert(failures[0].body?.includes("model not found"));
  }
});

Deno.test("upsertAgentControlResource reports a 403/404 on a write as an error, with its body", async () => {
  for (const status of [403, 404]) {
    const failures: string[] = [];
    const client: AgentControlHttpClient = {
      async post() {
        return { status, body: "Unknown model config" };
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
      { onFailure: (f) => failures.push(`${f.action} ${f.status} ${f.body}`) },
    );
    assertEquals(outcome, "error");
    assertEquals(failures, [`POST ${status} Unknown model config`]);
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
