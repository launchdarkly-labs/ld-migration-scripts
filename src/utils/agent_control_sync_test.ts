// deno-lint-ignore-file require-await
// The mock HTTP client methods are async to satisfy the AgentControlHttpClient interface.
import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AgentControlConflictAction,
  type AgentControlHttpClient,
  type AgentControlResourceType,
  buildAgentControlPayload,
  defaultConflictAction,
  extractAgentControlResources,
  hashAgentControlInput,
  migrateAgentControlFromExtract,
  type MigrateAgentControlOptions,
  resolveAgentControlMaintainerId,
  stableStringify,
} from "./agent_control.ts";
import {
  cloneAgentControlManifest,
  type SyncManifestAgentControl,
} from "./sync_manifest.ts";

// ---------- pure helpers ----------

Deno.test("stableStringify ignores key order and undefined values", () => {
  assertEquals(
    stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }),
    stableStringify({ a: { c: undefined, d: [1, { y: 2, z: 1 }] }, b: 1 }),
  );
  assertNotEquals(
    stableStringify({ a: [1, 2] }),
    stableStringify({ a: [2, 1] }),
  );
});

Deno.test("hashAgentControlInput is stable and sensitive to content", async () => {
  const a = await hashAgentControlInput({ x: 1, y: [1, 2] });
  assertEquals(a, await hashAgentControlInput({ y: [1, 2], x: 1 }));
  assertEquals(a.length, 64);
  assertNotEquals(a, await hashAgentControlInput({ x: 2, y: [1, 2] }));
});

Deno.test("defaultConflictAction mirrors the flag default", () => {
  assertEquals(defaultConflictAction(undefined, undefined), "overwrite");
  assertEquals(defaultConflictAction(undefined, "mig-"), "prefix");
  assertEquals(defaultConflictAction("skip", "mig-"), "skip");
  assertEquals(defaultConflictAction("abort", undefined), "abort");
  // prompt is resolved by the caller; without a resolver it behaves as overwrite
  assertEquals(defaultConflictAction("prompt", undefined), "overwrite");
});

Deno.test("resolveAgentControlMaintainerId maps members only when asked to", () => {
  const source = { _maintainer: { _id: "src-member", email: "a@b.c" } };
  const mapping = { "src-member": "dest-member", "gone": null };
  assertEquals(
    resolveAgentControlMaintainerId(source, mapping, true),
    "dest-member",
  );
  assertEquals(
    resolveAgentControlMaintainerId(source, mapping, false),
    undefined,
  );
  assertEquals(resolveAgentControlMaintainerId(source, {}, true), undefined);
  assertEquals(
    resolveAgentControlMaintainerId({ maintainerId: "gone" }, mapping, true),
    undefined,
  );
  // team maintainers are not carried over
  assertEquals(
    resolveAgentControlMaintainerId(
      { _maintainer: { key: "team-a" } },
      mapping,
      true,
    ),
    undefined,
  );
});

Deno.test("buildAgentControlPayload applies key, name, tags and maintainer", () => {
  const payload = buildAgentControlPayload(
    {
      key: "cfg",
      name: "Cfg",
      tags: ["src"],
      _maintainer: { _id: "src-member" },
      _version: 3,
      maintainerTeamKey: "team-a",
    },
    {
      destKey: "mig-cfg",
      destName: "mig-Cfg",
      migrationTags: ["migrated"],
      existingTags: ["dest-only", "src"],
      maintainerMapping: { "src-member": "dest-member" },
      assignMaintainerIds: true,
    },
  );
  assertEquals(payload.key, "mig-cfg");
  assertEquals(payload.name, "mig-Cfg");
  assertEquals(
    [...(payload.tags as string[])].sort(),
    ["dest-only", "migrated", "src"],
  );
  assertEquals(payload.maintainerId, "dest-member");
  assertEquals(payload.maintainerTeamKey, undefined);
  assertEquals(payload._version, undefined);

  const bare = buildAgentControlPayload(
    { key: "cfg", name: "Cfg", _maintainer: { _id: "src-member" } },
    { destKey: "cfg" },
  );
  assertEquals(bare.tags, undefined);
  assertEquals(bare.maintainerId, undefined);
});

Deno.test("cloneAgentControlManifest tolerates old manifests and copies deeply", () => {
  const empty = cloneAgentControlManifest(undefined);
  assertEquals(Object.keys(empty.modelConfigs), []);
  assertEquals(Object.keys(empty.configs), []);
  assertEquals(Object.keys(cloneAgentControlManifest({}).configs), []);

  const source: SyncManifestAgentControl = {
    modelConfigs: { m: { hash: "h" } },
    configs: {
      c: {
        hash: "h",
        destKey: "mig-c",
        variations: { v: { hash: "hv" } },
        targeting: { production: { hash: "ht" } },
      },
    },
  };
  const copy = cloneAgentControlManifest(source);
  assertEquals(JSON.stringify(copy), JSON.stringify(source));
  copy.configs.c.variations.v.hash = "changed";
  assertEquals(source.configs.c.variations.v.hash, "hv");

  const proto = cloneAgentControlManifest(
    JSON.parse('{"modelConfigs":{"__proto__":{"hash":"x"}},"configs":{}}'),
  );
  assertEquals(Object.hasOwn(proto.modelConfigs, "__proto__"), true);
});

// ---------- migrateAgentControlFromExtract against a stateful mock ----------

const DEST = "dest";

interface MockWorldOptions {
  /** Response overrides keyed by `METHOD path` (`SEMANTIC path env` for targeting patches) */
  responses?: Record<string, { status: number; body?: string }>;
  /** The destination's model catalog (GET .../model-configs); absent: the list is not readable */
  destModels?: string[];
  /**
   * Serve GET .../targeting the way the API does: agent-style values with no `_ldMeta` wrapper, and IDs
   * that differ from the config detail's (which change when a variation is edited)
   */
  targetingResource?: boolean;
}

/**
 * An in-memory destination: existing resources keyed by their full GET path. A config's GET lists the
 * built-in "disabled" variation plus the variations stored under it, with their state.
 */
