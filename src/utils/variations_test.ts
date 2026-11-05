import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type FlagDefaults,
  type FlagVariation,
  isIdentityMapping,
  planChangesVariations,
  planVariationSync,
  translateVariationRefs,
  variationIndexByValue,
  type VariationPatchOp,
  type VariationPlan,
} from "./variations.ts";

const dest = (values: unknown[]): FlagVariation[] =>
  values.map((value, i) => ({ _id: `id-${i}`, value, name: String(value) }));
const src = (values: unknown[]): FlagVariation[] =>
  values.map((value, i) => ({ _id: `src-${i}`, value, name: String(value) }));

/**
 * Applies a plan the way LaunchDarkly does: each patch must leave distinct values and valid defaults;
 * a variation still used by defaults or an environment cannot be removed; removing a variation
 * renumbers environment references but not defaults. Environments are patched between the two
 * patches, from the source settings translated with sourceToDest.
 */
function simulate(
  plan: VariationPlan,
  srcVars: FlagVariation[],
  destVars: FlagVariation[],
  srcDefaults: FlagDefaults,
  destDefaults: FlagDefaults,
  srcEnvRefs: number[],
  destEnvRefs: number[],
) {
  const vars = destVars.map((v) => ({ ...v }));
  let defaults = { ...destDefaults };
  let envRefs = [...destEnvRefs];
  let nextId = 0;
  const validate = (stage: string) => {
    const values = vars.map((v) => JSON.stringify(v.value));
    if (new Set(values).size !== values.length) {
      throw new Error(`${stage}: Flag variations must all be distinct`);
    }
    if (
      defaults.onVariation >= vars.length ||
      defaults.offVariation >= vars.length
    ) {
      throw new Error(`${stage}: Default variation must be a valid index`);
    }
  };
  const apply = (ops: VariationPatchOp[], stage: string) => {
    const startDefaults = { ...defaults };
    for (const { op, path, value } of ops) {
      if (path === "/defaults") {
        defaults = { ...(value as FlagDefaults) };
        continue;
      }
      const [, , idx, field] = path.split("/");
      if (idx === "-") {
        vars.push(
          { _id: `new-${nextId++}`, ...(value as object) } as FlagVariation,
        );
      } else if (field) {
        const v = vars[Number(idx)] as Record<string, unknown>;
        if (op === "remove") delete v[field];
        else v[field] = value;
      } else {
        const i = Number(idx);
        if (
          startDefaults.onVariation === i || startDefaults.offVariation === i
        ) {
          throw new Error(`${stage}: Cannot delete the default variation ${i}`);
        }
        if (envRefs.includes(i)) {
          throw new Error(`${stage}: variation ${i} is used by an environment`);
        }
        vars.splice(i, 1);
        envRefs = envRefs.map((r) => (r > i ? r - 1 : r));
      }
    }
    validate(stage);
  };

  apply(plan.before, "before");
  envRefs = srcEnvRefs.map((r) => plan.sourceToDest[r]);
  for (const [k, r] of envRefs.entries()) {
    assertEquals(
      vars[r].value,
      srcVars[srcEnvRefs[k]].value,
      "environment served the wrong value",
    );
  }
  apply(plan.after, "after");

  assertEquals(
    vars.map((v) => [v.value, v.name, v.description]),
    srcVars.map((v) => [v.value, v.name, v.description]),
  );
  assertEquals(defaults, srcDefaults);
  assertEquals(envRefs, srcEnvRefs);
  return vars;
}

Deno.test("identical variations produce no ops", () => {
  const plan = planVariationSync(src([true, false]), dest([true, false]));
  assertEquals(plan, { before: [], after: [], sourceToDest: [0, 1] });
  assertEquals(planChangesVariations(plan), false);
});

Deno.test("_id and valueHash differences alone are not changes", () => {
  const plan = planVariationSync(
    [{ _id: "a", value: "x", valueHash: "h1" }],
    [{ _id: "b", value: "x", valueHash: "h2" }],
  );
  assertEquals(plan.before, []);
  assertEquals(plan.after, []);
});

