import { assert, assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideVariations,
  KeyRegistry,
  type MappingContext,
  mapEnvironment,
  mapFlag,
  mapLargeSegment,
  mapRuleBasedSegment,
  mapStandardSegment,
  mapTrafficTypes,
  normalizeEpochMs,
  sanitizeKey,
} from "./mapping.ts";
import type { SplitFlagDefinition } from "./types.ts";

const ctx = (overrides: Partial<MappingContext> = {}): MappingContext => ({
  kindByTrafficType: new Map([["user", "user"], ["account", "account"]]),
  segmentKeyByName: new Map([["Beta Testers", "Beta-Testers"]]),
  flagKeyByName: new Map([["new_homepage", "new_homepage"]]),
  ...overrides,
});

/** Minimal definition builder: boolean on/off flag, off by default. */
const def = (overrides: Partial<SplitFlagDefinition> = {}): SplitFlagDefinition => ({
  name: "my_flag",
  environment: { id: "e1", name: "Production" },
  trafficType: { id: "t1", name: "user" },
  killed: false,
  treatments: [{ name: "on" }, { name: "off" }],
  defaultTreatment: "off",
  trafficAllocation: 100,
  rules: [],
  defaultRule: [{ treatment: "off", size: 100 }],
  ...overrides,
});

const decisionFor = (d: SplitFlagDefinition) => decideVariations(d.name, [d]);

// ==================== Keys ====================

Deno.test("sanitizeKey preserves case for flags, strips invalid chars", () => {
  assertEquals(sanitizeKey("My Flag (v2)!"), "My-Flag-v2");
  assertEquals(sanitizeKey("Prod-Default", { lowercase: true }), "prod-default");
  assertEquals(sanitizeKey("__weird__"), "weird");
});

Deno.test("KeyRegistry suffixes collisions and is stable per name", () => {
  const reg = new KeyRegistry({ lowercase: true });
  assertEquals(reg.keyFor("My Env"), "my-env");
  assertEquals(reg.keyFor("my env"), "my-env-2");
  assertEquals(reg.keyFor("My Env"), "my-env");
});

// ==================== Context kinds ====================

Deno.test("mapTrafficTypes: user is built-in, others become context kinds, reserved names suffixed", () => {
  const { contextKinds, kindByTrafficType, notes } = mapTrafficTypes([
    { id: "1", name: "user" },
    { id: "2", name: "Account" },
    { id: "3", name: "kind" },
  ]);

  assertEquals(kindByTrafficType.get("user"), "user");
  assertEquals(kindByTrafficType.get("Account"), "account");
  assertEquals(kindByTrafficType.get("kind"), "kind-context");
  // "user" maps to the built-in kind — no context kind payload for it
  assertEquals(contextKinds.map((k) => k.key), ["account", "kind-context"]);
  assert(notes.some((n) => n.level === "PARTIAL" && n.item === "kind"));
});

// ==================== Variations ====================

Deno.test("decideVariations: plain on/off with no configs is boolean", () => {
  const d = decisionFor(def());
  assertEquals(d.kind, "boolean");
  assertEquals(d.variations.map((v) => v.value), [true, false]);
  assertEquals(d.indexByTreatment.get("on"), 0);
  assertEquals(d.indexByTreatment.get("off"), 1);
});

Deno.test("decideVariations: any configuration anywhere forces JSON variations", () => {
  const d = decideVariations("f", [
    def({
      treatments: [
        { name: "on", configurations: '{"color":"red"}' },
        { name: "off" },
      ],
    }),
  ]);
  assertEquals(d.kind, "multivariate");
  assertEquals(d.variations[0].value, { treatment: "on", config: { color: "red" } });
  assertEquals(d.variations[1].value, { treatment: "off", config: null });
});

Deno.test("decideVariations: multivariate without configs uses treatment-name strings", () => {
  const d = decideVariations("f", [
    def({ treatments: [{ name: "control" }, { name: "v1" }, { name: "v2" }] }),
  ]);
  assertEquals(d.kind, "multivariate");
  assertEquals(d.variations.map((v) => v.value), ["control", "v1", "v2"]);
});