function mockWorld(
  existing: Record<string, Record<string, unknown>> = {},
  failPaths: string[] = [],
  options: MockWorldOptions = {},
) {
  const store = new Map(Object.entries(existing));
  const calls: string[] = [];
  const bodies: Record<string, Record<string, unknown>> = {};
  const semantic: Array<{ path: string; body: Record<string, unknown> }> = [];
  const override = (key: string) => options.responses?.[key];
  const variationsOf = (configPath: string) => [
    { key: "disabled", _id: "dest-disabled" },
    ...[...store.entries()]
      .filter(([p]) =>
        p.startsWith(`${configPath}/variations/`) &&
        !p.slice(`${configPath}/variations/`.length).includes("/")
      )
      .map(([p, v]) => {
        const key = p.slice(`${configPath}/variations/`.length);
        return {
          key,
          _id: `dest-${key}`,
          state: typeof v.state === "string" ? v.state : "published",
        };
      }),
  ];
  const client: AgentControlHttpClient = {
    async post(path, body) {
      calls.push(`POST ${path}`);
      if (failPaths.includes(path)) return { status: 500, body: "boom" };
      const o = override(`POST ${path}`);
      if (o) return o;
      const full = `${path}/${body.key}`;
      bodies[`POST ${full}`] = body;
      if (store.has(full)) return { status: 409 };
      store.set(full, body);
      return { status: 201 };
    },
    async patch(path, body) {
      calls.push(`PATCH ${path}`);
      if (failPaths.includes(path)) return { status: 500, body: "boom" };
      const o = override(`PATCH ${path}`);
      if (o) return o;
      bodies[`PATCH ${path}`] = body as Record<string, unknown>;
      store.set(path, { ...store.get(path), ...body });
      return { status: 200 };
    },
    async semanticPatch(path, body) {
      calls.push(`SEMANTIC ${path}`);
      semantic.push({ path, body });
      return override(`SEMANTIC ${path} ${body.environmentKey}`) ??
        { status: 200 };
    },
    async get(path) {
      calls.push(`GET ${path}`);
      if (path.startsWith(`projects/${DEST}/ai-configs/model-configs?`)) {
        return options.destModels
          ? { status: 200, json: options.destModels.map((key) => ({ key })) }
          : { status: 404 };
      }
      if (options.targetingResource && path.endsWith("/targeting")) {
        const configPath = path.slice(0, -"/targeting".length);
        if (!store.has(configPath)) return { status: 404 };
        return {
          status: 200,
          json: {
            variations: variationsOf(configPath)
              .filter((v) => !("state" in v) || v.state !== "archived")
              .map((v) => ({
                _id: `tgt-${v.key}`,
                name: v.key,
                value: v.key === "disabled"
                  ? { enabled: false }
                  : { enabled: true, variationKey: v.key },
              })),
          },
        };
      }
      const found = store.get(path);
      if (!found) return { status: 404 };
      return {
        status: 200,
        json: { ...found, variations: variationsOf(path) },
      };
    },
  };
  const writes = () => calls.filter((c) => !c.startsWith("GET "));
  return { client, calls, bodies, semantic, writes, store };
}

/** Model m1, config cfg-a (tagged, with a member maintainer), one variation, production targeting. */
async function withExtract(
  fn: (
    sourceKey: string,
    setVariationName: (name: string) => Promise<void>,
  ) => Promise<void>,
  model: Record<string, unknown> = { key: "m1", name: "M1" },
): Promise<void> {
  const sourceKey = `ac-sync-${crypto.randomUUID().slice(0, 8)}`;
  const sourceRoot =
    `./data/launchdarkly-migrations/source/project/${sourceKey}`;
  const aiRoot = `${sourceRoot}/ai-configs`;
  const writeVariation = async (name: string) => {
    await Deno.writeTextFile(
      `${aiRoot}/variations/cfg-a/var-1.json`,
      JSON.stringify({
        key: "var-1",
        name,
        value: { _ldMeta: { modelKey: "m1", variationKey: "var-1" } },
      }),
    );
  };
  try {
    await Deno.mkdir(`${aiRoot}/variations/cfg-a`, { recursive: true });
    await Deno.mkdir(`${aiRoot}/targeting`, { recursive: true });
    await Deno.writeTextFile(
      `${aiRoot}/model-configs.json`,
      JSON.stringify({ items: [model] }),
    );
    await Deno.writeTextFile(
      `${aiRoot}/configs.json`,
      JSON.stringify({
        items: [{
          key: "cfg-a",
          name: "Config A",
          tags: ["src"],
          _maintainer: { _id: "src-member" },
        }],
      }),
    );
    await writeVariation("v1");
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
              _ldMeta: { enabled: true, variationKey: "var-1", modelKey: "m1" },
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
    await fn(sourceKey, writeVariation);
  } finally {
    await Deno.remove(sourceRoot, { recursive: true }).catch(() => {});
  }
}

const run = (
  sourceKey: string,
  client: AgentControlHttpClient,
  extra: Partial<MigrateAgentControlOptions> = {},
) =>
  migrateAgentControlFromExtract({
    apiKey: "test",
    domain: "app.launchdarkly.com",
    sourceProjectKey: sourceKey,
    destProjectKey: DEST,
    dryRun: false,
    client,
    ...extra,
  });

Deno.test("a first run records hashes for every AgentControl resource", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld();
    const { summary, manifest } = await run(sourceKey, world.client);
    assertEquals(summary.created, 3); // model, config, variation; targeting is an update
    assertEquals(summary.updated, 1);
    assertEquals(summary.errors, 0);
    assert(manifest.modelConfigs.m1.hash);
    assert(manifest.configs["cfg-a"].hash);
    assert(manifest.configs["cfg-a"].variations["var-1"].hash);
    assert(manifest.configs["cfg-a"].targeting.production.hash);
    assertEquals(manifest.configs["cfg-a"].destKey, undefined);
    assert(
      world.calls.includes(
        `SEMANTIC projects/${DEST}/ai-configs/cfg-a/targeting`,
      ),
    );
  });
});

Deno.test("targeting is patched with the targeting resource's variation IDs, not the config detail's", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({}, [], { targetingResource: true });
    const result = await run(sourceKey, world.client);
    assertEquals(result.failures, []);
    const instructions = world.semantic[0].body.instructions as Array<
      Record<string, unknown>
    >;
    assertEquals(
      instructions.find((i) => i.kind === "updateFallthroughVariationOrRollout")
        ?.variationId,
      "tgt-var-1",
    );
    assertEquals(
      instructions.find((i) => i.kind === "updateOffVariation")?.variationId,
      "tgt-disabled",
    );
  });
});

