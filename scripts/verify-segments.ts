// deno-lint-ignore-file no-explicit-any
/**
 * Compare segments between a source and destination project after a migration.
 *
 * Usage:
 *   deno run --allow-net --allow-read scripts/verify-segments.ts <sourceProj> <destProj> [keyPrefix]
 *
 * Regular segments: compares name, description, tags, targets and rules (ignoring ids, versions and dates).
 * Rules with percentage rollouts are listed separately: their bucketing can't be compared via the API.
 * Big segments: checks each key from the extracted CSV is a member in the destination.
 * Views: compares name, description, tags, maintainer (by email) and linked flags/segments.
 */

import { getDestinationApiKey, getSourceApiKey } from "../src/utils/api_keys.ts";
import { bigSegmentCsvPath, readExportedKeys } from "../src/utils/big_segments.ts";
import { extractViews } from "../src/utils/views.ts";

const [sourceProj, destProj, keyPrefix = ""] = Deno.args;
if (!sourceProj || !destProj) {
  console.error("Usage: verify-segments.ts <sourceProj> <destProj> [keyPrefix]");
  Deno.exit(2);
}
const domain = "app.launchdarkly.com";
const sourceKey = await getSourceApiKey();
const destKey = await getDestinationApiKey();

async function get(apiKey: string, path: string): Promise<{ status: number; body: any }> {
  const resp = await fetch(`https://${domain}/api/v2/${path}`, { headers: { Authorization: apiKey } });
  return { status: resp.status, body: resp.status === 200 ? await resp.json() : await resp.text() };
}

async function listSegments(apiKey: string, proj: string, env: string): Promise<any[]> {
  const items: any[] = [];
  for (let offset = 0; ; offset += 50) {
    const { body } = await get(apiKey, `segments/${proj}/${env}?limit=50&offset=${offset}`);
    items.push(...body.items);
    if (items.length >= body.totalCount || body.items.length === 0) return items;
  }
}

const sortBy = (arr: any[] = [], f: (x: any) => string) => [...arr].sort((a, b) => f(a).localeCompare(f(b)));

function normalize(seg: any) {
  return {
    name: seg.name,
    description: seg.description ?? "",
    tags: [...(seg.tags ?? [])].sort(),
    unbounded: seg.unbounded ?? false,
    unboundedContextKind: seg.unbounded ? seg.unboundedContextKind : undefined,
    included: [...(seg.included ?? [])].sort(),
    excluded: [...(seg.excluded ?? [])].sort(),
    includedContexts: sortBy(seg.includedContexts, (c) => c.contextKind).map((c) => ({ contextKind: c.contextKind, values: [...c.values].sort() })),
    excludedContexts: sortBy(seg.excludedContexts, (c) => c.contextKind).map((c) => ({ contextKind: c.contextKind, values: [...c.values].sort() })),
    rules: (seg.rules ?? []).map((r: any) => ({
      description: r.description ?? "",
      weight: r.weight ?? null,
      bucketBy: r.bucketBy ?? null,
      rolloutContextKind: r.rolloutContextKind ?? null,
      clauses: r.clauses.map((c: any) => ({
        contextKind: c.contextKind, attribute: c.attribute, op: c.op, negate: c.negate ?? false, values: c.values,
      })),
    })),
  };
}

function diff(a: any, b: any, path = ""): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    return [`${path || "(root)"}: source=${JSON.stringify(a)} dest=${JSON.stringify(b)}`];
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => diff(a[k], b[k], path ? `${path}.${k}` : k));
}

const { body: project } = await get(sourceKey, `projects/${sourceProj}?expand=environments`);
let pass = 0, fail = 0;
const saltDiffs: string[] = [];