Deno.test("unchanged defaults are not patched; changed defaults are", () => {
  const vars = src(["a", "b"]);
  const same = planVariationSync(vars, dest(["a", "b"]), {
    srcDefaults: { onVariation: 0, offVariation: 1 },
    destDefaults: { onVariation: 0, offVariation: 1 },
  });
  assertEquals(same.before, []);
  const changed = planVariationSync(vars, dest(["a", "b"]), {
    srcDefaults: { onVariation: 1, offVariation: 1 },
    destDefaults: { onVariation: 0, offVariation: 1 },
  });
  assertEquals(changed.before, [{
    op: "replace",
    path: "/defaults",
    value: { onVariation: 1, offVariation: 1 },
  }]);
  assertEquals(planChangesVariations(changed), false);
});

Deno.test("add-only (radio-inbound-qa-judge-audit, 3 → 4) appends and edits nothing", () => {
  const plan = planVariationSync(
    src(["off", "1%", "5%", "2% of correct cards"]),
    dest(["off", "1%", "5%"]),
  );
  assertEquals(plan.before, [{
    op: "add",
    path: "/variations/-",
    value: { value: "2% of correct cards", name: "2% of correct cards" },
  }]);
  assertEquals(plan.after, []);
  assertEquals(plan.sourceToDest, [0, 1, 2, 3]);
});

Deno.test("same-count value change (resolve-product-types) edits in place", () => {
  const plan = planVariationSync(
    [{ value: { types: ["a", "b"] }, name: "Default" }, {
      value: { types: [] },
      name: "None",
    }],
    [{ _id: "id-0", value: { types: ["a"] }, name: "Default" }, {
      _id: "id-1",
      value: { types: [] },
      name: "None",
    }],
  );
  assertEquals(plan.before, [{
    op: "replace",
    path: "/variations/0/value",
    value: { types: ["a", "b"] },
  }]);
  assertEquals(plan.after, []);
});

Deno.test("renamed variation (anet-spoken-language-names) only changes what differs", () => {
  const plan = planVariationSync(
    [{ value: "en" }, { value: "test", name: "test" }],
    [{ _id: "id-0", value: "en" }, {
      _id: "id-1",
      value: "pl",
      name: "polish inflected",
    }],
  );
  assertEquals(plan.before, [
    { op: "replace", path: "/variations/1/value", value: "test" },
    { op: "replace", path: "/variations/1/name", value: "test" },
  ]);
});

Deno.test("grow with an edit (uncad-boundary-release, 3 → 6)", () => {
  const plan = planVariationSync(
    src(["off", "on", "dev-v2", "stage-1", "stage-2", "stage-4"]),
    dest(["off", "on", "dev-v1"]),
  );
  assertEquals(plan.before.map((o) => `${o.op} ${o.path}`), [
    "replace /variations/2/value",
    "replace /variations/2/name",
    "add /variations/-",
    "add /variations/-",
    "add /variations/-",
  ]);
  assertEquals(plan.after, []);
});

Deno.test("mid-list removal (conv-ai-agent-llm-model, 12 → 10) keeps surviving variations and removes the others last", () => {
  const before = Array.from({ length: 12 }, (_, i) => `model-${i}`);
  const after = [...before.slice(0, 7), "model-9", "model-10", "caching"];
  const plan = planVariationSync(src(after), dest(before), {
    srcDefaults: { onVariation: 9, offVariation: 0 },
    destDefaults: { onVariation: 11, offVariation: 0 },
  });
  assertEquals(plan.before, [
    { op: "replace", path: "/variations/11/value", value: "caching" },
    { op: "replace", path: "/variations/11/name", value: "caching" },
  ]);
  assertEquals(plan.sourceToDest, [0, 1, 2, 3, 4, 5, 6, 9, 10, 11]);
  assertEquals(plan.after, [
    { op: "remove", path: "/variations/8" },
    { op: "remove", path: "/variations/7" },
    {
      op: "replace",
      path: "/defaults",
      value: { onVariation: 9, offVariation: 0 },
    },
  ]);
  const final = simulate(
    plan,
    src(after),
    dest(before),
    { onVariation: 9, offVariation: 0 },
    { onVariation: 11, offVariation: 0 },
    [7, 8, 9, 0],
    [9, 10, 11, 8],
  );
  // model-9 and model-10 keep their IDs, so environments serving them were never re-pointed to another value
  assertEquals(final.map((v) => v._id).slice(7), ["id-9", "id-10", "id-11"]);
});