Deno.test("decideVariations: cross-env config conflicts keep priority env and note PARTIAL", () => {
  const d = decideVariations("f", [
    def({
      environment: { id: "e1", name: "Production" },
      treatments: [{ name: "on", configurations: '{"v":1}' }, { name: "off" }],
    }),
    def({
      environment: { id: "e2", name: "Staging" },
      treatments: [{ name: "on", configurations: '{"v":2}' }, { name: "off" }],
    }),
  ]);
  assertEquals(d.variations[0].value, { treatment: "on", config: { v: 1 } });
  assert(d.notes.some((n) => n.level === "PARTIAL" && n.message.includes("different configurations")));
});

// ==================== Environment state ====================

Deno.test("mapEnvironment: killed flag is off, defaultTreatment is offVariation", () => {
  const d = def({ killed: true, defaultTreatment: "off" });
  const { envConfig } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  assertEquals(envConfig.on, false);
  assertEquals(envConfig.offVariation, 1);
});

Deno.test("mapEnvironment: single 100% default bucket becomes fixed fallthrough", () => {
  const d = def({ defaultRule: [{ treatment: "on", size: 100 }] });
  const { envConfig } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  assertEquals(envConfig.fallthrough, { variation: 0 });
});

Deno.test("mapEnvironment: split default buckets become a rollout with x1000 weights", () => {
  const d = def({
    defaultRule: [{ treatment: "on", size: 25 }, { treatment: "off", size: 75 }],
  });
  const { envConfig } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  const fallthrough = envConfig.fallthrough as { rollout: { variations: unknown[]; contextKind: string } };
  assertEquals(fallthrough.rollout.variations, [
    { variation: 0, weight: 25_000 },
    { variation: 1, weight: 75_000 },
  ]);
  assertEquals(fallthrough.rollout.contextKind, "user");
});

Deno.test("mapEnvironment: bucket sizes under 100 are normalized onto the default treatment", () => {
  const d = def({
    defaultRule: [{ treatment: "on", size: 30 }, { treatment: "off", size: 30 }],
  });
  const { envConfig, notes } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  const fallthrough = envConfig.fallthrough as { rollout: { variations: Array<{ variation: number; weight: number }> } };
  const total = fallthrough.rollout.variations.reduce((s, v) => s + v.weight, 0);
  assertEquals(total, 100_000);
  const offWeight = fallthrough.rollout.variations.find((v) => v.variation === 1)!.weight;
  assertEquals(offWeight, 70_000);
  assert(notes.some((n) => n.message.includes("normalized to 100%")));
});

Deno.test("mapEnvironment: trafficAllocation under 100 emits a prominent PARTIAL note", () => {
  const d = def({ trafficAllocation: 50 });
  const { notes } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  assert(notes.some((n) => n.level === "PARTIAL" && n.message.includes("50%")));
});

// ==================== Matchers ====================

const ruleDef = (matchers: unknown[], buckets = [{ treatment: "on", size: 100 }]) =>
  def({
    rules: [{
      condition: { combiner: "AND", matchers: matchers as never },
      buckets,
    }],
  });

Deno.test("string/number/set matchers map to the expected clause ops", () => {
  const d = ruleDef([
    { type: "IN_LIST_STRING", attribute: "plan", strings: ["pro", "team"] },
    { type: "STARTS_WITH_STRING", attribute: "email", strings: ["admin"] },
    { type: "GREATER_THAN_OR_EQUAL_NUMBER", attribute: "age", number: 21 },
    { type: "ANY_OF_SET", attribute: "roles", strings: ["a", "b"] },
    { type: "BOOLEAN", attribute: "beta", bool: true },
  ]);
  const { envConfig } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  assertEquals(envConfig.rules.length, 1);
  const ops = envConfig.rules[0].clauses.map((c) => [c.attribute, c.op, c.values]);
  assertEquals(ops, [
    ["plan", "in", ["pro", "team"]],
    ["email", "startsWith", ["admin"]],
    ["age", "greaterThanOrEqual", [21]],
    ["roles", "in", ["a", "b"]],
    ["beta", "in", [true]],
  ]);
  assertEquals(envConfig.rules[0].variation, 0);
});

