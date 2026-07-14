// deno-lint-ignore-file no-explicit-any
/**
 * Split (Harness FME) → LaunchDarkly source adapter.
 *
 * Extracts a Split workspace via the Split Admin API, transforms it to
 * LaunchDarkly API shapes (src/utils/split/mapping.ts), and writes the same
 * source-data directory that source_from_ld.ts produces — so
 * migrate_between_ld_instances.ts performs all LaunchDarkly writes:
 *
 *   data/launchdarkly-migrations/source/project/{projKey}/
 *     project.json          — project + environments (from Split environments)
 *     flags.json            — list of LD flag keys
 *     flags/{i}-{key}.json  — full LD flag payloads incl. per-env targeting
 *     segments/{env}.json   — LD segments (standard, big, rule-based)
 *     contextKinds.json     — LD context kinds (from Split traffic types)
 *     split-fidelity-report.json — FULL/PARTIAL/MANUAL/SKIPPED ledger
 *
 * This script only READS from Split and writes local files; it never calls
 * the LaunchDarkly API.
 */

import yargs from "https://deno.land/x/yargs@v17.7.2-deno/deno.ts";
import { ensureDirSync } from "https://deno.land/std@0.149.0/fs/mod.ts";
import * as Colors from "https://deno.land/std@0.149.0/fmt/colors.ts";
import { writeSourceData } from "../../utils/utils.ts";
import { getSplitApiKey } from "../../utils/api_keys.ts";
import { SplitClient } from "../../utils/split/client.ts";
import {
  decideVariations,
  KeyRegistry,
  type LDSegmentPayload,
  type MappingContext,
  mapFlag,
  mapLargeSegment,
  mapRuleBasedSegment,
  mapStandardSegment,
  mapTrafficTypes,
  type Note,
  sanitizeKey,
  type VariationDecision,
} from "../../utils/split/mapping.ts";
import type { SplitEnvironment, SplitFlagDefinition } from "../../utils/split/types.ts";

interface Arguments {
  workspace: string;
  projKey: string;
  tag?: string;
  environments?: string;
  envMap?: string;
  splitBaseUrl?: string;
  ldTag?: string;
}

const inputArgs: Arguments = yargs(Deno.args)
  .alias("w", "workspace")
  .alias("p", "projKey")
  .alias("t", "tag")
  .alias("e", "environments")
  .alias("env-map", "envMap")
  .alias("split-base-url", "splitBaseUrl")
  .alias("ld-tag", "ldTag")
  .demandOption(["w", "p"])
  .describe("w", "Split workspace (project) ID or name")
  .describe("p", "Source project key to write under data/launchdarkly-migrations/source/project/")
  .describe("t", "Only extract Split flags/segments with this tag")
  .describe("e", "Comma-separated Split environment names to extract (default: all)")
  .describe("env-map", "Split env → LD env key mapping, e.g. 'Prod-Default:production,Staging:test'")
  .describe("split-base-url", "Split API host (default: https://api.split.io)")
  .describe("ld-tag", "Tag applied to everything imported (default: imported-from-split)")
  .parse() as Arguments;

const importTag = inputArgs.ldTag ?? "imported-from-split";
const allNotes: Note[] = [];
const collect = (notes: Note[]) => allNotes.push(...notes);

console.log(Colors.blue("\n=== Split → LaunchDarkly Source Extract ==="));
console.log(Colors.gray(`Workspace: ${inputArgs.workspace}`));
console.log(Colors.gray(`Source project key: ${inputArgs.projKey}`));
console.log(Colors.gray(`Split tag filter: ${inputArgs.tag ?? "none"}`));

const apiKey = await getSplitApiKey();
const client = new SplitClient(apiKey, { baseUrl: inputArgs.splitBaseUrl });

// ==================== Workspace ====================

const workspaces = await client.listWorkspaces();
const workspace = workspaces.find((ws) => ws.id === inputArgs.workspace) ??
  workspaces.find((ws) => ws.name === inputArgs.workspace);