Deno.test("--incremental skips unchanged resources and rewrites changed ones", async () => {
  await withExtract(async (sourceKey, setVariationName) => {
    const first = mockWorld();
    const { manifest } = await run(sourceKey, first.client);

    // Nothing changed: no request is a write
    const second = mockWorld(Object.fromEntries(first.store));
    const unchanged = await run(sourceKey, second.client, {
      incremental: true,
      previousManifest: manifest,
    });
    assertEquals(second.writes(), []);
    assertEquals(unchanged.summary.skipped, 4);
    assertEquals(unchanged.summary.created + unchanged.summary.updated, 0);
    assertEquals(unchanged.manifest, manifest);

    // One variation changed: only it is written (the targeting hash covers the targeting file, unchanged here)
    await setVariationName("renamed");
    const third = mockWorld(Object.fromEntries(first.store));
    const changed = await run(sourceKey, third.client, {
      incremental: true,
      previousManifest: manifest,
    });
    // POST, then PATCH on the 409 for the variation that already exists
    assertEquals(
      third.writes().filter((c) => c.includes("/variations")),
      [
        `POST projects/${DEST}/ai-configs/cfg-a/variations`,
        `PATCH projects/${DEST}/ai-configs/cfg-a/variations/var-1`,
      ],
    );
    assertEquals(
      third.writes().filter((c) => c === `POST projects/${DEST}/ai-configs`),
      [],
    );
    assertEquals(
      third.writes().filter((c) => c.endsWith("/model-configs")).length,
      0,
    );
    assertNotEquals(
      changed.manifest.configs["cfg-a"].variations["var-1"].hash,
      manifest.configs["cfg-a"].variations["var-1"].hash,
    );
  });
});

Deno.test("without --incremental a recorded copy is updated in place, never re-resolved", async () => {
  await withExtract(async (sourceKey) => {
    const first = mockWorld();
    const { manifest } = await run(sourceKey, first.client);

    const second = mockWorld(Object.fromEntries(first.store));
    const result = await run(sourceKey, second.client, {
      previousManifest: manifest,
      onConflict: "abort",
      resolveConflict: async () => {
        throw new Error("a recorded copy must not hit the conflict policy");
      },
    });
    assertEquals(result.aborted, false);
    assertEquals(result.summary.updated, 4);
    assertEquals(result.summary.errors, 0);
  });
});

Deno.test("--on-conflict skip leaves an existing config alone and skips its dependents", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({
      [`projects/${DEST}/ai-configs/cfg-a`]: { key: "cfg-a", tags: ["old"] },
    });
    const { summary, manifest } = await run(sourceKey, world.client, {
      onConflict: "skip",
    });
    assertEquals(
      world.writes().filter((c) => !c.includes("model-configs")),
      [],
    );
    assertEquals(summary.errors, 0);
    assertEquals(Object.keys(manifest.configs), []); // not ours: no entry
  });
});

Deno.test("--on-conflict prefix renames the config, its variations and targeting, and reuses the model config", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({
      [`projects/${DEST}/ai-configs/cfg-a`]: { key: "cfg-a" },
      [`projects/${DEST}/ai-configs/model-configs/m1`]: { key: "m1" },
    });
    const renamed: string[] = [];
    const { manifest, summary } = await run(sourceKey, world.client, {
      onConflict: "prefix",
      conflictPrefix: "mig-",
      onConflictRenamed: (type, from, to) =>
        renamed.push(`${type}:${from}>${to}`),
    });
    assertEquals(renamed, ["ai-config:cfg-a>mig-cfg-a"]);
    assertEquals(summary.errors, 0);

    // The model config exists: it is reused, not renamed or rewritten
    assertEquals(world.writes().filter((c) => c.includes("model-configs")), []);
    const configPost =
      world.bodies[`POST projects/${DEST}/ai-configs/mig-cfg-a`];
    assertEquals(configPost.key, "mig-cfg-a");
    assertEquals(configPost.name, "mig-Config A");
    assert(
      world.calls.includes(
        `POST projects/${DEST}/ai-configs/mig-cfg-a/variations`,
      ),
    );
    assert(
      world.calls.includes(
        `SEMANTIC projects/${DEST}/ai-configs/mig-cfg-a/targeting`,
      ),
    );
    assertEquals(manifest.configs["cfg-a"].destKey, "mig-cfg-a");
    // the pre-existing config is untouched
    assertEquals(world.store.get(`projects/${DEST}/ai-configs/cfg-a`), {
      key: "cfg-a",
    });

    // A rerun updates the recorded prefixed copy and does not consult the policy again
    const again = mockWorld(Object.fromEntries(world.store));
    const second = await run(sourceKey, again.client, {
      onConflict: "prefix",
      conflictPrefix: "mig-",
      previousManifest: manifest,
      resolveConflict: async (type) => {
        // the model config was reused, not recorded, so it is resolved again
        if (type === "model-config") return "prefix";
        throw new Error("recorded copy must not hit the conflict policy");
      },
    });
    assertEquals(second.summary.errors, 0);
    assert(again.calls.includes(`PATCH projects/${DEST}/ai-configs/mig-cfg-a`));
    assertEquals(second.manifest.configs["cfg-a"].destKey, "mig-cfg-a");
  });
});

Deno.test("--on-conflict prefix without a prefix, or when the prefixed key is taken, does not write", async () => {
  await withExtract(async (sourceKey) => {
    const noPrefix = mockWorld({
      [`projects/${DEST}/ai-configs/cfg-a`]: { key: "cfg-a" },
    });
    const a = await run(sourceKey, noPrefix.client, { onConflict: "prefix" });
    assertEquals(
      noPrefix.writes().filter((c) => !c.includes("model-configs")),
      [],
    );
    assertEquals(a.summary.errors, 0);

    const taken = mockWorld({
      [`projects/${DEST}/ai-configs/cfg-a`]: { key: "cfg-a" },
      [`projects/${DEST}/ai-configs/mig-cfg-a`]: { key: "mig-cfg-a" },
    });
    const b = await run(sourceKey, taken.client, {
      onConflict: "prefix",
      conflictPrefix: "mig-",
    });
    assertEquals(
      taken.writes().filter((c) => !c.includes("model-configs")),
      [],
    );
    assertEquals(b.summary.errors, 1);
  });
});

Deno.test("--on-conflict abort stops at the first existing resource", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({
      [`projects/${DEST}/ai-configs/cfg-a`]: { key: "cfg-a" },
    });
    let aborted: string | undefined;
    const result = await run(sourceKey, world.client, {
      onConflict: "abort",
      onAbort: (type: AgentControlResourceType, key: string) => {
        aborted = `${type}:${key}`;
      },
    });
    assertEquals(result.aborted, true);
    assertEquals(aborted, "ai-config:cfg-a");
    assertEquals(
      world.writes().filter((c) =>
        c.includes("/variations") || c.startsWith("SEMANTIC")
      ),
      [],
    );
    assertEquals(Object.keys(result.manifest.configs), []);
  });
});