Deno.test("matcher without attribute targets the context key", () => {
  const d = ruleDef([{ type: "IN_LIST_STRING", strings: ["u1"] }]);
  const { envConfig } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  assertEquals(envConfig.rules[0].clauses[0].attribute, "key");
});

Deno.test("BETWEEN_NUMBER becomes two AND'd clauses", () => {
  const d = ruleDef([{ type: "BETWEEN_NUMBER", attribute: "age", between: { from: 18, to: 65 } }]);
  const { envConfig } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  const [a, b] = envConfig.rules[0].clauses;
  assertEquals([a.op, a.values, b.op, b.values], ["greaterThanOrEqual", [18], "lessThanOrEqual", [65]]);
});

Deno.test("ALL_OF_SET becomes one in-clause per element", () => {
  const d = ruleDef([{ type: "ALL_OF_SET", attribute: "roles", strings: ["a", "b", "c"] }]);
  const { envConfig } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  assertEquals(envConfig.rules[0].clauses.length, 3);
  assert(envConfig.rules[0].clauses.every((c) => c.op === "in"));
});

Deno.test("EQUAL_SET and PART_OF_SET are impossible: rule skipped with MANUAL note", () => {
  for (const type of ["EQUAL_SET", "PART_OF_SET"]) {
    const d = ruleDef([{ type, attribute: "roles", strings: ["a"] }]);
    const { envConfig, notes } = mapEnvironment(d, decisionFor(d), ctx(), "production");
    assertEquals(envConfig.rules.length, 0);
    assert(notes.some((n) => n.level === "MANUAL" && n.message.includes(type)));
  }
});

Deno.test("semver >= uses the semVerLessThan+negate idiom", () => {
  const d = ruleDef([
    { type: "GREATER_THAN_OR_EQUAL_TO_SEMVER", attribute: "version", string: "2.0.0" },
  ]);
  const { envConfig } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  const c = envConfig.rules[0].clauses[0];
  assertEquals([c.op, c.values, c.negate], ["semVerLessThan", ["2.0.0"], true]);
});

Deno.test("epoch seconds are normalized to milliseconds", () => {
  assertEquals(normalizeEpochMs(1457382451), 1457382451000);
  assertEquals(normalizeEpochMs(1457382451000), 1457382451000);
});

Deno.test("ON_OR_AFTER_DATE maps to negated before at minute granularity", () => {
  const d = ruleDef([
    { type: "ON_OR_AFTER_DATE", attribute: "signup", date: 1457382451 }, // seconds
  ]);
  const { envConfig } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  const c = envConfig.rules[0].clauses[0];
  assertEquals(c.op, "before");
  assertEquals(c.negate, true);
  const value = c.values[0] as number;
  assertEquals(value % 60_000, 0);
  assert(Math.abs(value - 1457382451000) < 60_000);
});

Deno.test("negated BETWEEN_NUMBER expands to two adjacent OR rules", () => {
  const d = ruleDef([
    { type: "BETWEEN_NUMBER", attribute: "age", negate: true, between: { from: 18, to: 65 } },
  ]);
  const { envConfig } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  assertEquals(envConfig.rules.length, 2);
  // Both rules serve the same outcome; clauses are the negated halves
  assertEquals(envConfig.rules[0].clauses[0].negate, true);
  assertEquals(envConfig.rules[1].clauses[0].negate, true);
  assert(envConfig.rules.every((r) => r.variation === 0));
  assert(envConfig.rules[0].description?.includes("OR expansion 1/2"));
});