Deno.test("a re-run after a removal was refused sends nothing before the environments", () => {
  // The destination already has the edits and defaults of the first run, plus the 2 variations it kept
  const kept = Array.from({ length: 12 }, (_, i) => `model-${i}`);
  kept[11] = "caching";
  const after = [...kept.slice(0, 7), "model-9", "model-10", "caching"];
  const plan = planVariationSync(src(after), dest(kept), {
    srcDefaults: { onVariation: 9, offVariation: 0 },
    destDefaults: { onVariation: 11, offVariation: 0 },
  });
  assertEquals(plan.before, []);
  assertEquals(plan.after.filter((op) => op.op === "remove").length, 2);
});

Deno.test("shrink with an identical prefix only removes", () => {
  const plan = planVariationSync(src(["a", "b"]), dest(["a", "b", "c"]));
  assertEquals(plan.before, []);
  assertEquals(plan.after, [{ op: "remove", path: "/variations/2" }]);
  assertEquals(planChangesVariations(plan), true);
});

Deno.test("swapped values fall back to editing in place", () => {
  const plan = planVariationSync(src(["b", "a"]), dest(["a", "b"]), {
    srcDefaults: { onVariation: 0, offVariation: 1 },
    destDefaults: { onVariation: 0, offVariation: 1 },
  });
  assertEquals(plan.sourceToDest, [0, 1]);
  assertEquals(plan.after, []);
  simulate(
    plan,
    src(["b", "a"]),
    dest(["a", "b"]),
    { onVariation: 0, offVariation: 1 },
    { onVariation: 0, offVariation: 1 },
    [0],
    [1],
  );
});

Deno.test("a variation inserted mid-list keeps the source order", () => {
  const plan = planVariationSync(src(["a", "b", "c"]), dest(["a", "c"]));
  assertEquals(plan.sourceToDest, [0, 1, 2]);
  simulate(
    plan,
    src(["a", "b", "c"]),
    dest(["a", "c"]),
    { onVariation: 0, offVariation: 0 },
    { onVariation: 0, offVariation: 0 },
    [2],
    [1],
  );
});

Deno.test("kind change (saml-callback-login-binding, boolean → multivariate) is incompatible", () => {
  const plan = planVariationSync(
    src(["off", "observe", "enforce"]),
    dest([true, false]),
    { srcKind: "multivariate", destKind: "boolean" },
  );
  assertEquals(plan.before, []);
  assertEquals(plan.after, []);
  assertEquals(
    plan.incompatible,
    "flag kind changed (boolean → multivariate); LaunchDarkly cannot change a flag's kind, so the destination flag must be deleted and re-created",
  );
});

Deno.test("a name or description the source dropped is removed; a new one is added", () => {
  const plan = planVariationSync(
    [{ value: 1, description: "one" }, { value: 2 }],
    [{ _id: "id-0", value: 1 }, { _id: "id-1", value: 2, name: "two" }],
  );
  assertEquals(plan.before, [
    { op: "add", path: "/variations/0/description", value: "one" },
    { op: "remove", path: "/variations/1/name" },
  ]);
});