Deno.test("prompt-style resolver is asked once per existing resource", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({
      [`projects/${DEST}/ai-configs/cfg-a`]: { key: "cfg-a" },
      [`projects/${DEST}/ai-configs/model-configs/m1`]: { key: "m1" },
    });
    const asked: string[] = [];
    await run(sourceKey, world.client, {
      resolveConflict: async (
        type,
        key,
      ): Promise<AgentControlConflictAction> => {
        asked.push(`${type}:${key}`);
        return "skip";
      },
    });
    assertEquals(asked, ["model-config:m1", "ai-config:cfg-a"]);
  });
});

Deno.test("a failed write clears its hash but keeps the entry, so --incremental retries it", async () => {
  await withExtract(async (sourceKey) => {
    const first = mockWorld();
    const { manifest } = await run(sourceKey, first.client);

    const failing = mockWorld(Object.fromEntries(first.store), [
      `projects/${DEST}/ai-configs/cfg-a`,
    ]);
    const result = await run(sourceKey, failing.client, {
      previousManifest: manifest,
    });
    assertEquals(result.summary.errors, 1);
    assertEquals(result.manifest.configs["cfg-a"].hash, undefined);
    // dependents are blocked, and keep their previous hashes
    assertEquals(
      result.manifest.configs["cfg-a"].variations["var-1"],
      manifest.configs["cfg-a"].variations["var-1"],
    );

    // the cleared hash makes an incremental run write the config again
    const retry = mockWorld(Object.fromEntries(first.store));
    const fixed = await run(sourceKey, retry.client, {
      incremental: true,
      previousManifest: result.manifest,
    });
    assert(fixed.manifest.configs["cfg-a"].hash);
    assertEquals(
      retry.writes().filter((c) => c.endsWith("/model-configs")).length,
      0,
    );
    assert(retry.writes().length > 0);
  });
});

Deno.test("migration tags are merged with source and existing destination tags", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({
      [`projects/${DEST}/ai-configs/cfg-a`]: {
        key: "cfg-a",
        tags: ["dest-only"],
      },
    });
    await run(sourceKey, world.client, {
      onConflict: "overwrite",
      tags: ["migrated"],
    });
    const patch = world.bodies[`PATCH projects/${DEST}/ai-configs/cfg-a`];
    assertEquals(
      [...(patch.tags as string[])].sort(),
      ["dest-only", "migrated", "src"],
    );
    const model =
      world.bodies[`POST projects/${DEST}/ai-configs/model-configs/m1`];
    assertEquals(model.tags, ["migrated"]);
  });
});

Deno.test("maintainers are mapped when assigning is on, and never copied raw", async () => {
  await withExtract(async (sourceKey) => {
    const mapped = mockWorld();
    await run(sourceKey, mapped.client, {
      assignMaintainerIds: true,
      maintainerMapping: { "src-member": "dest-member" },
    });
    assertEquals(
      mapped.bodies[`POST projects/${DEST}/ai-configs/cfg-a`].maintainerId,
      "dest-member",
    );

    const off = mockWorld();
    await run(sourceKey, off.client, {
      maintainerMapping: { "src-member": "dest-member" },
    });
    const body = off.bodies[`POST projects/${DEST}/ai-configs/cfg-a`];
    assertEquals(body.maintainerId, undefined);
    assertEquals(body._maintainer, undefined);
  });
});

Deno.test("global and restricted model configs are skipped without a write", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld();
    const { summary } = await run(sourceKey, world.client);
    assertEquals(
      world.writes().filter((c) => c.endsWith("/model-configs")).length,
      0,
    );
    assertEquals(summary.skipped, 1);
  }, { key: "m1", name: "M1", global: true });
});

Deno.test("--incremental rewrites everything when the destination was deleted since the sync", async () => {
  await withExtract(async (sourceKey) => {
    const first = mockWorld();
    const { manifest } = await run(sourceKey, first.client);

    // Same manifest, but the destination project was removed and recreated empty
    const empty = mockWorld();
    const result = await run(sourceKey, empty.client, {
      incremental: true,
      previousManifest: manifest,
    });
    assertEquals(result.summary.errors, 0);
    assertEquals(result.summary.skipped, 0);
    assertEquals(result.summary.created, 3); // model config, config, variation
    assertEquals(result.summary.updated, 1); // targeting
    assert(
      empty.calls.includes(
        `SEMANTIC projects/${DEST}/ai-configs/cfg-a/targeting`,
      ),
    );
  });
});

Deno.test("an existing config is updated directly, without a POST that could be rejected", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({
      [`projects/${DEST}/ai-configs/cfg-a`]: { key: "cfg-a" },
    });
    await run(sourceKey, world.client, { onConflict: "overwrite" });
    assertEquals(
      world.writes().filter((c) => c === `POST projects/${DEST}/ai-configs`),
      [],
    );
    assert(world.calls.includes(`PATCH projects/${DEST}/ai-configs/cfg-a`));
  });
});

Deno.test("the result lists the destination keys a reconciliation should find", async () => {
  await withExtract(async (sourceKey) => {
    // written: the model config, and the config under its prefixed key
    const written = mockWorld({
      [`projects/${DEST}/ai-configs/cfg-a`]: { key: "cfg-a" },
    });
    const prefixed = await run(sourceKey, written.client, {
      onConflict: "prefix",
      conflictPrefix: "mig-",
    });
    assertEquals(prefixed.expected.configs, ["mig-cfg-a"]);
    assertEquals(prefixed.expected.modelConfigs, ["m1"]);

    // unchanged under --incremental: still expected (and confirmed present by the lookup)
    const again = mockWorld(Object.fromEntries(written.store));
    const unchanged = await run(sourceKey, again.client, {
      incremental: true,
      onConflict: "prefix",
      conflictPrefix: "mig-",
      previousManifest: prefixed.manifest,
    });
    assertEquals(unchanged.expected, prefixed.expected);

    // skipped by the conflict policy: not ours, so not expected
    const skipped = await run(
      sourceKey,
      mockWorld({
        [`projects/${DEST}/ai-configs/cfg-a`]: { key: "cfg-a" },
      }).client,
      { onConflict: "skip" },
    );
    assertEquals(skipped.expected.configs, []);
  });
});

