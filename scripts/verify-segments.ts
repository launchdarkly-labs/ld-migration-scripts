// deno-lint-ignore-file no-explicit-any
/**
 * Compare segments and views between a source and destination project after a migration.
 *
 * Usage:
 *   deno run --allow-net --allow-read scripts/verify-segments.ts <sourceProj> <destProj> [keyPrefix]
 *     [--source-domain app.launchdarkly.com] [--dest-domain app.eu.launchdarkly.com]
 *     [--env-map prod:production,dev:development]
 *
 * The two projects may live on different instances (e.g. US → EU) and the destination environment
 * keys may differ (--env-map, same format as migrate). With --env-map only the mapped source
 * environments are checked, as in the migration.
 *
 * Regular segments: compares name, description, tags, targets and rules (ignoring ids, versions and dates).
 * Rules with percentage rollouts are listed separately: their bucketing can't be compared via the API.
 * Big segments: checks each key from the extracted CSV is a member in the destination, and compares member counts.
 * Views: compares name, description, tags, maintainer (by email) and linked flags/segments.
 */

import yargs from "https://deno.land/x/yargs@v17.7.2-deno/deno.ts";
import {
  getDestinationApiKey,
  getSourceApiKey,
} from "../src/utils/api_keys.ts";
import {
  bigSegmentCsvPath,
  readExportedKeys,
} from "../src/utils/big_segments.ts";
import { extractViews } from "../src/utils/views.ts";

const USAGE =
  "Usage: verify-segments.ts <sourceProj> <destProj> [keyPrefix] [--source-domain d] [--dest-domain d] [--env-map src:dest,...]";
const argv = yargs(Deno.args)
  .usage(USAGE)
  // Project keys and prefixes are identifiers: "1e3" must stay "1e3", not become 1000
  .parserConfiguration({
    "parse-positional-numbers": false,
    "parse-numbers": false,
  })
  .string("source-domain")
  .describe(
    "source-domain",
    "Source LaunchDarkly domain (default: app.launchdarkly.com)",
  )
  .string("dest-domain")
  .describe(
    "dest-domain",
    "Destination LaunchDarkly domain (default: app.launchdarkly.com)",
  )
  .string("env-map")
  .describe(
    "env-map",
    "Source to destination environment keys, 'src1:dest1,src2:dest2' (as for migrate --env-map)",
  )
  .parse() as {
    _: Array<string | number>;
    sourceDomain?: string;
    destDomain?: string;
    envMap?: string;
  };

const [sourceProj, destProj, keyPrefix = ""] = argv._.map(String);
if (!sourceProj || !destProj) {
  console.error(USAGE);
  Deno.exit(2);
}
const sourceDomain = argv.sourceDomain || "app.launchdarkly.com";
const destDomain = argv.destDomain || "app.launchdarkly.com";
const envMap: Record<string, string> | null = argv.envMap
  ? Object.fromEntries(
    argv.envMap.split(",").map((p) => p.trim()).filter(Boolean).map((pair) => {
      const [src, dst] = pair.split(":").map((s) => s.trim());
      if (!src || !dst) {
        console.error(
          `Invalid --env-map entry "${pair}"; expected source:dest`,
        );
        Deno.exit(2);
      }
      return [src, dst];
    }),
  )
  : null;
const destEnvOf = (env: string): string => (envMap ? envMap[env] : env);

const sourceKey = await getSourceApiKey();
const destKey = await getDestinationApiKey();

async function get(
  apiKey: string,
  domain: string,
  path: string,
): Promise<{ status: number; body: any }> {
  const resp = await fetch(`https://${domain}/api/v2/${path}`, {
    headers: { Authorization: apiKey },
  });
  return {
    status: resp.status,
    body: resp.status === 200 ? await resp.json() : await resp.text(),
  };
}

/** Reads every page of a list endpoint; throws if a page can't be read, so nothing is silently skipped. */
async function listAll(
  apiKey: string,
  domain: string,
  path: string,
): Promise<any[]> {
  const items: any[] = [];
  for (let offset = 0;; offset += 50) {
    const { status, body } = await get(
      apiKey,
      domain,
      `${path}${path.includes("?") ? "&" : "?"}limit=50&offset=${offset}`,
    );
    if (status !== 200) {
      throw new Error(
        `GET ${domain} ${path} (offset ${offset}) failed: HTTP ${status}`,
      );
    }
    items.push(...body.items);
    if (items.length >= body.totalCount || body.items.length === 0) {
      return items;
    }
  }
}