Deno.test("oversized OR expansion is skipped with a MANUAL note", () => {
  // 2 negated set matchers of 3 elements each = 9 combinations > 8 cap
  const d = ruleDef([
    { type: "ALL_OF_SET", attribute: "a", negate: true, strings: ["1", "2", "3"] },
    { type: "ALL_OF_SET", attribute: "b", negate: true, strings: ["4", "5", "6"] },
  ]);
  const { envConfig, notes } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  assertEquals(envConfig.rules.length, 0);
  assert(notes.some((n) => n.level === "MANUAL" && n.message.includes("OR logic")));
});

Deno.test("IN_SEGMENT maps to a segmentMatch clause with the mapped key", () => {
  const d = ruleDef([{ type: "IN_SEGMENT", string: "Beta Testers" }]);
  const { envConfig } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  const c = envConfig.rules[0].clauses[0];
  assertEquals(c, {
    attribute: "segmentMatch",
    op: "segmentMatch",
    values: ["Beta-Testers"],
    negate: false,
    contextKind: "",
  });
});

Deno.test("rule buckets become a per-rule rollout", () => {
  const d = ruleDef(
    [{ type: "IN_LIST_STRING", attribute: "plan", strings: ["pro"] }],
    [{ treatment: "on", size: 10 }, { treatment: "off", size: 90 }],
  );
  const { envConfig } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  const rollout = envConfig.rules[0].rollout!;
  assertEquals(rollout.variations, [
    { variation: 0, weight: 10_000 },
    { variation: 1, weight: 90_000 },
  ]);
});

// ==================== Targets and treatment segments ====================

Deno.test("treatment keys become individual targets; duplicates dedupe first-wins", () => {
  const d = def({
    treatments: [
      { name: "on", keys: ["u1", "u2"] },
      { name: "off", keys: ["u2", "u3"] },
    ],
  });
  const { envConfig, notes } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  assertEquals(envConfig.targets, [
    { values: ["u1", "u2"], variation: 0 },
    { values: ["u3"], variation: 1 },
  ]);
  assert(notes.some((n) => n.message.includes(`"u2"`)));
});

Deno.test("non-user traffic types use contextTargets with the mapped kind", () => {
  const d = def({
    trafficType: { id: "t2", name: "account" },
    treatments: [{ name: "on", keys: ["acme"] }, { name: "off" }],
  });
  const { envConfig } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  assertEquals(envConfig.contextTargets, [{ values: ["acme"], variation: 0, contextKind: "account" }]);
  assertEquals(envConfig.targets, undefined);
});

Deno.test("treatment segments become prepended segmentMatch rules serving that treatment", () => {
  const d = def({
    treatments: [{ name: "on", segments: ["Beta Testers"] }, { name: "off" }],
    rules: [{
      condition: { matchers: [{ type: "IN_LIST_STRING", attribute: "plan", strings: ["pro"] }] },
      buckets: [{ treatment: "on", size: 100 }],
    }],
  });
  const { envConfig } = mapEnvironment(d, decisionFor(d), ctx(), "production");
  assertEquals(envConfig.rules.length, 2);
  assertEquals(envConfig.rules[0].clauses[0].op, "segmentMatch");
  assertEquals(envConfig.rules[0].variation, 0);
  assertEquals(envConfig.rules[1].clauses[0].attribute, "plan");
});

// ==================== Prerequisites (IN_SPLIT) ====================

const prereqDef = () =>
  def({
    rules: [{
      condition: {
        matchers: [{ type: "IN_SPLIT", depends: { splitName: "new_homepage", treatment: "on" } }],
      },
      buckets: [{ treatment: "on", size: 100 }],
    }],
    defaultRule: [{ treatment: "off", size: 100 }],
  });