Deno.test("global model configs and failed writes are not expected in the destination", async () => {
  await withExtract(
    async (sourceKey) => {
      const failing = mockWorld({}, [`projects/${DEST}/ai-configs`]);
      const result = await run(sourceKey, failing.client);
      assertEquals(result.expected.configs, []);
      assertEquals(result.expected.modelConfigs, []);
    },
    { key: "m1", name: "M1", global: true },
  );
});

// ---------- issues reported against Federal destinations ----------

const extractRoot = (sourceKey: string) =>
  `./data/launchdarkly-migrations/source/project/${sourceKey}/ai-configs`;

/** Replace cfg-a's extracted targeting environments (variations: 0 disabled, 1 var-1, 2 var-2). */
async function writeTargeting(
  sourceKey: string,
  environments: Record<string, Record<string, unknown>>,
) {
  await Deno.writeTextFile(
    `${extractRoot(sourceKey)}/targeting/cfg-a.json`,
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
            _ldMeta: { enabled: true, variationKey: "var-1", modelKey: "m1" },
          },
        },
        {
          name: "v2",
          _id: "src-var-2",
          value: {
            _ldMeta: { enabled: true, variationKey: "var-2", modelKey: "m1" },
          },
        },
      ],
      environments,
    }),
  );
}

async function writeVariationFile(
  sourceKey: string,
  key: string,
  extra: Record<string, unknown> = {},
) {
  await Deno.writeTextFile(
    `${extractRoot(sourceKey)}/variations/cfg-a/${key}.json`,
    JSON.stringify({
      key,
      name: key,
      value: { _ldMeta: { modelKey: "m1", variationKey: key } },
      ...extra,
    }),
  );
}

const GLOBAL_M1 = { key: "m1", name: "M1", global: true };

Deno.test("a built-in model the destination lacks is reported up front, and its variations are not written", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({}, [], { destModels: ["OpenAI.other"] });
    const result = await run(sourceKey, world.client);

    assertEquals(result.missingModels, [{
      modelKey: "m1",
      usedBy: ["cfg-a/var-1"],
    }]);
    // The variation is never sent (the API would reject it)
    assertEquals(
      world.writes().filter((c) => c.includes("/variations")),
      [],
    );
    const variation = result.failures.find((f) => f.stage === "variations");
    assertEquals(variation?.key, "cfg-a/var-1");
    assert(variation?.reason.includes('model "m1" is not available'));
    assertEquals(result.summary.errors, result.failures.length);
  }, GLOBAL_M1);
});

Deno.test("a dry run reports missing models and the targeting they break, without writing", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({}, [], { destModels: [] });
    const result = await run(sourceKey, world.client, { dryRun: true });

    assertEquals(world.writes(), []);
    assertEquals(result.missingModels.map((m) => m.modelKey), ["m1"]);
    assertEquals(
      result.failures.map((f) => `${f.stage}:${f.key}`),
      ["variations:cfg-a/var-1", "targeting:cfg-a/production"],
    );
    assert(
      result.failures[1].reason.includes("Default rule not migrated"),
    );
  }, GLOBAL_M1);
});

Deno.test("targeting whose default rule serves an unwritten variation still applies the rest, and names the cause", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({}, [], { destModels: [] });
    const result = await run(sourceKey, world.client);

    // The patch still went out: rules, targets and the off variation map; only the default rule is left out
    assertEquals(world.semantic.length, 1);
    const kinds =
      (world.semantic[0].body.instructions as Array<{ kind: string }>)
        .map((i) => i.kind);
    assertEquals(kinds, [
      "replaceRules",
      "replaceTargets",
      "updateOffVariation",
    ]);

    const targeting = result.failures.find((f) => f.stage === "targeting");
    assertEquals(targeting?.key, "cfg-a/production");
    assert(targeting?.reason.includes("Default rule not migrated"));
    assert(targeting?.reason.includes('model "m1" is not available'));
    // Not recorded, so --incremental retries it once the variation exists
    assertEquals(
      result.manifest.configs["cfg-a"].targeting.production,
      undefined,
    );
  }, GLOBAL_M1);
});

Deno.test("when the destination offers the built-in model, everything migrates", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({}, [], { destModels: ["m1"] });
    const result = await run(sourceKey, world.client);
    assertEquals(result.missingModels, []);
    assertEquals(result.failures, []);
    assert(
      world.calls.includes(`POST projects/${DEST}/ai-configs/cfg-a/variations`),
    );
  }, GLOBAL_M1);
});

Deno.test("an unreadable destination model catalog is a warning, not a failure", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld(); // the model list GET returns 404
    const result = await run(sourceKey, world.client);
    assertEquals(result.failures, []);
    assertEquals(result.warnings.map((w) => w.stage), ["model-configs"]);
  }, GLOBAL_M1);
});

Deno.test("a rejected variation update is an error with the API's reason, not a skip", async () => {
  await withExtract(async (sourceKey) => {
    const varPath = `projects/${DEST}/ai-configs/cfg-a/variations/var-1`;
    const world = mockWorld({ [varPath]: { key: "var-1" } }, [], {
      responses: {
        [`PATCH ${varPath}`]: {
          status: 400,
          body: '{"message":"unknown model key m1"}',
        },
      },
    });
    const result = await run(sourceKey, world.client);
    const failure = result.failures.find((f) => f.stage === "variations");
    assertEquals(failure?.status, 400);
    assert(failure?.reason.includes("unknown model key m1"));
    assertEquals(result.summary.errors, result.failures.length);
  });
});

Deno.test("a 404 on one environment's targeting is an error and the other environments are still patched", async () => {
  await withExtract(async (sourceKey) => {
    await writeTargeting(sourceKey, {
      production: { fallthrough: { variation: 1 }, offVariation: 0 },
      staging: { fallthrough: { variation: 1 }, offVariation: 0 },
    });
    const targetingPath = `projects/${DEST}/ai-configs/cfg-a/targeting`;
    const world = mockWorld({}, [], {
      responses: {
        [`SEMANTIC ${targetingPath} staging`]: {
          status: 404,
          body: '{"message":"environment not found"}',
        },
      },
    });
    const result = await run(sourceKey, world.client);
    assertEquals(
      world.semantic.map((s) => s.body.environmentKey),
      ["production", "staging"],
    );
    assertEquals(
      result.failures.map((f) => `${f.key}:${f.status}`),
      ["cfg-a/staging:404"],
    );
    assert(result.failures[0].reason.includes("environment not found"));
    assert(result.manifest.configs["cfg-a"].targeting.production.hash);
    assertEquals(result.manifest.configs["cfg-a"].targeting.staging, undefined);
  });
});