const listSegments = (
  apiKey: string,
  domain: string,
  proj: string,
  env: string,
) => listAll(apiKey, domain, `segments/${proj}/${env}`);

const sortBy = (arr: any[] = [], f: (x: any) => string) =>
  [...arr].sort((a, b) => f(a).localeCompare(f(b)));

function normalize(seg: any) {
  return {
    name: seg.name,
    description: seg.description ?? "",
    tags: [...(seg.tags ?? [])].sort(),
    unbounded: seg.unbounded ?? false,
    unboundedContextKind: seg.unbounded ? seg.unboundedContextKind : undefined,
    included: [...(seg.included ?? [])].sort(),
    excluded: [...(seg.excluded ?? [])].sort(),
    includedContexts: sortBy(seg.includedContexts, (c) => c.contextKind).map((
      c,
    ) => ({ contextKind: c.contextKind, values: [...c.values].sort() })),
    excludedContexts: sortBy(seg.excludedContexts, (c) => c.contextKind).map((
      c,
    ) => ({ contextKind: c.contextKind, values: [...c.values].sort() })),
    rules: (seg.rules ?? []).map((r: any) => ({
      description: r.description ?? "",
      weight: r.weight ?? null,
      bucketBy: r.bucketBy ?? null,
      rolloutContextKind: r.rolloutContextKind ?? null,
      clauses: r.clauses.map((c: any) => ({
        contextKind: c.contextKind,
        attribute: c.attribute,
        op: c.op,
        negate: c.negate ?? false,
        values: c.values,
      })),
    })),
  };
}

function diff(a: any, b: any, path = ""): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (
    typeof a !== "object" || typeof b !== "object" || a === null ||
    b === null || Array.isArray(a) !== Array.isArray(b)
  ) {
    return [
      `${path || "(root)"}: source=${JSON.stringify(a)} dest=${
        JSON.stringify(b)
      }`,
    ];
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => diff(a[k], b[k], path ? `${path}.${k}` : k));
}

// The expanded project response can hold only the first page of environments, so list them directly
let sourceEnvs = (await listAll(
  sourceKey,
  sourceDomain,
  `projects/${sourceProj}/environments`,
)).map((e: any) => e.key);
if (envMap) {
  const unknown = Object.keys(envMap).filter((e) => !sourceEnvs.includes(e));
  if (unknown.length) {
    console.log(
      `⚠ --env-map names source environments that do not exist in ${sourceProj}: ${
        unknown.join(", ")
      }`,
    );
  }
  sourceEnvs = sourceEnvs.filter((e: string) => Object.hasOwn(envMap, e));
  if (sourceEnvs.length === 0) {
    // Otherwise a project without views would report "0 passed, 0 failed" and exit 0 having checked nothing
    console.error(
      `✗ None of the --env-map source environments exist in ${sourceProj}; nothing to verify`,
    );
    Deno.exit(2);
  }
  console.log(
    `Checking ${sourceEnvs.length} mapped environment(s): ${
      sourceEnvs.map((e: string) => `${e}→${envMap[e]}`).join(", ")
    }`,
  );
}
let pass = 0, fail = 0;
const saltDiffs: string[] = [];