Deno.test("strict IN_SPLIT shape maps to an LD prerequisite", () => {
  const c = ctx({
    resolvePrerequisite: (name, treatment) =>
      name === "new_homepage" && treatment === "on" ? { key: "new_homepage", variation: 0 } : null,
  });
  const d = prereqDef();
  const { envConfig, notes } = mapEnvironment(d, decisionFor(d), c, "production");
  assertEquals(envConfig.prerequisites, [{ key: "new_homepage", variation: 0 }]);
  assertEquals(envConfig.rules, []);
  assertEquals(envConfig.fallthrough, { variation: 0 });
  assert(notes.some((n) => n.level === "FULL" && n.message.includes("prerequisite")));
});

Deno.test("IN_SPLIT outside the strict shape is MANUAL and the rule is skipped", () => {
  // Two rules → not the strict shape
  const d = def({
    rules: [
      {
        condition: {
          matchers: [{ type: "IN_SPLIT", depends: { splitName: "new_homepage", treatment: "on" } }],
        },
        buckets: [{ treatment: "on", size: 100 }],
      },
      {
        condition: { matchers: [{ type: "IN_LIST_STRING", attribute: "plan", strings: ["pro"] }] },
        buckets: [{ treatment: "on", size: 100 }],
      },
    ],
  });
  const c = ctx({ resolvePrerequisite: () => ({ key: "new_homepage", variation: 0 }) });
  const { envConfig, notes } = mapEnvironment(d, decisionFor(d), c, "production");
  assertEquals(envConfig.prerequisites, undefined);
  assertEquals(envConfig.rules.length, 1); // only the plan rule survives
  assert(notes.some((n) => n.level === "MANUAL" && n.message.includes("IN_SPLIT")));
});

// ==================== Whole flag ====================

Deno.test("mapFlag assembles tags, flag-set tags, defaults, and environments", () => {
  const d = def({ defaultRule: [{ treatment: "on", size: 100 }] });
  const decision = decisionFor(d);
  const { flag } = mapFlag({
    meta: {
      id: "1",
      name: "my_flag",
      description: "desc",
      trafficType: { id: "t1", name: "user" },
      tags: [{ name: "checkout" }],
    },
    splitName: "my_flag",
    flagKey: "my_flag",
    defsByLdEnv: { production: d },
    envPriority: ["production"],
    decision,
    ctx: ctx(),
    extraTags: ["imported-from-split"],
    flagSetNames: ["core:sets"],
  });

  assertEquals(flag.key, "my_flag");
  assertEquals(flag.kind, "boolean");
  assert(flag.tags.includes("checkout"));
  assert(flag.tags.includes("imported-from-split"));
  // ':' is illegal in LD tags — flag set names are sanitized
  assert(flag.tags.includes("flagset.core-sets"));
  assertEquals(flag.defaults, { onVariation: 0, offVariation: 1 });
  assertExists(flag.environments.production);
});

// ==================== Segments ====================

Deno.test("standard segment maps to included keys (user kind)", () => {
  const { segment, notes } = mapStandardSegment({
    meta: { name: "Beta Testers", trafficType: { id: "t1", name: "user" } },
    splitName: "Beta Testers",
    segmentKey: "Beta-Testers",
    keys: ["u1", "u2"],
    ctx: ctx(),
  });
  assertEquals(segment.included, ["u1", "u2"]);
  assertEquals(segment.unbounded, undefined);
  assert(notes.some((n) => n.level === "FULL"));
});

Deno.test("standard segment with non-user kind uses includedContexts", () => {
  const { segment } = mapStandardSegment({
    meta: { name: "Key Accounts", trafficType: { id: "t2", name: "account" } },
    splitName: "Key Accounts",
    segmentKey: "Key-Accounts",
    keys: ["acme"],
    ctx: ctx(),
  });
  assertEquals(segment.includedContexts, [{ contextKind: "account", values: ["acme"] }]);
});