Deno.test("targeting with no destination variations at all is an error, not a skip", async () => {
  await withExtract(async (sourceKey) => {
    // The config exists but reads back without any variation (not even the built-in one)
    const configPath = `projects/${DEST}/ai-configs/cfg-a`;
    const world = mockWorld({ [configPath]: { key: "cfg-a" } }, [
      `projects/${DEST}/ai-configs/cfg-a/variations`,
    ]);
    const client: AgentControlHttpClient = {
      ...world.client,
      async get(path) {
        const resp = await world.client.get!(path);
        return resp.status === 200 && path === configPath
          ? { ...resp, json: { ...(resp.json as object), variations: [] } }
          : resp;
      },
    };
    const result = await run(sourceKey, client, { onConflict: "overwrite" });
    const targeting = result.failures.find((f) => f.stage === "targeting");
    assert(targeting?.reason.includes("no variations of cfg-a"));
  });
});

Deno.test("an archived source variation is archived after targeting, and only once", async () => {
  await withExtract(async (sourceKey) => {
    await writeVariationFile(sourceKey, "var-1", { state: "archived" });
    await writeVariationFile(sourceKey, "var-2");
    const varPath = `projects/${DEST}/ai-configs/cfg-a/variations/var-1`;

    const world = mockWorld();
    const result = await run(sourceKey, world.client);
    assertEquals(result.failures, []);
    // Created published (the POST body takes no state), then archived after the targeting patch
    assertEquals(world.bodies[`POST ${varPath}`].state, undefined);
    assertEquals(world.bodies[`PATCH ${varPath}`], { state: "archived" });
    const patchAt = world.calls.indexOf(`PATCH ${varPath}`);
    assert(patchAt > world.calls.findIndex((c) => c.startsWith("SEMANTIC")));
    assertEquals(
      result.manifest.configs["cfg-a"].variations["var-1"].archived,
      true,
    );

    // Already archived in the destination: no second state change
    const again = mockWorld(Object.fromEntries(world.store));
    await run(sourceKey, again.client, { previousManifest: result.manifest });
    assertEquals(
      again.calls.filter((c) => c === `PATCH ${varPath}`).length,
      1, // the variation's content update only
    );
    assertEquals(again.bodies[`PATCH ${varPath}`].state, undefined);
  });
});

Deno.test("a variation this migration archived is restored when the source restores it", async () => {
  await withExtract(async (sourceKey) => {
    await writeVariationFile(sourceKey, "var-1", { state: "archived" });
    await writeVariationFile(sourceKey, "var-2");
    const varPath = `projects/${DEST}/ai-configs/cfg-a/variations/var-1`;
    const first = mockWorld();
    const { manifest } = await run(sourceKey, first.client);

    await writeVariationFile(sourceKey, "var-1", { state: "published" });
    const second = mockWorld(Object.fromEntries(first.store));
    const result = await run(sourceKey, second.client, {
      previousManifest: manifest,
    });
    const statePatches = second.calls.filter((c) => c === `PATCH ${varPath}`);
    assertEquals(statePatches.length, 2); // content update, then the restore
    assertEquals(second.store.get(varPath)?.state, "published");
    assertEquals(
      result.manifest.configs["cfg-a"].variations["var-1"].archived,
      undefined,
    );
  });
});

Deno.test("a config's only active variation is not archived, and that is reported as a warning", async () => {
  await withExtract(async (sourceKey) => {
    await writeVariationFile(sourceKey, "var-1", { state: "archived" });
    const world = mockWorld();
    const result = await run(sourceKey, world.client);
    assertEquals(
      world.calls.filter((c) =>
        c === `PATCH projects/${DEST}/ai-configs/cfg-a/variations/var-1`
      ),
      [],
    );
    assertEquals(result.warnings.map((w) => `${w.stage}:${w.key}`), [
      "variation-state:cfg-a/var-1",
    ]);
  });
});

Deno.test("archiving checks each variation against the states earlier archives in the same run left", async () => {
  await withExtract(async (sourceKey) => {
    await writeVariationFile(sourceKey, "var-1", { state: "archived" });
    await writeVariationFile(sourceKey, "var-2", { state: "archived" });
    const base = `projects/${DEST}/ai-configs/cfg-a/variations`;
    const world = mockWorld();
    const result = await run(sourceKey, world.client);
    assertEquals(world.store.get(`${base}/var-1`)?.state, "archived");
    // Archiving var-2 too would leave the config without an active variation
    assertEquals(world.calls.includes(`PATCH ${base}/var-2`), false);
    assertEquals(result.failures, []);
    assertEquals(result.warnings.map((w) => `${w.stage}:${w.key}`), [
      "variation-state:cfg-a/var-2",
    ]);
  });
});

Deno.test("an archived variation whose model is missing is one error, and no archive is attempted", async () => {
  await withExtract(async (sourceKey) => {
    await writeVariationFile(sourceKey, "var-2", {
      state: "archived",
      value: { _ldMeta: { modelKey: "m2", variationKey: "var-2" } },
    });
    const world = mockWorld({}, [], { destModels: [] });
    const result = await run(sourceKey, world.client);
    assertEquals(result.missingModels, [{
      modelKey: "m2",
      usedBy: ["cfg-a/var-2"],
    }]);
    assertEquals(
      result.failures.map((f) => `${f.stage}:${f.key}`),
      ["variations:cfg-a/var-2"],
    );
    assertEquals(
      world.calls.filter((c) => c.includes("/variations/var-2")),
      [],
    );
  });
});

Deno.test("--incremental re-patches an environment whose only change is targeting on/off", async () => {
  await withExtract(async (sourceKey) => {
    const env = { fallthrough: { variation: 1 }, offVariation: 0 };
    await writeTargeting(sourceKey, { production: { ...env, enabled: true } });
    const first = mockWorld();
    const { manifest } = await run(sourceKey, first.client);

    await writeTargeting(sourceKey, { production: { ...env, enabled: false } });
    const second = mockWorld(Object.fromEntries(first.store));
    await run(sourceKey, second.client, {
      incremental: true,
      previousManifest: manifest,
    });
    assertEquals(second.semantic.length, 1);
    assertEquals(
      (second.semantic[0].body.instructions as Array<{ kind: string }>).at(-1),
      { kind: "disableTargeting" },
    );
  });
});