Deno.test("a prerequisite is translated by value when the destination kept removed variations", () => {
  // conv-ai-agent-llm-model after a refused removal: the source has 10, the destination still 12
  const kept = Array.from({ length: 12 }, (_, i) => `model-${i}`);
  const now = [...kept.slice(0, 7), "model-9", "model-10", "caching"];
  kept[11] = "caching";
  assertEquals(variationIndexByValue(src(now), dest(kept), 7), 9);
  assertEquals(variationIndexByValue(src(now), dest(kept), 0), 0);
  assertEquals(variationIndexByValue(src(now), dest(kept), 9), 11);
});

Deno.test("a prerequisite has no destination index when its value is not there", () => {
  // The prerequisite flag's update was refused, or its kind changed (saml-callback-login-binding)
  assertEquals(
    variationIndexByValue(src(["off", "observe"]), dest([true, false]), 1),
    undefined,
  );
  assertEquals(variationIndexByValue(src(["a"]), dest(["a"]), 3), undefined);
  // Object values compare by content
  assertEquals(
    variationIndexByValue(
      src([{ types: ["a", "b"] }]),
      dest([{ types: ["a"] }, { types: ["a", "b"] }]),
      0,
    ),
    1,
  );
});

Deno.test("translateVariationRefs maps every variation index in an environment", () => {
  const env = {
    on: true,
    offVariation: 1,
    fallthrough: {
      rollout: {
        variations: [{ variation: 0, weight: 50000 }, {
          variation: 2,
          weight: 50000,
        }],
      },
    },
    rules: [{ _id: "r1", variation: 2, clauses: [] }, {
      _id: "r2",
      rollout: { variations: [{ variation: 1, weight: 100000 }] },
    }],
    targets: [{ variation: 2, values: ["u1"] }],
    contextTargets: [{ variation: 0, values: [], contextKind: "user" }],
    prerequisites: [{ key: "other", variation: 2 }],
  };
  const out = translateVariationRefs(env, [0, 3, 5]);
  assertEquals(out.offVariation, 3);
  assertEquals(out.fallthrough.rollout.variations.map((v) => v.variation), [
    0,
    5,
  ]);
  assertEquals(out.rules[0].variation, 5);
  assertEquals(out.rules[1].rollout!.variations.map((v) => v.variation), [3]);
  assertEquals(out.targets[0].variation, 5);
  assertEquals(out.contextTargets[0].variation, 0);
  // Prerequisites reference the other flag's variations
  assertEquals(out.prerequisites[0].variation, 2);
  assertEquals(
    env.rules[0].variation,
    2,
    "the source settings are not modified",
  );
  assertEquals(isIdentityMapping([0, 1, 2]), true);
  assertEquals(isIdentityMapping([0, 2]), false);
});

Deno.test("random variation changes always end in the source state or are reported", () => {
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pick = (len: number) => {
    const pool = ["a", "b", "c", "d", "e", "f", "g"];
    const out: string[] = [];
    while (out.length < len) {
      const v = pool.splice(rand(pool.length), 1)[0];
      out.push(v);
    }
    return out;
  };
  let incompatible = 0;
  for (let run = 0; run < 2000; run++) {
    const d = dest(pick(1 + rand(6)));
    const s = src(pick(1 + rand(6))).map((v) =>
      rand(3) === 0 ? { ...v, name: `${v.name} renamed` } : v
    );
    const sDef = { onVariation: rand(s.length), offVariation: rand(s.length) };
    const dDef = { onVariation: rand(d.length), offVariation: rand(d.length) };
    const sEnv = [rand(s.length), rand(s.length)];
    const dEnv = [rand(d.length), rand(d.length)];
    const plan = planVariationSync(s, d, {
      srcDefaults: sDef,
      destDefaults: dDef,
    });
    if (plan.incompatible) {
      incompatible++;
      continue;
    }
    simulate(plan, s, d, sDef, dDef, sEnv, dEnv);
  }
  // Only reorderings that cannot be done without a transient duplicate are left to a person
  if (incompatible > 200) {
    throw new Error(`${incompatible} of 2000 plans were incompatible`);
  }
});