if (!workspace) {
  console.log(Colors.red(`❌ Workspace "${inputArgs.workspace}" not found.`));
  console.log(Colors.gray(`Available: ${workspaces.map((w) => `${w.name} (${w.id})`).join(", ")}`));
  Deno.exit(1);
}
console.log(Colors.green(`✓ Workspace: ${workspace.name} (${workspace.id})`));

// ==================== Environments ====================

const allEnvs = await client.getEnvironments(workspace.id);
let selectedEnvs: SplitEnvironment[] = allEnvs;
if (inputArgs.environments) {
  const wanted = inputArgs.environments.split(",").map((e) => e.trim()).filter(Boolean);
  selectedEnvs = wanted
    .map((name) =>
      allEnvs.find((env) => env.name === name) ??
        allEnvs.find((env) => env.name.toLowerCase() === name.toLowerCase())
    )
    .filter((env): env is SplitEnvironment => env !== undefined);
  const missing = wanted.filter((name) =>
    !selectedEnvs.some((env) => env.name.toLowerCase() === name.toLowerCase())
  );
  if (missing.length > 0) {
    console.log(Colors.yellow(`⚠ Environments not found in Split: ${missing.join(", ")}`));
  }
  if (selectedEnvs.length === 0) {
    console.log(Colors.red(`❌ None of the requested environments exist.`));
    console.log(Colors.gray(`Available: ${allEnvs.map((env) => env.name).join(", ")}`));
    Deno.exit(1);
  }
} else {
  // No explicit selection: put production-flagged environments first so they
  // win variation-configuration ties.
  selectedEnvs = [...allEnvs].sort((a, b) => Number(b.production ?? false) - Number(a.production ?? false));
}

// Split env name → LD env key (via --env-map or sanitized lowercase name).
const envMap: Record<string, string> = {};
for (const mapping of (inputArgs.envMap ?? "").split(",").map((m) => m.trim()).filter(Boolean)) {
  const idx = mapping.lastIndexOf(":");
  if (idx <= 0 || idx === mapping.length - 1) {
    console.log(Colors.red(`❌ Invalid --env-map entry "${mapping}" (expected 'SplitEnv:ld-env-key')`));
    Deno.exit(1);
  }
  envMap[mapping.slice(0, idx)] = mapping.slice(idx + 1);
}
const envKeyRegistry = new KeyRegistry({ lowercase: true });
const ldEnvKeyByName = new Map<string, string>();
for (const env of selectedEnvs) {
  ldEnvKeyByName.set(env.name, envMap[env.name] ?? envKeyRegistry.keyFor(env.name));
}

console.log(Colors.cyan(`\nEnvironments to extract:`));
for (const env of selectedEnvs) {
  console.log(`  ${env.name} → ${ldEnvKeyByName.get(env.name)}${env.production ? " (production)" : ""}`);
}

// ==================== Traffic types → context kinds ====================

const trafficTypes = await client.getTrafficTypes(workspace.id);
const { contextKinds, kindByTrafficType, notes: ttNotes } = mapTrafficTypes(trafficTypes);
collect(ttNotes);
console.log(Colors.green(`✓ ${trafficTypes.length} traffic type(s) → ${contextKinds.length} custom context kind(s)`));

// ==================== Flags: metadata, flag sets, definitions ====================

console.log(Colors.blue(`\n📦 Extracting flags${inputArgs.tag ? ` tagged "${inputArgs.tag}"` : ""}...`));
const flagMetas = await client.listFlags(workspace.id, inputArgs.tag);
console.log(Colors.green(`✓ ${flagMetas.length} flag(s) in workspace list`));
const metaByName = new Map(flagMetas.map((f) => [f.name, f]));