for (const env of project.environments.items.map((e: any) => e.key)) {
  const segments = (await listSegments(sourceKey, sourceProj, env)).filter((s) => s.key.startsWith(keyPrefix));
  for (const listed of segments) {
    const label = `${env}/${listed.key}`;
    const { body: src } = await get(sourceKey, `segments/${sourceProj}/${env}/${listed.key}`);
    const dst = await get(destKey, `segments/${destProj}/${env}/${listed.key}`);
    if (dst.status !== 200) {
      console.log(`✗ ${label}: missing in destination (HTTP ${dst.status})`);
      fail++;
      continue;
    }
    const problems = diff(normalize(src), normalize(dst.body));

    if (src.unbounded) {
      const csvPath = bigSegmentCsvPath(`./data/launchdarkly-migrations/source/project/${sourceProj}`, env, listed.key);
      const csv = await Deno.readTextFile(csvPath).catch(() => null);
      if (csv === null) {
        problems.push(`no extracted CSV at ${csvPath} to check membership against`);
      } else {
        const keys = readExportedKeys(csv);
        const missing: string[] = [];
        for (const k of keys) {
          const m = await get(destKey, `segments/${destProj}/${env}/${listed.key}/contexts/${encodeURIComponent(k)}`);
          if (m.status !== 200 || m.body.included !== true) missing.push(k);
        }
        if (missing.length) problems.push(`${missing.length}/${keys.length} members missing in destination: ${JSON.stringify(missing)}`);
        else console.log(`  ${label}: ${keys.length}/${keys.length} big segment members present`);
      }
    }

    // The API does not return segment salts, so bucketing can't be compared; flag every rollout rule instead
    if ((src.rules ?? []).some((r: any) => r.weight != null)) {
      saltDiffs.push(label);
    }

    if (problems.length) {
      console.log(`✗ ${label}`);
      problems.forEach((p) => console.log(`    ${p}`));
      fail++;
    } else {
      console.log(`✓ ${label}`);
      pass++;
    }
  }
}

// Views
async function viewDetails(apiKey: string, proj: string): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (const v of await extractViews(apiKey, domain, proj)) {
    if (v.key.startsWith(keyPrefix)) out.set(v.key, { view: v });
  }
  return out;
}
async function maintainerOf(apiKey: string, proj: string, viewKey: string): Promise<string | null> {
  const resp = await fetch(`https://${domain}/api/v2/projects/${proj}/views/${viewKey}`, {
    headers: { Authorization: apiKey, "LD-API-Version": "beta" },
  });
  if (resp.status !== 200) return `HTTP ${resp.status}`;
  const m = (await resp.json()).maintainer;
  return m?.maintainerMember?.email ?? (m?.maintainerTeam?.key ? `team:${m.maintainerTeam.key}` : null);
}

const sourceViews = await viewDetails(sourceKey, sourceProj).catch((e) => {
  console.log(`✗ could not read source views: ${e.message}`);
  fail++;
  return new Map<string, any>();
});
const destViews = await viewDetails(destKey, destProj).catch((e) => {
  console.log(`✗ could not read destination views: ${e.message}`);
  fail++;
  return new Map<string, any>();
});
for (const [key, { view: src }] of sourceViews) {
  const label = `view/${key}`;
  const dst = destViews.get(key)?.view;
  if (!dst) {
    console.log(`✗ ${label}: missing in destination`);
    fail++;
    continue;
  }
  const norm = async (v: any, apiKey: string, proj: string) => ({
    name: v.name,
    description: v.description ?? "",
    tags: [...(v.tags ?? [])].sort(),
    maintainer: await maintainerOf(apiKey, proj, v.key),
    flags: [...v.flags].sort(),
    segments: v.segments.map((s: any) => `${s.environmentKey}/${s.segmentKey}`).sort(),
  });
  const problems = diff(await norm(src, sourceKey, sourceProj), await norm(dst, destKey, destProj));
  if (problems.length) {
    console.log(`✗ ${label}`);
    problems.forEach((p) => console.log(`    ${p}`));
    fail++;
  } else {
    console.log(`✓ ${label} (${src.flags.length} flags, ${src.segments.length} segments)`);
    pass++;
  }
}

if (saltDiffs.length) {
  console.log(`\n⚠ Percentage rollout rules copied, but bucketing can't be verified (segment salt isn't exposed by the API, so it isn't migrated; contexts may land differently): ${saltDiffs.join(", ")}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);
