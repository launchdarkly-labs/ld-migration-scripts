// End-to-end check of flag variation sync against a real LaunchDarkly account.
//
// Creates `vfix-*` flags in a source project in their "before" state, then (after a migration) changes
// them to their "after" state the way the LaunchDarkly UI would, so an incremental migration has to
// carry variation edits, additions, removals, a value swap and a kind change to the destination.
// `verify` compares source and destination by value (environments reference variations by index,
// so comparing indexes alone would hide a mismatch) and counts destination variations that kept their ID.
//
// Usage (reads config/api_keys.json):
//   deno run -A scripts/e2e/variation_sync_e2e.ts <command> --domain <d> --source <proj> --dest <proj>
// Commands: reset | setup | snapshot | mutate [--from <key>] | verify [--log <migrate log>] [--only <key,...>] | probe
// After the post-mutate migration (vfix-shrink keeps 12 variations), a migration limited to
// `--include-flags vfix-prereq-dependent` must keep its prerequisite on the same value:
// check it with `verify --only vfix-prereq-dependent`.
// Only flags whose key starts with `vfix-` are ever created, changed or deleted.

import { stripColor } from "https://deno.land/std@0.149.0/fmt/colors.ts";

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
const PREFIX = "vfix-";
const SNAPSHOT =
  `./data/launchdarkly-migrations/e2e-variation-snapshot-${DEST}.json`;