Deno.test("an archive the API refuses because targeting still serves the variation is an error with that reason", async () => {
  await withExtract(async (sourceKey) => {
    await writeVariationFile(sourceKey, "var-1", { state: "archived" });
    await writeVariationFile(sourceKey, "var-2");
    const varPath = `projects/${DEST}/ai-configs/cfg-a/variations/var-1`;
    const world = mockWorld({}, [], {
      responses: {
        [`PATCH ${varPath}`]: {
          status: 400,
          body:
            '{"code":"invalid_request","message":"variation is currently targeted"}',
        },
      },
    });
    const result = await run(sourceKey, world.client);
    assertEquals(
      result.failures.map((f) => `${f.stage}:${f.key}:${f.status}`),
      ["variation-state:cfg-a/var-1:400"],
    );
    assert(
      result.failures[0].reason.includes("variation is currently targeted"),
    );
  });
});

Deno.test("targeting that is off in the source is turned off in the destination", async () => {
  await withExtract(async (sourceKey) => {
    await writeTargeting(sourceKey, {
      production: {
        enabled: false,
        fallthrough: { variation: 1 },
        offVariation: 0,
      },
    });
    const world = mockWorld();
    const result = await run(sourceKey, world.client);
    assertEquals(result.failures, []);
    assertEquals(result.warnings, []);
    const instructions = world.semantic[0].body.instructions as Array<
      Record<string, unknown>
    >;
    assertEquals(instructions.at(-1), { kind: "disableTargeting" });
  });
});

// ---------- extract ----------

function extractClient(
  responses: Record<string, { status: number; json?: unknown; body?: string }>,
) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async get(path: string) {
        calls.push(path);
        const base = path.split("?")[0];
        return responses[base] ?? { status: 404 };
      },
    },
  };
}

async function runExtract(
  responses: Record<string, { status: number; json?: unknown; body?: string }>,
  prepare?: (projPath: string) => Promise<void>,
) {
  const projPath = await Deno.makeTempDir({ prefix: "ac-extract-" });
  try {
    await prepare?.(projPath);
    const { client, calls } = extractClient(responses);
    const result = await extractAgentControlResources({
      apiKey: "test",
      domain: "app.launchdarkly.com",
      projectKey: "src",
      projPath,
      writeJson: (p, data) =>
        Deno.writeTextFile(`${p}.json`, JSON.stringify(data)),
      ensureDir: (p) => Deno.mkdirSync(p, { recursive: true }),
      client,
    });
    const targetingFiles: string[] = [];
    const targeting: Record<string, Record<string, unknown>> = {};
    try {
      for await (const f of Deno.readDir(`${projPath}/ai-configs/targeting`)) {
        targetingFiles.push(f.name);
        targeting[f.name.replace(/\.json$/, "")] = JSON.parse(
          await Deno.readTextFile(`${projPath}/ai-configs/targeting/${f.name}`),
        );
      }
    } catch {
      // not created when the extract is skipped
    }
    return { result, calls, targetingFiles: targetingFiles.sort(), targeting };
  } finally {
    await Deno.remove(projPath, { recursive: true }).catch(() => {});
  }
}

Deno.test("extract records failed reads and does not leave stale targeting behind", async () => {
  const p = "projects/src/ai-configs";
  const { result, targetingFiles } = await runExtract(
    {
      [`${p}/model-configs`]: { status: 200, json: [{ key: "m1" }] },
      [p]: {
        status: 200,
        json: {
          items: [{ key: "a" }, { key: "b" }, { key: "agent" }],
          totalCount: 3,
        },
      },
      [`${p}/a`]: {
        status: 200,
        json: { key: "a", variations: [{ key: "v1" }] },
      },
      [`${p}/a/targeting`]: { status: 200, json: { environments: {} } },
      [`${p}/b`]: {
        status: 200,
        json: { key: "b", variations: [{ key: "v1" }] },
      },
      [`${p}/b/targeting`]: { status: 500, body: "internal error" },
      [`${p}/agent`]: {
        status: 200,
        json: { key: "agent", mode: "agent", variations: [] },
      },
      [`${p}/agent/targeting`]: { status: 200, json: { environments: {} } },
    },
    async (projPath) => {
      // A previous extract's targeting for b must not survive a failed read
      await Deno.mkdir(`${projPath}/ai-configs/targeting`, { recursive: true });
      await Deno.writeTextFile(`${projPath}/ai-configs/targeting/b.json`, "{}");
    },
  );
  assertEquals(result.skipped, false);
  assertEquals(result.targetingCount, 2);
  assertEquals(
    result.failures.map((f) => `${f.key}:${f.status}`),
    ["b/targeting:500"],
  );
  assert(result.failures[0].reason.includes("internal error"));
  assertEquals(targetingFiles, ["a.json", "agent.json"]);
});

Deno.test("extract reads what each targeting rule serves from the config's flag, and reports when it cannot", async () => {
  const p = "projects/src/ai-configs";
  const rulesTargeting = {
    variations: [{ _id: "id-off", name: "disabled" }, { _id: "id-a" }],
    environments: {
      production: {
        rules: [{ clauses: [{ id: "c1", attribute: "country" }] }],
      },
    },
  };
  const base = {
    [`${p}/model-configs`]: { status: 200, json: [] },
    [p]: {
      status: 200,
      json: { items: [{ key: "a" }, { key: "b" }], totalCount: 2 },
    },
    [`${p}/a`]: { status: 200, json: { key: "a", variations: [] } },
    [`${p}/a/targeting`]: {
      status: 200,
      json: structuredClone(rulesTargeting),
    },
    [`${p}/b`]: { status: 200, json: { key: "b", variations: [] } },
    [`${p}/b/targeting`]: {
      status: 200,
      json: structuredClone(rulesTargeting),
    },
    "flags/src/a": {
      status: 200,
      json: {
        variations: [{ _id: "id-off" }, { _id: "id-a" }],
        environments: {
          production: {
            rules: [{
              variation: 1,
              description: "by country",
              clauses: [{
                _id: "c1",
                attribute: "country",
                contextKind: "org",
              }],
            }],
          },
        },
      },
    },
    "flags/src/b": { status: 403, body: "forbidden" },
  };
  const { result, calls, targeting } = await runExtract(base);
  assert(calls.includes("flags/src/a"));
  const rule = (targeting.a.environments as Record<string, any>).production
    .rules[0];
  assertEquals(rule.variation, "id-a");
  assertEquals(rule.description, "by country");
  assertEquals(rule.clauses[0].contextKind, "org");
  assertEquals(
    result.failures.map((f) => `${f.key}:${f.status}`),
    ["b/targeting:403"],
  );
  assert(result.failures[0].reason.includes("rules will not be migrated"));
});

