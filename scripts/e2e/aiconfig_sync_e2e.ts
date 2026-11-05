// Live end-to-end test of the AgentControl (AI Config) migration, the AI Config counterpart of
// variation_sync_e2e.ts. `setup` creates AI Configs in the source project, `mutate` changes them the
// way the PDF's flags changed (a variation added, the served one edited, one renamed, one deleted after
// its environments moved away, a mode change), and `verify` compares source and destination by
// variation key, never by position: each variation's content and state, and per environment what the
// default rule, off variation, rules and individual targets serve (read from each config's backing flag,
// since the targeting endpoint omits what rules serve).
//
// Usage (reads config/api_keys.json):
//   deno run -A scripts/e2e/aiconfig_sync_e2e.ts <command> --domain <d> --source <proj> --dest <proj>
// Commands: reset | setup | mutate | verify [--log <migrate log>]
// Only AI Configs whose key starts with `aicfix-` and model configs `aicfix-model-*` are ever created,
// changed or deleted. Other AI Configs in the source (for example exp-pin) are verified, never changed.

import { stripColor } from "https://deno.land/std@0.149.0/fmt/colors.ts";
import { resolveVariationKey } from "../../src/utils/agent_control.ts";

const args = Object.fromEntries(
  Deno.args.slice(1).reduce<string[][]>((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, []),
);
const command = Deno.args[0];
const DOMAIN = args.domain ?? "ld-stg.launchdarkly.com";
const SOURCE = args.source ?? "njordan-aiconfig-mig-test";
const DEST = args.dest ?? "njordan-variation-fix-dest";
const PREFIX = "aicfix-";
const MODEL_PREFIX = "aicfix-model-";
const ENVS = ["uat", "stage", "dev", "qa", "test", "production"];
const BUILT_IN_MODEL = "Gemini.gemini-2.0-flash";
const KEY = JSON.parse(await Deno.readTextFile("config/api_keys.json"))
  .source_account_api_key as string;

async function api(
  method: string,
  path: string,
  body?: unknown,
  semantic = false,
): Promise<{ status: number; json: any; text: string }> {
  for (let attempt = 0;; attempt++) {
    const res = await fetch(`https://${DOMAIN}/api/v2/${path}`, {
      method,
      headers: {
        Authorization: KEY,
        "Content-Type": semantic
          ? "application/json; domain-model=launchdarkly.semanticpatch"
          : "application/json",
        ...(semantic ? {} : { "LD-API-Version": "beta" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 429 && attempt < 10) {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0);
      await new Promise((r) =>
        setTimeout(r, Math.max(1000, reset - Date.now()))
      );
      continue;
    }
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch (_) { /* not JSON */ }
    return { status: res.status, json, text };
  }
}

function must(r: { status: number; text: string }, what: string) {
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`${what}: HTTP ${r.status} ${r.text.slice(0, 400)}`);
  }
}

const base = (proj: string) => `projects/${proj}/ai-configs`;

interface Variation {
  key: string;
  name: string;
  messages?: Array<{ role: string; content: string }>;
  instructions?: string;
  modelConfigKey: string;
  parameters?: Record<string, unknown>;
}

const completion = (
  key: string,
  name = key,
  extra: Partial<Variation> = {},
): Variation => ({
  key,
  name,
  messages: [{ role: "system", content: `You are ${key}.` }],
  modelConfigKey: BUILT_IN_MODEL,
  parameters: { temperature: 0.2 },
  ...extra,
});

const variationBody = (v: Variation) => ({
  key: v.key,
  name: v.name,
  ...(v.messages ? { messages: v.messages } : {}),
  ...(v.instructions !== undefined ? { instructions: v.instructions } : {}),
  modelConfigKey: v.modelConfigKey,
  model: { parameters: v.parameters ?? {} },
});

async function createConfig(
  proj: string,
  key: string,
  mode: "completion" | "agent",
  variations: Variation[],
) {
  must(
    await api("POST", base(proj), { key, name: key, mode }),
    `create ${proj}/${key}`,
  );
  for (const v of variations) await addVariation(proj, key, v);
}

const addVariation = async (proj: string, cfg: string, v: Variation) =>
  must(
    await api("POST", `${base(proj)}/${cfg}/variations`, variationBody(v)),
    `create variation ${cfg}/${v.key}`,
  );

const patchVariation = async (
  proj: string,
  cfg: string,
  key: string,
  body: Record<string, unknown>,
) =>
  must(
    await api("PATCH", `${base(proj)}/${cfg}/variations/${key}`, body),
    `update variation ${cfg}/${key}`,
  );

// Variation key → targeting variation _id ("disabled" for the off variation)
async function variationIds(proj: string, cfg: string) {
  const r = await api("GET", `${base(proj)}/${cfg}/targeting`);
  must(r, `read targeting ${cfg}`);
  return new Map<string, string>(
    (r.json.variations ?? []).map((v: any) => [resolveVariationKey(v), v._id]),
  );
}

type Instr = Record<string, unknown>;
type Builder = (id: (key: string) => string) => Instr[];

/** Semantic patch per environment; `build` gets a variation key → ID resolver */
async function target(
  proj: string,
  cfg: string,
  perEnv: Record<string, Builder>,
) {
  const ids = await variationIds(proj, cfg);
  const id = (k: string) => {
    const v = ids.get(k);
    if (!v) throw new Error(`${cfg}: no variation ${k}`);
    return v;
  };
  for (const [environmentKey, build] of Object.entries(perEnv)) {
    must(
      await api(
        "PATCH",
        `${base(proj)}/${cfg}/targeting`,
        { environmentKey, instructions: build(id) },
        true,
      ),
      `targeting ${cfg}/${environmentKey}`,
    );
  }
}

const serve = (key: string): Builder => (id) => [{
  kind: "updateFallthroughVariationOrRollout",
  variationId: id(key),
}];
const allEnvs = (b: Builder) => Object.fromEntries(ENVS.map((e) => [e, b]));
const userIn = (values: string[]) => [{
  attribute: "key",
  op: "in",
  values,
  contextKind: "user",
  negate: false,
}];

interface Case {
  key: string;
  setup: () => Promise<void>;
  mutate: () => Promise<void>;
  /** Variations the source deleted: expected to stay in the destination and be reported */
  destOnly?: string[];
  /** The migration cannot apply the change and must report it: text expected in the migrate log */
  expectedError?: string;
}

const k = (s: string) => `${PREFIX}${s}`;

const CASES: Case[] = [
  {
    // radio-inbound-qa-judge-audit: a variation is added and qa's default rule moves to it
    key: k("add-variation"),
    setup: async () => {
      await createConfig(SOURCE, k("add-variation"), "completion", [
        completion("a"),
        completion("b"),
      ]);
      await target(SOURCE, k("add-variation"), allEnvs(serve("a")));
    },
    mutate: async () => {
      await addVariation(SOURCE, k("add-variation"), completion("c"));
      await target(SOURCE, k("add-variation"), { qa: serve("c") });
    },
  },
  {
    // resolve-product-types: the variation every default rule serves changes content
    key: k("edit-served"),
    setup: async () => {
      await createConfig(SOURCE, k("edit-served"), "completion", [
        completion("main"),
        completion("alt"),
      ]);
      await target(SOURCE, k("edit-served"), allEnvs(serve("main")));
    },
    mutate: () =>
      patchVariation(SOURCE, k("edit-served"), "main", {
        messages: [
          { role: "system", content: "You are main, version 2." },
          { role: "user", content: "{{question}}" },
        ],
        model: { parameters: { temperature: 0.7, maxTokens: 512 } },
      }),
  },
  {
    // anet-spoken-language-names: a variation is renamed (its key is unchanged)
    key: k("rename"),
    setup: async () => {
      await createConfig(SOURCE, k("rename"), "completion", [
        completion("en", "english"),
        completion("pl", "polish inflected"),
      ]);
      await target(SOURCE, k("rename"), { production: serve("en") });
    },
    mutate: async () => {
      await patchVariation(SOURCE, k("rename"), "pl", { name: "test" });
      await target(SOURCE, k("rename"), { production: serve("pl") });
    },
  },
  {
    // conv-ai-agent-llm-model: stage/qa/test serve m1 (default rule) and stage targets it; the source
    // moves them to m3 and deletes m1. qa also has a rule on m2.
    key: k("delete-variation"),
    destOnly: ["m1"],
    setup: async () => {
      const cfg = k("delete-variation");
      await createConfig(
        SOURCE,
        cfg,
        "completion",
        ["m0", "m1", "m2", "m3"].map((v) => completion(v)),
      );
      await target(SOURCE, cfg, {
        stage: (id) => [
          ...serve("m1")(id),
          {
            kind: "replaceTargets",
            targets: [{
              variationId: id("m1"),
              values: ["u-stage"],
              contextKind: "user",
            }],
          },
        ],
        qa: (id) => [
          ...serve("m1")(id),
          {
            kind: "replaceRules",
            rules: [{ clauses: userIn(["u-qa"]), variationId: id("m2") }],
          },
        ],
        test: serve("m1"),
      });
    },
    mutate: async () => {
      const cfg = k("delete-variation");
      await target(SOURCE, cfg, {
        stage: (id) => [
          ...serve("m3")(id),
          {
            kind: "replaceTargets",
            targets: [{
              variationId: id("m3"),
              values: ["u-stage"],
              contextKind: "user",
            }],
          },
        ],
        qa: serve("m3"),
        test: serve("m3"),
      });
      must(
        await api("DELETE", `${base(SOURCE)}/${cfg}/variations/m1`),
        `delete ${cfg}/m1`,
      );
    },
  },
  {
    // A variation nothing serves is archived
    key: k("archive"),
    setup: async () => {
      await createConfig(SOURCE, k("archive"), "completion", [
        completion("p"),
        completion("q"),
      ]);
      await target(SOURCE, k("archive"), allEnvs(serve("p")));
    },
    mutate: () =>
      patchVariation(SOURCE, k("archive"), "q", { state: "archived" }),
  },
  {
    // Custom model configs: the first sync creates one, the second a new one a new variation uses
    key: k("custom-model"),
    setup: async () => {
      await createModel(SOURCE, `${MODEL_PREFIX}a`);
      await createConfig(SOURCE, k("custom-model"), "completion", [
        completion("on-a", "on-a", { modelConfigKey: `${MODEL_PREFIX}a` }),
      ]);
      await target(SOURCE, k("custom-model"), { production: serve("on-a") });
    },
    mutate: async () => {
      await createModel(SOURCE, `${MODEL_PREFIX}b`);
      await addVariation(
        SOURCE,
        k("custom-model"),
        completion("on-b", "on-b", { modelConfigKey: `${MODEL_PREFIX}b` }),
      );
      await target(SOURCE, k("custom-model"), { production: serve("on-b") });
    },
  },
  {
    // Agent mode: instructions instead of messages
    key: k("agent-mode"),
    setup: async () => {
      await createConfig(SOURCE, k("agent-mode"), "agent", [{
        key: "agent-v1",
        name: "agent v1",
        instructions: "Answer in one sentence.",
        modelConfigKey: BUILT_IN_MODEL,
      }]);
      await target(SOURCE, k("agent-mode"), allEnvs(serve("agent-v1")));
    },
    mutate: () =>
      patchVariation(SOURCE, k("agent-mode"), "agent-v1", {
        instructions: "Answer in two sentences, citing the source.",
      }),
  },
  {
    // Rules, a percentage rollout, individual targets, an off variation, and targeting off in dev
    key: k("targeting"),
    setup: async () => {
      const cfg = k("targeting");
      await createConfig(
        SOURCE,
        cfg,
        "completion",
        ["r1", "r2", "r3"].map((v) => completion(v)),
      );
      await target(SOURCE, cfg, {
        production: (id) => [
          {
            kind: "replaceRules",
            rules: [{ clauses: userIn(["u1"]), variationId: id("r2") }],
          },
          {
            kind: "replaceTargets",
            targets: [{
              variationId: id("r3"),
              values: ["u-t"],
              contextKind: "user",
            }],
          },
          {
            kind: "updateFallthroughVariationOrRollout",
            rolloutWeights: { [id("r1")]: 50000, [id("r3")]: 50000 },
          },
          { kind: "updateOffVariation", variationId: id("disabled") },
        ],
        dev: (id) => [...serve("r2")(id), { kind: "disableTargeting" }],
      });
    },
    mutate: async () => {
      const cfg = k("targeting");
      await target(SOURCE, cfg, {
        production: (id) => [
          {
            kind: "replaceRules",
            rules: [
              { clauses: userIn(["u1", "u2"]), variationId: id("r3") },
              {
                clauses: userIn(["u9"]),
                rolloutWeights: { [id("r1")]: 25000, [id("r2")]: 75000 },
              },
            ],
          },
          { kind: "updateOffVariation", variationId: id("r1") },
        ],
        qa: (id) => [{
          kind: "updateFallthroughVariationOrRollout",
          rolloutWeights: { [id("r2")]: 10000, [id("r3")]: 90000 },
        }],
        dev: () => [{ kind: "enableTargeting" }],
      });
    },
  },
  {
    // saml-callback-login-binding: the source config is deleted and re-created in another mode
    key: k("mode-change"),
    expectedError:
      `✗ ${PREFIX}mode-change: mode changed (completion → agent); an AI Config's mode cannot be changed, so its variations and targeting were not migrated. To fix: delete ${DEST}/${PREFIX}mode-change and re-run the migration`,
    setup: async () => {
      await createConfig(SOURCE, k("mode-change"), "completion", [
        completion("legacy"),
      ]);
      await target(SOURCE, k("mode-change"), allEnvs(serve("legacy")));
    },
    mutate: async () => {
      must(
        await api("DELETE", `${base(SOURCE)}/${k("mode-change")}`),
        "delete mode-change",
      );
      await createConfig(SOURCE, k("mode-change"), "agent", [{
        key: "agent",
        name: "agent",
        instructions: "Be brief.",
        modelConfigKey: BUILT_IN_MODEL,
      }]);
      await target(SOURCE, k("mode-change"), allEnvs(serve("agent")));
    },
  },
];

async function createModel(proj: string, key: string) {
  must(
    await api("POST", `${base(proj)}/model-configs`, {
      key,
      name: key,
      id: "anthropic.claude-haiku-4-5-20251001-v1:0",
      provider: "Anthropic",
      params: {},
    }),
    `create model ${key}`,
  );
}

async function listConfigs(proj: string): Promise<string[]> {
  const keys: string[] = [];
  for (let offset = 0;; offset += 50) {
    const r = await api("GET", `${base(proj)}?limit=50&offset=${offset}`);
    if (r.status === 404) return keys;
    must(r, `list ${proj}`);
    keys.push(...(r.json.items ?? []).map((c: any) => c.key));
    if ((r.json.items ?? []).length < 50) return keys;
  }
}

const getConfig = async (proj: string, key: string) => {
  const r = await api("GET", `${base(proj)}/${key}`);
  return r.status === 200 ? r.json : null;
};

// Variation content that must match, keyed by variation key
function describeVariations(cfg: any) {
  return Object.fromEntries(
    (cfg.variations ?? []).map((v: any) => [v.key, {
      name: v.name,
      state: v.state ?? "published",
      modelConfigKey: v.modelConfigKey,
      messages: v.messages ?? null,
      instructions: v.instructions ?? null,
      parameters: v.model?.parameters ?? {},
    }]),
  );
}

// What each environment serves, by variation key, from the config's backing flag
async function describeTargeting(proj: string, key: string) {
  const r = await api("GET", `flags/${proj}/${key}?env=*`);
  must(r, `read backing flag ${proj}/${key}`);
  const keys = (r.json.variations ?? []).map((v: any) =>
    resolveVariationKey(v)
  );
  const serve = (s: any) =>
    s?.rollout
      ? Object.fromEntries(
        s.rollout.variations.filter((v: any) => v.weight > 0).map((
          v: any,
        ) => [keys[v.variation], v.weight]),
      )
      : keys[s?.variation];
  const targets = (cfg: any) => {
    const seen = new Set<string>();
    for (const t of [...(cfg.targets ?? []), ...(cfg.contextTargets ?? [])]) {
      if (!t.values?.length) continue;
      seen.add(
        JSON.stringify([
          keys[t.variation],
          t.contextKind ?? "user",
          [...t.values].sort(),
        ]),
      );
    }
    return [...seen].sort();
  };
  return Object.fromEntries(
    Object.keys(r.json.environments ?? {}).sort().map((e) => {
      const cfg = r.json.environments[e];
      return [e, {
        on: cfg.on,
        fallthrough: serve(cfg.fallthrough),
        off: cfg.offVariation == null ? null : keys[cfg.offVariation],
        rules: (cfg.rules ?? []).map((rule: any) => ({
          clauses: rule.clauses.map((c: any) => [c.attribute, c.op, c.values]),
          serve: serve(rule),
        })),
        targets: targets(cfg),
      }];
    }),
  );
}

switch (command) {
  case "reset": {
    for (const proj of [SOURCE, DEST]) {
      for (
        const key of (await listConfigs(proj)).filter((c) =>
          c.startsWith(PREFIX)
        )
      ) {
        must(await api("DELETE", `${base(proj)}/${key}`), `delete ${key}`);
        console.log(`deleted ${proj}/${key}`);
      }
      const models = await api("GET", `${base(proj)}/model-configs`);
      for (
        const m of (Array.isArray(models.json) ? models.json : []).filter((
          m: any,
        ) => String(m.key).startsWith(MODEL_PREFIX))
      ) {
        must(
          await api("DELETE", `${base(proj)}/model-configs/${m.key}`),
          `delete model ${m.key}`,
        );
        console.log(`deleted ${proj}/model ${m.key}`);
      }
    }
    break;
  }
  case "setup": {
    for (const c of CASES) {
      await c.setup();
      console.log(`created ${SOURCE}/${c.key}`);
    }
    break;
  }
  case "mutate": {
    const start = args.from ? CASES.findIndex((c) => c.key === args.from) : 0;
    if (start < 0) throw new Error(`no case ${args.from}`);
    for (const c of CASES.slice(start)) {
      await c.mutate();
      console.log(`changed ${SOURCE}/${c.key}`);
    }
    break;
  }
  case "verify": {
    const log = args.log ? stripColor(await Deno.readTextFile(args.log)) : "";
    const caseByKey = new Map(CASES.map((c) => [c.key, c]));
    const sourceKeys = await listConfigs(SOURCE);
    let failures = 0;
    for (const key of sourceKeys) {
      const c = caseByKey.get(key);
      const [s, d] = [await getConfig(SOURCE, key), await getConfig(DEST, key)];
      if (!s || !d) {
        console.log(`✗ ${key}: missing in ${s ? DEST : SOURCE}`);
        failures++;
        continue;
      }
      const problems: string[] = [];
      if (s.mode !== d.mode) {
        problems.push(`mode: source ${s.mode} ≠ destination ${d.mode}`);
      }
      const [sv, dv] = [describeVariations(s), describeVariations(d)];
      for (const [vk, want] of Object.entries(sv)) {
        if (JSON.stringify(want) !== JSON.stringify(dv[vk])) {
          problems.push(
            `variation ${vk}: source ${JSON.stringify(want)} ≠ destination ${
              JSON.stringify(dv[vk] ?? null)
            }`,
          );
        }
      }
      const destOnly = Object.keys(dv).filter((vk) => !(vk in sv));
      const expectedDestOnly = c?.destOnly ?? [];
      for (const vk of destOnly) {
        if (!expectedDestOnly.includes(vk)) {
          problems.push(`variation ${vk} exists only in the destination`);
        } else if (
          args.log &&
          !log.includes(`${key}/${vk}: exists only in the destination`)
        ) {
          problems.push(
            `destination-only variation ${vk} was not reported in ${args.log}`,
          );
        }
      }
      for (
        const m of new Set(Object.values(sv).map((v: any) => v.modelConfigKey))
      ) {
        if (
          String(m).startsWith(MODEL_PREFIX) &&
          (await api("GET", `${base(DEST)}/model-configs/${m}`)).status !== 200
        ) problems.push(`model config ${m} is missing in the destination`);
      }
      const [st, dt] = [
        await describeTargeting(SOURCE, key),
        await describeTargeting(DEST, key),
      ];
      for (const e of Object.keys(st)) {
        if (JSON.stringify(st[e]) !== JSON.stringify(dt[e])) {
          problems.push(
            `${e}: source ${JSON.stringify(st[e])} ≠ destination ${
              JSON.stringify(dt[e] ?? null)
            }`,
          );
        }
      }
      const kept = destOnly.length
        ? ` (${destOnly.join(", ")} kept in the destination, as expected)`
        : "";
      if (problems.length === 0) {
        console.log(`✓ ${key}: matches by variation key${kept}`);
      } else if (c?.expectedError) {
        const reported = log.includes(c.expectedError);
        if (!reported) failures++;
        console.log(
          `${reported ? "✓" : "✗"} ${key}: differs as expected; ${
            args.log
              ? reported
                ? "an error for it is in the migrate log"
                : `no error for it in ${args.log}`
              : "pass --log <migrate log> to check that it was reported"
          }`,
        );
        for (const p of problems) console.log(`    ${p}`);
      } else {
        failures++;
        console.log(`✗ ${key}`);
        for (const p of problems) console.log(`    ${p}`);
      }
    }
    console.log(
      failures ? `\n${failures} AI Config(s) differ` : "\nall AI Configs match",
    );
    if (failures) Deno.exit(1);
    break;
  }
  default:
    console.log("commands: reset | setup | mutate | verify");
    Deno.exit(1);
}