let flagSetNameById = new Map<string, string>();
try {
  const flagSets = await client.listFlagSets(workspace.id);
  flagSetNameById = new Map(flagSets.map((fs) => [fs.id, fs.name]));
  if (flagSets.length > 0) {
    console.log(Colors.green(`✓ ${flagSets.length} flag set(s) → flagset.<name> tags`));
  }
} catch (error) {
  console.log(Colors.yellow(`⚠ Could not list flag sets (continuing without): ${error instanceof Error ? error.message : error}`));
}

// Definitions per environment, keyed by Split flag name.
const defsByFlagAndEnv = new Map<string, Record<string, SplitFlagDefinition>>();
for (const env of selectedEnvs) {
  const ldEnvKey = ldEnvKeyByName.get(env.name)!;
  console.log(Colors.gray(`  Definitions in ${env.name}...`));
  const defs = await client.listFlagDefinitions(workspace.id, env.id);
  let kept = 0;
  for (const def of defs) {
    // With a tag filter, only keep definitions for flags in the filtered list.
    if (inputArgs.tag && !metaByName.has(def.name)) continue;
    const byEnv = defsByFlagAndEnv.get(def.name) ?? {};
    byEnv[ldEnvKey] = def;
    defsByFlagAndEnv.set(def.name, byEnv);
    kept++;
  }
  console.log(Colors.green(`  ✓ ${env.name}: ${kept} definition(s)`));
}

// Flags with a definition anywhere, plus metadata-only flags (never configured).
const flagNames = [...defsByFlagAndEnv.keys()];
for (const meta of flagMetas) {
  if (!defsByFlagAndEnv.has(meta.name)) {
    allNotes.push({
      level: "SKIPPED",
      area: "flag",
      item: meta.name,
      message: `Flag has no definition in any extracted environment; nothing to migrate`,
    });
  }
}

// ==================== Segments ====================

console.log(Colors.blue(`\n🔷 Extracting segments...`));
const segmentKeyRegistry = new KeyRegistry();
const segmentKeyByName = new Map<string, string>();
const registerSegment = (name: string) => {
  if (!segmentKeyByName.has(name)) segmentKeyByName.set(name, segmentKeyRegistry.keyFor(name));
  return segmentKeyByName.get(name)!;
};

const segmentMetas = await client.listSegments(workspace.id, inputArgs.tag);
const segmentMetaByName = new Map(segmentMetas.map((s) => [s.name, s]));
segmentMetas.forEach((s) => registerSegment(s.name));
console.log(Colors.green(`✓ ${segmentMetas.length} standard segment(s) in workspace`));

interface EnvSegments {
  ldEnvKey: string;
  items: LDSegmentPayload[];
  /** Standard segment keys by Split name, for excludedSegments snapshots. */
  keysByName: Map<string, string[]>;
}