const KEY = JSON.parse(await Deno.readTextFile("config/api_keys.json"))
  .source_account_api_key as string;

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  for (let attempt = 0;; attempt++) {
    let res: Response;
    let text: string;
    try {
      res = await fetch(`https://${DOMAIN}/api/v2/${path}`, {
        method,
        headers: {
          Authorization: KEY,
          "Content-Type": "application/json",
          "LD-API-Version": "20240415",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      text = await res.text();
    } catch (err) {
      // A dropped connection: only reads are safe to repeat
      if (method !== "GET" || attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
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

const patchFlag = async (
  proj: string,
  key: string,
  ops: unknown[],
  what: string,
) => must(await api("PATCH", `flags/${proj}/${key}`, ops), `${what} (${key})`);

const env = (e: string, field: string, value: unknown) => ({
  op: "replace",
  path: `/environments/${e}/${field}`,
  value,
});
const userRule = (users: string[], serve: Record<string, unknown>) => ({
  clauses: [{
    attribute: "key",
    op: "in",
    values: users,
    contextKind: "user",
    negate: false,
  }],
  ...serve,
});

interface Case {
  key: string;
  variations: Array<{ value: unknown; name?: string }>;
  defaults: { onVariation: number; offVariation: number };
  envs: unknown[]; // JSON patch ops applied after create
  mutate: (key: string) => Promise<void>;
  /** The migration cannot apply this change and must report it: text expected in the migrate log */
  expectedError?: string;
  /** With expectedError: the only fields allowed to differ (default: any) */
  allowedDiffs?: string[];
}

const strings = (vals: string[]) => vals.map((v) => ({ value: v, name: v }));

// conv-ai-agent-llm-model: 12 → 10. The removed variations were the stage/qa/test default rule (qa has
// no off variation, as in the PDF's second message), a stage individual target and dev's off variation.
// With `dependent`, that flag has a prerequisite on this one: LaunchDarkly refuses to remove variations
// of a flag used as a prerequisite, so the source drops the prerequisite, removes the variations and
// restores it (model-9 is now at 7); the migration must report the same refusal in the destination.
function shrinkCase(
  key: string,
  valueOf: (i: number) => unknown,
  editedValue: unknown,
  dependent?: string,
): Case {
  const prereq = (variation?: number) =>
    patchFlag(SOURCE, dependent!, [
      variation === undefined
        ? { op: "remove", path: "/environments/production/prerequisites/0" }
        : env("production", "prerequisites", [{ key, variation }]),
    ], `prerequisite of ${dependent}`);
  return {
    key,
    ...(dependent && {
      expectedError:
        `To finish: in project ${DEST}, remove the prerequisite on ${key} from ${dependent} (and any destination-only flags that use it), then re-run without --incremental with --include-flags ${key},${dependent}`,
      allowedDiffs: ["variations"],
    }),
    variations: Array.from({ length: 12 }, (_, i) => ({
      value: valueOf(i),
      name: `model-${i}`,
    })),
    defaults: { onVariation: 7, offVariation: 0 },
    envs: [
      ...["stage", "qa", "test"].flatMap((e) => [
        env(e, "on", true),
        env(e, "fallthrough", { variation: 7 }),
      ]),
      env("qa", "rules", [userRule(["u-qa"], { variation: 9 })]),
      { op: "remove", path: "/environments/qa/offVariation" },
      env("stage", "targets", [{
        variation: 8,
        values: ["u-stage"],
        contextKind: "user",
      }]),
      env("dev", "offVariation", 11),
    ],
    mutate: async (k) => {
      await patchFlag(SOURCE, k, [
        { op: "replace", path: "/variations/11/value", value: editedValue },
        { op: "replace", path: "/variations/11/name", value: "caching" },
      ], "edit model-11");
      await patchFlag(SOURCE, k, [
        ...["stage", "qa", "test"].map((e) =>
          env(e, "fallthrough", { variation: 11 })
        ),
        env("stage", "targets", [{
          variation: 9,
          values: ["u-stage"],
          contextKind: "user",
        }]),
        env("dev", "offVariation", 0),
        {
          op: "replace",
          path: "/defaults",
          value: { onVariation: 11, offVariation: 0 },
        },
      ], "repoint away from model-7/8");
      if (dependent) await prereq();
      // Removing a variation does not renumber `defaults`, and a patch cannot change variations and
      // environments together: move the defaults in the same patch (caching 11 → 9)
      await patchFlag(SOURCE, k, [
        { op: "remove", path: "/variations/8" },
        { op: "remove", path: "/variations/7" },
        {
          op: "replace",
          path: "/defaults",
          value: { onVariation: 9, offVariation: 0 },
        },
      ], "remove model-7/8");
      if (dependent) await prereq(7);
    },
  };
}

const CASES: Case[] = [
  {
    // radio-inbound-qa-judge-audit: only adds a variation, still rejected by the old whole-list replace
    key: `${PREFIX}add-only`,
    variations: strings(["off", "1%", "5%"]),
    defaults: { onVariation: 1, offVariation: 0 },
    envs: [
      env("qa", "on", true),
      env("qa", "fallthrough", { variation: 1 }),
      env("production", "on", true),
      env("production", "fallthrough", { variation: 2 }),
    ],
    mutate: async (k) => {
      await patchFlag(SOURCE, k, [{
        op: "add",
        path: "/variations/-",
        value: { value: "2% of correct cards", name: "2% of correct cards" },
      }], "add variation");
      await patchFlag(
        SOURCE,
        k,
        [env("qa", "fallthrough", { variation: 3 })],
        "repoint qa",
      );
    },
  },
  {
    // resolve-product-types: same count, the variation every default uses changes value
    key: `${PREFIX}same-count-value`,
    variations: [{ value: { types: ["a"] }, name: "Default" }, {
      value: { types: [] },
      name: "None",
    }],
    defaults: { onVariation: 0, offVariation: 1 },
    envs: ["uat", "stage", "dev", "qa", "test", "production"].flatMap((e) => [
      env(e, "on", true),
      env(e, "fallthrough", { variation: 0 }),
    ]),
    mutate: (k) =>
      patchFlag(SOURCE, k, [{
        op: "replace",
        path: "/variations/0/value",
        value: { types: ["a", "b"] },
      }], "edit value"),
  },
  {
    // anet-spoken-language-names: an unreferenced variation is renamed and given a new value
    key: `${PREFIX}rename`,
    variations: [{ value: "en", name: "english" }, {
      value: "pl",
      name: "polish inflected",
    }],
    defaults: { onVariation: 0, offVariation: 0 },
    envs: [
      env("production", "on", true),
      env("production", "fallthrough", { variation: 0 }),
    ],
    mutate: async (k) => {
      await patchFlag(SOURCE, k, [
        { op: "replace", path: "/variations/1/value", value: "test" },
        { op: "replace", path: "/variations/1/name", value: "test" },
      ], "rename");
      await patchFlag(SOURCE, k, [
        env("production", "fallthrough", { variation: 1 }),
      ], "repoint production");
    },
  },
  {
    // uncad-boundary-release: a used variation changes, three are added, environments use the new ones
    key: `${PREFIX}grow-edit`,
    variations: strings(["off", "on", "dev-v1"]),
    defaults: { onVariation: 1, offVariation: 0 },
    envs: [
      env("dev", "on", true),
      env("dev", "fallthrough", { variation: 2 }),
      env("test", "on", true),
      env("test", "fallthrough", { variation: 2 }),
    ],
    mutate: async (k) => {
      await patchFlag(SOURCE, k, [
        { op: "replace", path: "/variations/2/value", value: "dev-v2" },
        { op: "replace", path: "/variations/2/name", value: "dev-v2" },
        ...["stage-1", "stage-2", "stage-4"].map((v) => ({
          op: "add",
          path: "/variations/-",
          value: { value: v, name: v },
        })),
      ], "edit and add");
      await patchFlag(SOURCE, k, [
        env("stage", "on", true),
        env("stage", "fallthrough", { variation: 3 }),
        env("qa", "on", true),
        env("qa", "fallthrough", { variation: 4 }),
        env("production", "on", true),
        env("production", "fallthrough", {
          rollout: {
            variations: [{ variation: 0, weight: 50000 }, {
              variation: 5,
              weight: 50000,
            }],
          },
        }),
      ], "use new variations");
    },
  },
  shrinkCase(
    `${PREFIX}shrink`,
    (i) => `model-${i}`,
    "caching",
    `${PREFIX}prereq-dependent`,
  ),
  shrinkCase(
    `${PREFIX}shrink-json`,
    (i) => ({ provider: "vertex", model: `sonnet-${i}`, gateway: i % 2 === 0 }),
    { provider: "vertex", model: "sonnet-caching", gateway: true },
  ),
  {
    // A flag whose prerequisite is vfix-shrink's model-9, which moves from position 9 to 7
    key: `${PREFIX}prereq-dependent`,
    variations: strings(["off", "on"]),
    defaults: { onVariation: 1, offVariation: 0 },
    envs: [
      env("production", "on", true),
      env("production", "fallthrough", { variation: 1 }),
      env("production", "prerequisites", [{
        key: `${PREFIX}shrink`,
        variation: 9,
      }]),
    ],
    mutate: async () => {},
  },
  {
    // radio-inbound-qa-config: same count, three values change, names stay
    key: `${PREFIX}same-count-edits`,
    variations: [
      "Detect + Persist (UI off)",
      "Detect only",
      "Detect + Persist + UI",
      "Off",
      "Detect + Persist + UI (from 2026-10-01 4pm ET)",
    ].map((name, i) => ({ value: `mode-${i}-v1`, name })),
    defaults: { onVariation: 0, offVariation: 3 },
    envs: ["stage", "qa", "test", "production"].flatMap((e) => [
      env(e, "on", true),
      env(e, "fallthrough", { variation: 0 }),
    ]),
    mutate: (k) =>
      patchFlag(
        SOURCE,
        k,
        [0, 2, 4].map((i) => ({
          op: "replace",
          path: `/variations/${i}/value`,
          value: `mode-${i}-v2`,
        })),
        "edit values",
      ),
  },
  {
    // Two variations swap values: the in-place edits briefly duplicate a value
    key: `${PREFIX}swap`,
    variations: strings(["a", "b"]),
    defaults: { onVariation: 0, offVariation: 1 },
    envs: [
      env("production", "on", true),
      env("production", "fallthrough", { variation: 0 }),
    ],
    mutate: async (k) => {
      await patchFlag(SOURCE, k, [
        { op: "replace", path: "/variations/0/value", value: "b" },
        { op: "replace", path: "/variations/0/name", value: "b" },
        { op: "replace", path: "/variations/1/value", value: "a" },
        { op: "replace", path: "/variations/1/name", value: "a" },
      ], "swap");
      await patchFlag(SOURCE, k, [
        env("production", "fallthrough", { variation: 1 }),
      ], "keep serving a");
    },
  },
  {
    // saml-callback-login-binding: boolean in the destination, re-created as a string flag in the source
    key: `${PREFIX}kind-change`,
    expectedError:
      `✗ ${PREFIX}kind-change: flag kind changed (boolean → multivariate); LaunchDarkly cannot change a flag's kind, so the destination flag must be deleted and re-created. To fix: delete ${PREFIX}kind-change in project ${DEST}, then re-run with --include-flags ${PREFIX}kind-change`,
    variations: [{ value: true }, { value: false }],
    defaults: { onVariation: 0, offVariation: 1 },
    envs: [
      env("production", "on", true),
      env("production", "fallthrough", { variation: 1 }),
    ],
    mutate: async (k) => {
      must(await api("DELETE", `flags/${SOURCE}/${k}`), `delete ${k}`);
      must(
        await api("POST", `flags/${SOURCE}`, {
          key: k,
          name: k,
          variations: strings(["off", "observe", "enforce"]),
          defaults: { onVariation: 1, offVariation: 0 },
        }),
        `re-create ${k}`,
      );
    },
  },
];

async function createCase(proj: string, c: Case) {
  must(
    await api("POST", `flags/${proj}`, {
      key: c.key,
      name: c.key,
      variations: c.variations,
      defaults: c.defaults,
    }),
    `create ${c.key}`,
  );
  if (c.envs.length) await patchFlag(proj, c.key, c.envs, "set environments");
}

async function prefixedFlags(proj: string): Promise<string[]> {
  const keys: string[] = [];
  for (const filter of ["", "&filter=state:archived"]) {
    const r = await api("GET", `flags/${proj}?summary=true&limit=100${filter}`);
    if (r.status === 404) return [];
    must(r, `list ${proj}`);
    keys.push(...r.json.items.map((f: any) => f.key));
  }
  return [...new Set(keys)].filter((k) => k.startsWith(PREFIX));
}

const getFlag = async (proj: string, key: string) => {
  const r = await api("GET", `flags/${proj}/${key}?env=*`);
  return r.status === 200 ? r.json : null;
};

// What an environment serves, by variation value. Prerequisites resolve to the value of the
// prerequisite flag's variation in the same project (prereqValues: "key/index" → value).
function served(flag: any, e: string, prereqValues: Map<string, unknown>) {
  const vals = flag.variations.map((v: any) => v.value);
  const cfg = flag.environments?.[e];
  if (!cfg) return undefined;
  const targets = (list: any[] | undefined) =>
    (list ?? []).filter((t) => t.values?.length).map((t: any) => [
      vals[t.variation],
      t.contextKind ?? "user",
      [...t.values].sort(),
    ]);
  const serve = (s: any) =>
    s?.rollout
      ? {
        rollout: s.rollout.variations.map((
          rv: any,
        ) => [vals[rv.variation], rv.weight]),
      }
      : vals[s?.variation];
  return {
    on: cfg.on,
    fallthrough: serve(cfg.fallthrough),
    off: cfg.offVariation === undefined ? null : vals[cfg.offVariation],
    rules: (cfg.rules ?? []).map((r: any) => ({
      clauses: r.clauses.map((c: any) => [c.attribute, c.op, c.values]),
      serve: serve(r),
    })),
    targets: targets(cfg.targets),
    contextTargets: targets(cfg.contextTargets),
    prerequisites: (cfg.prerequisites ?? []).map((p: any) => [
      p.key,
      prereqValues.get(`${p.key}/${p.variation}`),
    ]),
  };
}

async function prerequisiteValues(proj: string, flag: any) {
  const out = new Map<string, unknown>();
  for (const cfg of Object.values(flag.environments ?? {}) as any[]) {
    for (const p of cfg.prerequisites ?? []) {
      const f = await getFlag(proj, p.key);
      out.set(`${p.key}/${p.variation}`, f?.variations?.[p.variation]?.value);
    }
  }
  return out;
}

const describe = (flag: any, prereqValues: Map<string, unknown>) => ({
  kind: flag.kind,
  variations: flag.variations.map((v: any) => [v.value, v.name ?? null]),
  defaults: [
    flag.variations[flag.defaults.onVariation]?.value,
    flag.variations[flag.defaults.offVariation]?.value,
  ],
  envs: Object.fromEntries(
    Object.keys(flag.environments ?? {}).sort().map((
      e,
    ) => [e, served(flag, e, prereqValues)]),
  ),
});

switch (command) {
  case "reset": {
    for (const proj of [SOURCE, DEST]) {
      // A flag used as a prerequisite cannot be deleted first: retry what failed once the rest is gone
      let pending = await prefixedFlags(proj);
      for (let round = 0; pending.length > 0; round++) {
        const failed: string[] = [];
        for (const k of pending) {
          const r = await api("DELETE", `flags/${proj}/${k}`);
          if (r.status >= 200 && r.status < 300) {
            console.log(`deleted ${proj}/${k}`);
          } else if (round < 3) failed.push(k);
          else must(r, `delete ${proj}/${k}`);
        }
        pending = failed;
      }
    }
    for (
      const f of [
        `./data/launchdarkly-migrations/sync-manifest-${SOURCE}-${DEST}.json`,
        SNAPSHOT,
      ]
    ) await Deno.remove(f).catch(() => {});
    break;
  }
  case "setup": {
    for (const c of CASES) {
      await createCase(SOURCE, c);
      console.log(`created ${SOURCE}/${c.key}`);
    }
    break;
  }
  case "snapshot": {
    const ids: Record<string, string[]> = {};
    for (const c of CASES) {
      const f = await getFlag(DEST, c.key);
      if (!f) throw new Error(`${DEST}/${c.key} not found`);
      ids[c.key] = f.variations.map((v: any) => v._id);
    }
    await Deno.writeTextFile(SNAPSHOT, JSON.stringify(ids, null, 2));
    console.log(`destination variation IDs saved to ${SNAPSHOT}`);
    break;
  }
  case "mutate": {
    // --from <key> resumes at that case (earlier cases were already changed)
    const start = args.from ? CASES.findIndex((c) => c.key === args.from) : 0;
    if (start < 0) throw new Error(`no case ${args.from}`);
    for (const c of CASES.slice(start)) {
      await c.mutate(c.key);
      console.log(`changed ${SOURCE}/${c.key}`);
    }
    break;
  }
  case "verify": {
    const before: Record<string, string[]> = JSON.parse(
      await Deno.readTextFile(SNAPSHOT).catch(() => "{}"),
    );
    // --only <key,...>: check just these cases (a migration run limited with --include-flags)
    const only = args.only ? new Set(String(args.only).split(",")) : undefined;
    const log = args.log
      ? stripColor(
        await Deno.readTextFile(args.log).catch(() => {
          console.log(`✗ migrate log ${args.log} could not be read`);
          Deno.exit(1);
        }),
      )
      : "";
    if (args.log && !log.includes("MIGRATION SUMMARY")) {
      console.log(
        `⚠ ${args.log} has no migration summary: the run may have been cut short`,
      );
    }
    let failures = 0;
    for (const c of CASES.filter((c) => !only || only.has(c.key))) {
      const [s, d] = [await getFlag(SOURCE, c.key), await getFlag(DEST, c.key)];
      if (!s || !d) {
        console.log(`✗ ${c.key}: missing in ${s ? DEST : SOURCE}`);
        failures++;
        continue;
      }
      const problems: string[] = [];
      const [ds, dd] = [
        describe(s, await prerequisiteValues(SOURCE, s)),
        describe(d, await prerequisiteValues(DEST, d)),
      ];
      for (const field of ["kind", "variations", "defaults"] as const) {
        if (JSON.stringify(ds[field]) !== JSON.stringify(dd[field])) {
          problems.push(
            `${field}: source ${JSON.stringify(ds[field])} ≠ destination ${
              JSON.stringify(dd[field])
            }`,
          );
        }
      }
      for (const e of Object.keys(ds.envs)) {
        if (JSON.stringify(ds.envs[e]) !== JSON.stringify(dd.envs[e])) {
          problems.push(
            `${e}: source ${JSON.stringify(ds.envs[e])} ≠ destination ${
              JSON.stringify(dd.envs[e])
            }`,
          );
        }
      }
      // Variations are matched by value, so a surviving variation may move; count IDs, not positions
      const destIds = new Set(d.variations.map((v: any) => v._id));
      const prev = before[c.key] ?? [];
      const kept = prev.filter((id) => destIds.has(id)).length;
      const idNote = before[c.key]
        ? `, ${kept}/${prev.length} destination variation IDs kept` +
          (prev.length > d.variations.length
            ? ` (${prev.length - d.variations.length} removed)`
            : "")
        : "";
      if (problems.length === 0) {
        console.log(`✓ ${c.key}: matches by value${idNote}`);
      } else if (c.expectedError) {
        // --log <migrate log>: the difference must have been reported with this message
        const reported = log.includes(c.expectedError);
        const unexpected = c.allowedDiffs
          ? problems.filter((p) =>
            !c.allowedDiffs!.some((f) => p.startsWith(`${f}:`))
          )
          : [];
        if (!reported || unexpected.length) failures++;
        for (const p of unexpected) console.log(`    unexpected: ${p}`);
        console.log(
          `${
            reported && !unexpected.length ? "✓" : "✗"
          } ${c.key}: differs as expected${
            c.allowedDiffs ? ` (${c.allowedDiffs.join(", ")} only)` : ""
          }; ${
            args.log
              ? reported
                ? "reported in the migrate log"
                : `expected message not found in ${args.log}: ${c.expectedError}`
              : "pass --log <migrate log> to check that it was reported"
          }`,
        );
      } else {
        failures++;
        console.log(`✗ ${c.key}${idNote}`);
        for (const p of problems) console.log(`    ${p}`);
      }
    }
    console.log(
      failures ? `\n${failures} flag(s) differ` : "\nall flags match",
    );
    if (failures) Deno.exit(1);
    break;
  }
  case "probe": {
    // Reproduce the old behavior on a scratch copy: replace the whole list without IDs
    const scratch = `${PREFIX}probe-old-replace`;
    await api("DELETE", `flags/${DEST}/${scratch}`);
    await createCase(DEST, { ...CASES[0], key: scratch });
    const r = await api("PATCH", `flags/${DEST}/${scratch}`, [
      {
        op: "replace",
        path: "/variations",
        value: strings(["off", "1%", "5%", "2% of correct cards"]),
      },
      {
        op: "replace",
        path: "/defaults",
        value: { onVariation: 1, offVariation: 0 },
      },
    ]);
    console.log(
      `old whole-list replace: HTTP ${r.status} ${r.text.slice(0, 300)}`,
    );

    const kindScratch = `${PREFIX}probe-kind`;
    await api("DELETE", `flags/${DEST}/${kindScratch}`);
    await createCase(DEST, { ...CASES[7], key: kindScratch });
    const k = await api("PATCH", `flags/${DEST}/${kindScratch}`, [
      { op: "replace", path: "/variations/0/value", value: "off" },
      { op: "replace", path: "/variations/1/value", value: "observe" },
      { op: "add", path: "/variations/-", value: { value: "enforce" } },
    ]);
    console.log(
      `boolean → string by patch: HTTP ${k.status} ${k.text.slice(0, 300)}`,
    );
    break;
  }
  default:
    console.log("commands: reset | setup | snapshot | mutate | verify | probe");
    Deno.exit(1);
}