Deno.test("standard segment over 15k keys upgrades to a big segment with import keys", () => {
  const keys = Array.from({ length: 15_001 }, (_, i) => `u${i}`);
  const { segment, notes } = mapStandardSegment({
    meta: { name: "Huge", trafficType: { id: "t1", name: "user" } },
    splitName: "Huge",
    segmentKey: "Huge",
    keys,
    ctx: ctx(),
  });
  assertEquals(segment.unbounded, true);
  assertEquals(segment.unboundedContextKind, "user");
  assertEquals(segment._importKeys?.length, 15_001);
  assert(notes.some((n) => n.level === "PARTIAL" && n.message.includes("big")));
});

Deno.test("rule-based segment maps the attribute/operator/value dialect", () => {
  const { segment, notes } = mapRuleBasedSegment({
    rbs: {
      name: "Beta Emails",
      trafficType: { id: "t1", name: "user" },
      rules: [{
        condition: {
          combiner: "AND",
          matchers: [
            { attribute: "email", operator: "ends_with", value: "@beta.example.com" },
            { attribute: "age", operator: "greater_than", value: 25 },
          ],
        },
      }],
      excludedKeys: ["u9"],
    },
    segmentKey: "Beta-Emails",
    ctx: ctx(),
  });
  assertEquals(segment.rules?.length, 1);
  assertEquals(segment.rules![0].clauses.map((c) => [c.attribute, c.op, c.values]), [
    ["email", "endsWith", ["@beta.example.com"]],
    ["age", "greaterThan", [25]],
  ]);
  assertEquals(segment.excluded, ["u9"]);
  assertEquals(notes.filter((n) => n.level === "MANUAL").length, 0);
});

Deno.test("rule-based segment also accepts the flag-matcher dialect", () => {
  const { segment } = mapRuleBasedSegment({
    rbs: {
      name: "Pro Plans",
      trafficType: { id: "t1", name: "user" },
      rules: [{
        condition: {
          matchers: [{ type: "IN_LIST_STRING", attribute: "plan", strings: ["pro"] }],
        },
      }],
    },
    segmentKey: "Pro-Plans",
    ctx: ctx(),
  });
  assertEquals(segment.rules![0].clauses[0].op, "in");
});

Deno.test("rule-based segment rejects segment references inside rules (MANUAL)", () => {
  const { segment, notes } = mapRuleBasedSegment({
    rbs: {
      name: "Nested",
      trafficType: { id: "t1", name: "user" },
      rules: [{
        condition: { matchers: [{ type: "IN_SEGMENT", string: "Beta Testers" }] },
      }],
    },
    segmentKey: "Nested",
    ctx: ctx(),
  });
  assertEquals(segment.rules, undefined);
  assert(notes.some((n) => n.level === "MANUAL" && n.message.includes("segmentMatch")));
});

Deno.test("excludedSegments inline as snapshots when keys are resolvable, else MANUAL", () => {
  const rbs = {
    name: "Everyone But Testers",
    trafficType: { id: "t1", name: "user" },
    rules: [],
    excludedSegments: [{ name: "Beta Testers", type: "segment" }],
  };
  const inlined = mapRuleBasedSegment({
    rbs,
    segmentKey: "k",
    ctx: ctx(),
    resolveSegmentKeys: () => ["u1", "u2"],
  });
  assertEquals(inlined.segment.excluded, ["u1", "u2"]);
  assert(inlined.notes.some((n) => n.level === "PARTIAL" && n.message.includes("snapshot")));

  const manual = mapRuleBasedSegment({ rbs, segmentKey: "k", ctx: ctx() });
  assertEquals(manual.segment.excluded, undefined);
  assert(manual.notes.some((n) => n.level === "MANUAL"));
});

Deno.test("large segments become unbounded with a MANUAL membership note", () => {
  const { segment, notes } = mapLargeSegment({
    name: "All Customers",
    segmentKey: "All-Customers",
    trafficTypeName: "user",
    ctx: ctx(),
  });
  assertEquals(segment.unbounded, true);
  assertEquals(segment.unboundedContextKind, "user");
  assert(notes.some((n) => n.level === "MANUAL" && n.message.includes("CSV")));
});
