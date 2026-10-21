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

/** An in-memory destination: existing resources keyed by their full GET path. */
function mockWorld(
  existing: Record<string, Record<string, unknown>> = {},
  failPaths: string[] = [],
) {
  const store = new Map(Object.entries(existing));
  const calls: string[] = [];
  const bodies: Record<string, Record<string, unknown>> = {};
  const client: AgentControlHttpClient = {
    async post(path, body) {
      calls.push(`POST ${path}`);
      if (failPaths.includes(path)) return { status: 500, body: "boom" };
      const full = `${path}/${body.key}`;
      bodies[`POST ${full}`] = body;
      if (store.has(full)) return { status: 409 };
      store.set(full, body);
      return { status: 201 };
    },
    async patch(path, body) {
      calls.push(`PATCH ${path}`);
      if (failPaths.includes(path)) return { status: 500, body: "boom" };
      bodies[`PATCH ${path}`] = body as Record<string, unknown>;
      store.set(path, { ...store.get(path), ...body });
      return { status: 200 };
    },
    async semanticPatch(path) {
      calls.push(`SEMANTIC ${path}`);
      return { status: 200 };
    },
    async get(path) {
      calls.push(`GET ${path}`);
      const found = store.get(path);
      if (!found) return { status: 404 };
      return {
        status: 200,
        json: {
          ...found,
          variations: [
            { key: "disabled", _id: "dest-disabled" },
            { key: "var-1", _id: "dest-var-1" },
          ],
        },
      };
    },
  };
  const writes = () => calls.filter((c) => !c.startsWith("GET "));
  return { client, calls, bodies, writes, store };
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