for (const env of sourceEnvs) {
  const destEnv = destEnvOf(env);
  const envLabel = envMap ? `${env}→${destEnv}` : env;
  const segments =
    (await listSegments(sourceKey, sourceDomain, sourceProj, env)).filter((s) =>
      s.key.startsWith(keyPrefix)
    );
  for (const listed of segments) {
    const label = `${envLabel}/${listed.key}`;
    const { body: src } = await get(
      sourceKey,
      sourceDomain,
      `segments/${sourceProj}/${env}/${listed.key}`,
    );
    const dst = await get(
      destKey,
      destDomain,
      `segments/${destProj}/${destEnv}/${listed.key}`,
    );
    if (dst.status !== 200) {
      console.log(`✗ ${label}: missing in destination (HTTP ${dst.status})`);
      fail++;
      continue;
    }
    const problems = diff(normalize(src), normalize(dst.body));

    if (src.unbounded) {
      // Exports are written under the source environment key
      const csvPath = bigSegmentCsvPath(
        `./data/launchdarkly-migrations/source/project/${sourceProj}`,
        env,
        listed.key,
      );
      const csv = await Deno.readTextFile(csvPath).catch(() => null);
      if (csv === null) {
        problems.push(
          `no extracted CSV at ${csvPath} to check membership against`,
        );
      } else {
        const keys = readExportedKeys(csv);
        const missing: string[] = [];
        for (const k of keys) {
          const m = await get(
            destKey,
            destDomain,
            `segments/${destProj}/${destEnv}/${listed.key}/contexts/${
              encodeURIComponent(k)
            }`,
          );
          if (m.status !== 200 || m.body.included !== true) missing.push(k);
        }
        if (missing.length) {
          problems.push(
            `${missing.length}/${keys.length} members missing in destination: ${
              JSON.stringify(missing)
            }`,
          );
        }
        // Per-key checks can't see extra destination members, so also compare member counts
        const srcCount = src._unboundedMetadata?.includedCount;
        const dstCount = dst.body._unboundedMetadata?.includedCount;
        if (srcCount !== undefined && srcCount !== keys.length) {
          problems.push(
            `extracted CSV has ${keys.length} members but the source now has ${srcCount}; re-extract`,
          );
        }
        if (dstCount === undefined) {
          problems.push("destination member count unavailable");
        } else if (dstCount !== (srcCount ?? keys.length)) {
          problems.push(
            `destination has ${dstCount} members, source has ${
              srcCount ?? keys.length
            }`,
          );
        }
        if (!problems.length) {
          console.log(
            `  ${label}: ${keys.length}/${keys.length} big segment members present, counts match`,
          );
        }
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
async function viewDetails(
  apiKey: string,
  domain: string,
  proj: string,
): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (const v of await extractViews(apiKey, domain, proj)) {
    if (v.key.startsWith(keyPrefix)) out.set(v.key, { view: v });
  }
  return out;
}
async function maintainerOf(
  apiKey: string,
  domain: string,
  proj: string,
  viewKey: string,
): Promise<string | null> {
  const resp = await fetch(
    `https://${domain}/api/v2/projects/${proj}/views/${viewKey}`,
    {
      headers: { Authorization: apiKey, "LD-API-Version": "beta" },
    },
  );
  if (resp.status !== 200) return `HTTP ${resp.status}`;
  const m = (await resp.json()).maintainer;
  return m?.maintainerMember?.email ??
    (m?.maintainerTeam?.key ? `team:${m.maintainerTeam.key}` : null);
}

const sourceViews = await viewDetails(sourceKey, sourceDomain, sourceProj)
  .catch((e) => {
    console.log(`✗ could not read source views: ${e.message}`);
    fail++;
    return new Map<string, any>();
  });
const destViews = await viewDetails(destKey, destDomain, destProj).catch(
  (e) => {
    console.log(`✗ could not read destination views: ${e.message}`);
    fail++;
    return new Map<string, any>();
  },
);
for (const [key, { view: src }] of sourceViews) {
  const label = `view/${key}`;
  const dst = destViews.get(key)?.view;
  if (!dst) {
    console.log(`✗ ${label}: missing in destination`);
    fail++;
    continue;
  }
  // Source segment links are expressed in destination environment keys; unmapped environments were not migrated
  const norm = async (
    v: any,
    apiKey: string,
    domain: string,
    proj: string,
    mapEnvs: boolean,
  ) => ({
    name: v.name,
    description: v.description ?? "",
    tags: [...(v.tags ?? [])].sort(),
    maintainer: await maintainerOf(apiKey, domain, proj, v.key),
    flags: [...v.flags].sort(),
    // Deduplicated: two source environments mapped to one destination environment yield one link there
    segments: [
      ...new Set<string>(
        v.segments
          .filter((s: any) =>
            !mapEnvs || !envMap || Object.hasOwn(envMap, s.environmentKey)
          )
          .map((s: any) =>
            `${
              mapEnvs ? destEnvOf(s.environmentKey) : s.environmentKey
            }/${s.segmentKey}`
          ),
      ),
    ]
      .sort(),
  });
  const problems = diff(
    await norm(src, sourceKey, sourceDomain, sourceProj, true),
    await norm(dst, destKey, destDomain, destProj, false),
  );
  if (problems.length) {
    console.log(`✗ ${label}`);
    problems.forEach((p) => console.log(`    ${p}`));
    fail++;
  } else {
    console.log(
      `✓ ${label} (${src.flags.length} flags, ${src.segments.length} segments)`,
    );
    pass++;
  }
}

if (saltDiffs.length) {
  console.log(
    `\n⚠ Percentage rollout rules copied, but bucketing can't be verified (segment salt isn't exposed by the API, so it isn't migrated; contexts may land differently): ${
      saltDiffs.join(", ")
    }`,
  );
}
console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);