Deno.test("extract treats a 403/404 on the first list as AgentControl unavailable, and other list errors as failures", async () => {
  const p = "projects/src/ai-configs";
  const unavailable = await runExtract({
    [`${p}/model-configs`]: { status: 403, body: "Plan does not allow" },
  });
  assertEquals(unavailable.result.skipped, true);
  assertEquals(unavailable.result.failures, []);

  const broken = await runExtract({
    [`${p}/model-configs`]: { status: 200, json: [] },
    [p]: { status: 502, body: "bad gateway" },
  });
  assertEquals(broken.result.skipped, false);
  assertEquals(
    broken.result.failures.map((f) => `${f.key}:${f.status}`),
    ["configs:502"],
  );
});

// ---------- model mapping (custom destination models with generated keys) ----------

const CUSTOM_M1 = "m1-custom-1a2b";
const varPostKey = `POST projects/${DEST}/ai-configs/cfg-a/variations/var-1`;
const fallthroughOf = (world: ReturnType<typeof mockWorld>) =>
  (world.semantic[0]?.body.instructions as Array<Record<string, unknown>>)
    ?.find((i) => i.kind === "updateFallthroughVariationOrRollout");

Deno.test("a mapped built-in model writes its variations with the destination key, and the default rule maps", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({}, [], { destModels: [CUSTOM_M1] });
    const result = await run(sourceKey, world.client, {
      modelMapping: { m1: CUSTOM_M1 },
    });
    assertEquals(result.missingModels, []);
    assertEquals(result.failures, []);
    assertEquals(result.modelMappings, [{
      sourceKey: "m1",
      destKey: CUSTOM_M1,
      usedBy: ["cfg-a/var-1"],
    }]);
    const meta = (world.bodies[varPostKey].value as Record<string, any>)
      ._ldMeta;
    assertEquals(meta.modelKey, CUSTOM_M1);
    assertEquals(fallthroughOf(world)?.variationId, "dest-var-1");
  }, GLOBAL_M1);
});

Deno.test("a mapped custom source model is not created in the destination", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({}, [], { destModels: [CUSTOM_M1] });
    const result = await run(sourceKey, world.client, {
      modelMapping: { m1: CUSTOM_M1 },
    });
    assertEquals(
      world.writes().filter((c) => c.includes("/model-configs")),
      [],
    );
    assertEquals(result.expected.modelConfigs, []);
    assertEquals(result.failures, []);
  });
});

Deno.test("a mapping target the destination lacks is a missing model, reported with its source key and suggestions", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({}, [], { destModels: [CUSTOM_M1] });
    const result = await run(sourceKey, world.client, {
      modelMapping: { m1: "m1-typo" },
    });
    assertEquals(result.missingModels, [{
      modelKey: "m1-typo",
      usedBy: ["cfg-a/var-1"],
      mappedFrom: "m1",
      suggestions: [CUSTOM_M1],
    }]);
    assertEquals(result.modelMappings, []);
    const variation = result.failures.find((f) => f.stage === "variations");
    assert(variation?.reason.includes('"m1-typo" (mapped from "m1")'));
    assertEquals(world.bodies[varPostKey], undefined);
  }, GLOBAL_M1);
});

Deno.test("an unmapped missing model lists destination models that look like it", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({}, [], { destModels: [CUSTOM_M1, "OpenAI.x"] });
    const result = await run(sourceKey, world.client);
    assertEquals(result.missingModels, [{
      modelKey: "m1",
      usedBy: ["cfg-a/var-1"],
      suggestions: [CUSTOM_M1],
    }]);
  }, GLOBAL_M1);
});

Deno.test("a mapping entry no variation uses is a warning", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({}, [], { destModels: ["m1"] });
    const result = await run(sourceKey, world.client, {
      modelMapping: { "unused-model": "whatever" },
    });
    assertEquals(result.failures, []);
    assertEquals(
      result.warnings.map((w) => `${w.stage}:${w.key}`),
      ["model-configs:unused-model"],
    );
  }, GLOBAL_M1);
});

Deno.test("unmappedDefaultRule disabled points an unmappable default rule at disabled, and it is still an error", async () => {
  await withExtract(async (sourceKey) => {
    const world = mockWorld({}, [], { destModels: [] });
    const result = await run(sourceKey, world.client, {
      unmappedDefaultRule: "disabled",
    });
    assertEquals(fallthroughOf(world)?.variationId, "dest-disabled");
    const targeting = result.failures.find((f) => f.stage === "targeting");
    assert(targeting?.reason.includes("disabled variation instead"));
    assertEquals(
      result.manifest.configs["cfg-a"].targeting.production,
      undefined,
    );

    // Without the option the default rule is left out of the patch
    const left = mockWorld({}, [], { destModels: [] });
    await run(sourceKey, left.client);
    assertEquals(fallthroughOf(left), undefined);
  }, GLOBAL_M1);
});

Deno.test("--incremental rewrites a variation when its model mapping changes, and only then", async () => {
  await withExtract(async (sourceKey) => {
    const destModels = ["m1-a", "m1-b"];
    const varPath = `projects/${DEST}/ai-configs/cfg-a/variations/var-1`;
    const first = mockWorld({}, [], { destModels });
    const { manifest } = await run(sourceKey, first.client, {
      modelMapping: { m1: "m1-a" },
    });

    const same = mockWorld(Object.fromEntries(first.store), [], { destModels });
    const unchanged = await run(sourceKey, same.client, {
      incremental: true,
      previousManifest: manifest,
      modelMapping: { m1: "m1-a" },
    });
    assertEquals(same.writes().filter((c) => c.includes("/variations")), []);

    const changed = mockWorld(Object.fromEntries(first.store), [], {
      destModels,
    });
    await run(sourceKey, changed.client, {
      incremental: true,
      previousManifest: unchanged.manifest,
      modelMapping: { m1: "m1-b" },
    });
    assertEquals(
      (changed.bodies[`PATCH ${varPath}`].value as Record<string, any>)
        ._ldMeta.modelKey,
      "m1-b",
    );
  }, GLOBAL_M1);
});