const envSegments: EnvSegments[] = [];
for (const env of selectedEnvs) {
  const ldEnvKey = ldEnvKeyByName.get(env.name)!;
  const bucket: EnvSegments = { ldEnvKey, items: [], keysByName: new Map() };
  envSegments.push(bucket);

  // Standard segments active in this environment (+ member keys).
  const inEnv = await client.listSegmentsInEnvironment(workspace.id, env.id);
  for (const seg of inEnv) {
    if (inputArgs.tag && !segmentMetaByName.has(seg.name)) continue;
    const keys = await client.getSegmentKeys(env.id, seg.name);
    bucket.keysByName.set(seg.name, keys);
  }

  // Rule-based segments.
  let rbsList: Awaited<ReturnType<typeof client.listRuleBasedSegmentsInEnvironment>> = [];
  try {
    rbsList = await client.listRuleBasedSegmentsInEnvironment(workspace.id, env.id);
  } catch (error) {
    console.log(Colors.yellow(`  ⚠ ${env.name}: could not list rule-based segments: ${error instanceof Error ? error.message : error}`));
  }
  rbsList.forEach((rbs) => registerSegment(rbs.name));

  // Large segments (metadata only — members are not exportable).
  let largeList: Awaited<ReturnType<typeof client.listLargeSegmentsInEnvironment>> = [];
  try {
    largeList = await client.listLargeSegmentsInEnvironment(workspace.id, env.id);
  } catch (error) {
    console.log(Colors.yellow(`  ⚠ ${env.name}: could not list large segments: ${error instanceof Error ? error.message : error}`));
  }
  largeList.forEach((seg) => registerSegment(seg.name));

  const ctxForSegments: MappingContext = {
    kindByTrafficType,
    segmentKeyByName,
    flagKeyByName: new Map(),
  };

  for (const [name, keys] of bucket.keysByName) {
    const { segment, notes } = mapStandardSegment({
      meta: segmentMetaByName.get(name) ?? null,
      splitName: name,
      segmentKey: registerSegment(name),
      keys,
      ctx: ctxForSegments,
      extraTags: [importTag],
    });
    bucket.items.push(segment);
    collect(notes.map((n) => ({ ...n, item: `${n.item} (${env.name})` })));
  }

  for (const rbs of rbsList) {
    const { segment, notes } = mapRuleBasedSegment({
      rbs,
      segmentKey: registerSegment(rbs.name),
      ctx: ctxForSegments,
      resolveSegmentKeys: (segmentName) => bucket.keysByName.get(segmentName) ?? null,
      extraTags: [importTag],
    });
    bucket.items.push(segment);
    collect(notes.map((n) => ({ ...n, item: `${n.item} (${env.name})` })));
  }

  for (const large of largeList) {
    const { segment, notes } = mapLargeSegment({
      name: large.name,
      segmentKey: registerSegment(large.name),
      trafficTypeName: large.trafficType?.name,
      description: large.description,
      ctx: ctxForSegments,
      extraTags: [importTag],
    });
    bucket.items.push(segment);
    collect(notes.map((n) => ({ ...n, item: `${n.item} (${env.name})` })));
  }

  console.log(Colors.green(
    `  ✓ ${env.name}: ${bucket.keysByName.size} standard, ${rbsList.length} rule-based, ${largeList.length} large`,
  ));
}

// ==================== Flag mapping ====================

console.log(Colors.blue(`\n🚩 Mapping ${flagNames.length} flag(s) to LaunchDarkly shapes...`));

const envPriority = selectedEnvs.map((env) => ldEnvKeyByName.get(env.name)!);
const flagKeyRegistry = new KeyRegistry();
const flagKeyByName = new Map<string, string>();
const decisions = new Map<string, VariationDecision>();

for (const name of flagNames) {
  flagKeyByName.set(name, flagKeyRegistry.keyFor(name));
  const byEnv = defsByFlagAndEnv.get(name)!;
  const defsInPriorityOrder = envPriority.map((e) => byEnv[e]).filter((d) => d !== undefined);
  decisions.set(name, decideVariations(name, defsInPriorityOrder));
}

const mappingCtx: MappingContext = {
  kindByTrafficType,
  segmentKeyByName,
  flagKeyByName,
  resolvePrerequisite: (splitName, treatment) => {
    const key = flagKeyByName.get(splitName);
    const variation = decisions.get(splitName)?.indexByTreatment.get(treatment);
    if (key === undefined || variation === undefined) return null;
    return { key, variation };
  },
};

const flags = flagNames.map((name) => {
  const byEnv = defsByFlagAndEnv.get(name)!;
  const meta = metaByName.get(name) ?? null;
  const flagSetIds = Object.values(byEnv).flatMap((def) => def.flagSets ?? []).map((fs) => fs.id);
  const flagSetNames = [...new Set(flagSetIds.map((id) => flagSetNameById.get(id)).filter((n): n is string => !!n))];
  const { flag, notes } = mapFlag({
    meta,
    splitName: name,
    flagKey: flagKeyByName.get(name)!,
    defsByLdEnv: byEnv,
    envPriority,
    decision: decisions.get(name)!,
    ctx: mappingCtx,
    extraTags: [importTag],
    flagSetNames,
  });
  collect(notes);
  return flag;
});

// ==================== Write source data ====================

const projPath = `./data/launchdarkly-migrations/source/project/${inputArgs.projKey}`;
ensureDirSync(projPath);
ensureDirSync(`${projPath}/flags`);
ensureDirSync(`${projPath}/segments`);

const ENV_COLORS = ["417505", "F5A623", "4A90E2", "9013FE", "D0021B", "50E3C2"];
await writeSourceData(projPath, "project", {
  key: inputArgs.projKey,
  name: `Split: ${workspace.name}`,
  environments: {
    items: selectedEnvs.map((env, i) => ({
      key: ldEnvKeyByName.get(env.name)!,
      name: env.name,
      color: ENV_COLORS[i % ENV_COLORS.length],
    })),
    totalCount: selectedEnvs.length,
  },
});

await writeSourceData(projPath, "flags", flags.map((f) => f.key));
for (const [index, flag] of flags.entries()) {
  await writeSourceData(`${projPath}/flags`, `${index}-${flag.key}`, flag);
}

for (const bucket of envSegments) {
  await writeSourceData(`${projPath}/segments`, bucket.ldEnvKey, {
    items: bucket.items,
    totalCount: bucket.items.length,
  });
}

await writeSourceData(projPath, "contextKinds", contextKinds);

// ==================== Fidelity report ====================

const counts = { FULL: 0, PARTIAL: 0, MANUAL: 0, SKIPPED: 0 };
for (const n of allNotes) counts[n.level]++;

const report = {
  generatedAt: new Date().toISOString(),
  workspace: { id: workspace.id, name: workspace.name },
  environments: selectedEnvs.map((env) => ({ split: env.name, ld: ldEnvKeyByName.get(env.name)! })),
  globalWarnings: [
    "Percentage rollouts re-bucket at cutover: Split and LD hash differently, so users may switch treatments at identical percentages.",
    "Split experiments and metric definitions are NOT exportable via the Split public Admin API and are not migrated.",
    "Large segment members are NOT exportable via the Split public Admin API; re-import membership from your source of truth.",
  ],
  counts,
  totals: { flags: flags.length, environments: selectedEnvs.length, contextKinds: contextKinds.length },
  notes: allNotes,
};
await writeSourceData(projPath, "split-fidelity-report", report);

console.log(Colors.blue(`\n${"=".repeat(60)}`));
console.log(Colors.blue("📊 EXTRACT SUMMARY"));
console.log(Colors.blue("=".repeat(60)));
console.log(`Flags mapped: ${flags.length}`);
console.log(`Environments: ${selectedEnvs.length}`);
console.log(`Context kinds: ${contextKinds.length}`);
console.log(`Segments: ${envSegments.reduce((s, b) => s + b.items.length, 0)} across all environments`);
console.log(`\nFidelity: ${Colors.green(`FULL ${counts.FULL}`)} | ${Colors.yellow(`PARTIAL ${counts.PARTIAL}`)} | ${Colors.red(`MANUAL ${counts.MANUAL}`)} | ${Colors.gray(`SKIPPED ${counts.SKIPPED}`)}`);

const manualNotes = allNotes.filter((n) => n.level === "MANUAL");
if (manualNotes.length > 0) {
  console.log(Colors.red(`\n⚠ MANUAL follow-up required (${manualNotes.length}):`));
  for (const n of manualNotes) {
    console.log(Colors.red(`  ✗ [${n.area}] ${n.item}: ${n.message}`));
  }
}

console.log(Colors.yellow(`\nGlobal caveats:`));
for (const w of report.globalWarnings) console.log(Colors.yellow(`  • ${w}`));

console.log(Colors.green(`\n✓ Source data written to ${projPath}`));
console.log(Colors.gray(`Next: deno task migrate -- -p ${inputArgs.projKey} -d <destination-project> --dry-run`));
