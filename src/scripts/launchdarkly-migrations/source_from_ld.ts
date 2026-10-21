import yargs from "https://deno.land/x/yargs@v17.7.2-deno/deno.ts";
import {
  // ensureDir,
  ensureDirSync,
} from "https://deno.land/std@0.149.0/fs/mod.ts";
import {
  consoleLogger,
  ldAPIRequest,
  rateLimitRequest,
  writeSourceData,
} from "../../utils/utils.ts";
import { extractAgentControlResources } from "../../utils/agent_control.ts";
import { Semaphore } from "../../utils/semaphore.ts";
import { getSourceApiKey } from "../../utils/api_keys.ts";
import {
  bigSegmentCsvPath,
  exportBigSegmentCsv,
  isSyncedSegment,
} from "../../utils/big_segments.ts";
import { extractViews } from "../../utils/views.ts";

interface Arguments {
  projKey: string;
  domain?: string;
  extractSegments?: boolean;
  extractAgentControl?: boolean;
  extractBigSegments?: boolean;
  includeArchived?: boolean;
  extractViews?: boolean;
}

const inputArgs: Arguments = yargs(Deno.args)
  .alias("p", "projKey")
  .alias("domain", "domain")
  .describe("domain", "LaunchDarkly domain (default: app.launchdarkly.com)")
  .boolean("extract-segments")
  .default("extract-segments", false)
  .describe(
    "extract-segments",
    "Whether to extract segment data (default: false)",
  )
  .boolean("extract-agent-control")
  .default("extract-agent-control", false)
  .describe(
    "extract-agent-control",
    "Whether to extract AgentControl (AI Configs) data (default: false)",
  )
  .boolean("extract-big-segments")
  .default("extract-big-segments", false)
  .describe(
    "extract-big-segments",
    "Also export members of larger list-based (big) segments as CSV (default: false)",
  )
  .boolean("include-archived")
  .default("include-archived", false)
  .describe(
    "include-archived",
    "Also list archived flags (the API omits them by default) (default: false)",
  )
  .boolean("extract-views")
  .default("extract-views", true)
  .describe(
    "extract-views",
    "Extract views and their linked flags and segments (default: true; --extract-views=false to skip)",
  )
  .parse() as Arguments;

// ensure output directory exists
const projPath =
  `./data/launchdarkly-migrations/source/project/${inputArgs.projKey}`;
ensureDirSync(projPath);

// Get API key
const apiKey = await getSourceApiKey();
const domain = inputArgs.domain || "app.launchdarkly.com";

// Project Data //
const projResp = await rateLimitRequest(
  ldAPIRequest(
    apiKey,
    domain,
    `projects/${inputArgs.projKey}?expand=environments`,
  ),
  "project",
);
if (projResp == null) {
  console.log("Failed getting project");
  Deno.exit(1);
}
if (projResp.status < 200 || projResp.status >= 300) {
  console.log(
    `Failed getting project (${projResp.status}): ${await projResp.text()}`,
  );
  Deno.exit(1);
}
const projData = (await projResp.json()) as Record<string, unknown>;

// Resolve environments: expand may return undefined on some LD instances (e.g. ld-stg)
let allEnvironments: Array<{ key: string; [k: string]: unknown }>;
const expanded = projData.environments as {
  items?: unknown[];
  totalCount?: number;
} | undefined;
if (expanded?.items && Array.isArray(expanded.items)) {
  allEnvironments = expanded.items as Array<
    { key: string; [k: string]: unknown }
  >;
} else {
  // Fallback: fetch from environments endpoint (required when expand returns no environments)
  console.log("Fetching environments from dedicated endpoint...");
  const envPageSize = 100;
  let envOffset = 0;
  allEnvironments = [];
  let hasMore = true;
  while (hasMore) {
    const envResp = await rateLimitRequest(
      ldAPIRequest(
        apiKey,
        domain,
        `projects/${inputArgs.projKey}/environments?limit=${envPageSize}&offset=${envOffset}`,
      ),
      "environments",
    );
    if (envResp == null || envResp.status >= 300) {
      console.log(
        envResp
          ? `Failed getting environments (${envResp.status})`
          : "Failed getting environments",
      );
      Deno.exit(1);
    }
    const envData = (await envResp.json()) as {
      items?: unknown[];
      _links?: { next?: string };
    };
    const items = envData.items ?? [];
    allEnvironments.push(
      ...(items as Array<{ key: string; [k: string]: unknown }>),
    );
    if (envData._links?.next) {
      envOffset += envPageSize;
    } else {
      hasMore = false;
    }
  }
}

// Paginate if expand returned partial list
const totalEnvironments = (expanded?.totalCount as number | undefined) ??
  allEnvironments.length;
if (totalEnvironments > allEnvironments.length && expanded?.items) {
  console.log(`Project has ${totalEnvironments} environments, fetching all...`);
  const envPageSize = 100;
  let envOffset = allEnvironments.length;
  let moreEnvironments = true;
  let envPath =
    `projects/${inputArgs.projKey}/environments?limit=${envPageSize}&offset=${envOffset}`;

  while (moreEnvironments) {
    console.log(
      `Getting additional environments: ${envOffset} to ${
        envOffset + envPageSize
      }`,
    );

    const envResp = await rateLimitRequest(
      ldAPIRequest(apiKey, domain, envPath),
      "environments",
    );
    if (envResp == null || envResp.status >= 300) {
      if (envResp) {
        consoleLogger(
          envResp.status,
          `Error getting environments: ${envResp.status}`,
        );
        consoleLogger(envResp.status, await envResp.text());
      }
      console.log("Failed getting environments");
      Deno.exit(1);
    }
    const envData = (await envResp.json()) as {
      items?: unknown[];
      _links?: { next?: string };
    };
    const items = envData.items ?? [];
    allEnvironments.push(
      ...(items as Array<{ key: string; [k: string]: unknown }>),
    );
    moreEnvironments = !!envData._links?.next;
    if (moreEnvironments) {
      envOffset += envPageSize;
      envPath =
        `projects/${inputArgs.projKey}/environments?limit=${envPageSize}&offset=${envOffset}`;
    }
  }
}

// Ensure project data has environments structure for downstream (migrate expects projectJson.environments.items)
if (!projData.environments || typeof projData.environments !== "object") {
  projData.environments = {
    items: allEnvironments,
    totalCount: allEnvironments.length,
  };
} else {
  (projData.environments as Record<string, unknown>).items = allEnvironments;
  (projData.environments as Record<string, unknown>).totalCount =
    allEnvironments.length;
}

await writeSourceData(projPath, "project", projData);

console.log(`Found ${allEnvironments.length} environments`);

// Segment Data //
if (inputArgs.extractSegments && allEnvironments.length > 0) {
  console.log("\nExtracting segment data...");
  ensureDirSync(`${projPath}/segments`);

  for (const env of allEnvironments) {
    console.log(`Getting segments for environment: ${env.key}`);

    // Paginate through all segments (API returns max 50 per request)
    const segmentPageSize: number = 50;
    let segmentOffset: number = 0;
    let moreSegments: boolean = true;
    const allSegments: any[] = [];
    let segmentPath =
      `segments/${inputArgs.projKey}/${env.key}?limit=${segmentPageSize}&offset=${segmentOffset}`;

    while (moreSegments) {
      const segmentResp = await rateLimitRequest(
        ldAPIRequest(apiKey, domain, segmentPath),
        "segments",
      );

      if (segmentResp.status > 201) {
        consoleLogger(
          segmentResp.status,
          `Error getting segments: ${segmentResp.status}`,
        );
        consoleLogger(segmentResp.status, await segmentResp.text());
      }
      if (segmentResp == null) {
        console.log(`Failed getting segments for environment ${env.key}`);
        break;
      }

      const segmentData = await segmentResp.json();
      const totalCount = segmentData.totalCount || 0;
      const itemsInPage = segmentData.items?.length || 0;

      allSegments.push(...segmentData.items);

      console.log(
        `  Fetched segments ${segmentOffset + 1} to ${
          segmentOffset + itemsInPage
        } of ${totalCount}`,
      );

      // Check if there are more segments to fetch using totalCount
      if (allSegments.length < totalCount) {
        segmentOffset += segmentPageSize;
        segmentPath =
          `segments/${inputArgs.projKey}/${env.key}?limit=${segmentPageSize}&offset=${segmentOffset}`;
      } else {
        moreSegments = false;
      }
    }

    // Save all segments for this environment
    const finalSegmentData = {
      items: allSegments,
      totalCount: allSegments.length,
    };

    await writeSourceData(`${projPath}/segments`, env.key, finalSegmentData);
    console.log(
      `  Found ${allSegments.length} segments for environment: ${env.key}`,
    );

    if (inputArgs.extractBigSegments) {
      for (const segment of allSegments.filter((s) => s.unbounded)) {
        if (isSyncedSegment(segment)) {
          console.log(
            `  Skipping synced segment ${segment.key}: its members come from an external integration, reconnect it in the destination`,
          );
          continue;
        }
        console.log(`  Exporting big segment ${segment.key} (${env.key})...`);
        const csvPath = bigSegmentCsvPath(projPath, env.key, segment.key);
        // Remove any earlier export first, so a failure can't leave a stale snapshot to be imported
        await Deno.remove(csvPath).catch(() => {});
        const result = await exportBigSegmentCsv(
          apiKey,
          domain,
          inputArgs.projKey,
          env.key,
          segment.key,
          csvPath,
        );
        console.log(`    ${result.ok ? "✓" : "✗"} ${result.message}`);
        if (!result.ok) {
          console.log(
            `  Stopping: big segment export was requested but failed for ${segment.key} (${env.key})`,
          );
          Deno.exit(1);
        }
      }
    }
  }
} else if (!inputArgs.extractSegments) {
  console.log("\nSkipping segment extraction (disabled in config)");
}

// AgentControl (AI Configs) Data //
if (inputArgs.extractAgentControl) {
  await extractAgentControlResources({
    apiKey,
    domain,
    projectKey: inputArgs.projKey,
    projPath,
    writeJson: async (filePathWithoutExt, data) => {
      const lastSlash = filePathWithoutExt.lastIndexOf("/");
      const dir = lastSlash >= 0
        ? filePathWithoutExt.slice(0, lastSlash)
        : projPath;
      const fileName = lastSlash >= 0
        ? filePathWithoutExt.slice(lastSlash + 1)
        : filePathWithoutExt;
      await writeSourceData(dir, fileName, data);
    },
    ensureDir: (path) => ensureDirSync(path),
  });
} else {
  console.log("\nSkipping AgentControl extraction (disabled in config)");
}

// Get List of all Flags
// The list endpoint omits archived flags unless asked; a second pass with
// filter=state:archived picks them up when --include-archived is set.
const pageSize: number = 50;

async function listFlagKeys(
  extraQuery: string,
  label: string,
): Promise<string[]> {
  const keys: string[] = [];
  let offset: number = 0;
  let moreFlags: boolean = true;
  let path =
    `flags/${inputArgs.projKey}?summary=true&limit=${pageSize}&offset=${offset}${extraQuery}`;

  while (moreFlags) {
    console.log(
      `Building ${label} flag list: ${offset} to ${offset + pageSize}`,
    );

    const flagsResp = await rateLimitRequest(
      ldAPIRequest(apiKey, domain, path),
      "flags",
    );

    if (flagsResp.status > 201) {
      consoleLogger(
        flagsResp.status,
        `Error getting flags: ${flagsResp.status}`,
      );
      consoleLogger(flagsResp.status, await flagsResp.text());
      console.log("Failed getting Flags");
      Deno.exit(1);
    }

    const flagsData = await flagsResp.json();

    keys.push(...flagsData.items.map((flag: any) => flag.key));

    if (flagsData._links.next) {
      offset += pageSize;
      path =
        `flags/${inputArgs.projKey}?summary=true&limit=${pageSize}&offset=${offset}${extraQuery}`;
    } else {
      moreFlags = false;
    }
  }
  return keys;
}

const flags: string[] = await listFlagKeys("", "live");
if (inputArgs.includeArchived) {
  const archived = await listFlagKeys("&filter=state:archived", "archived");
  console.log(`Found ${archived.length} archived flags`);
  flags.push(...archived.filter((k) => !flags.includes(k)));
}

console.log(`Found ${flags.length} flags`);

await writeSourceData(projPath, "flags", flags);

// Get Individual Flag Data (up to 10 concurrent GETs)
const EXTRACT_GET_CONCURRENCY = 10;
console.log(
  `\nExtracting individual flag data (${flags.length} flags, concurrency ${EXTRACT_GET_CONCURRENCY})...`,
);
ensureDirSync(`${projPath}/flags`);

const requestPermits = new Semaphore(EXTRACT_GET_CONCURRENCY);
await Promise.all(
  flags.entries().map(async ([index, flagKey]) => {
    await using _permit = await requestPermits.acquire();
    console.log(`Getting flag ${index + 1} of ${flags.length}: ${flagKey}`);

    const flagResp = await rateLimitRequest(
      ldAPIRequest(apiKey, domain, `flags/${inputArgs.projKey}/${flagKey}`),
      "flags",
    );
    if (flagResp == null) {
      console.log(`Failed getting flag '${flagKey}'`);
      Deno.exit(1);
    }
    if (flagResp.status > 201) {
      consoleLogger(
        flagResp.status,
        `Error getting flag '${flagKey}': ${flagResp.status}`,
      );
      consoleLogger(flagResp.status, await flagResp.text());
    }

    const flagData = await flagResp.json();
    // Use index-prefixed filenames so flags that differ only by case (e.g. "Flag-one" vs "flag-one")
    // get separate files on case-insensitive filesystems (e.g. macOS default).
    // Format: {index}-{flagKey}.json — keeps files human-browsable.
    await writeSourceData(`${projPath}/flags`, `${index}-${flagKey}`, flagData);
  }),
);

// View Data //
// Flags don't report their views, so view membership is read from the views API.
if (inputArgs.extractViews === false) {
  // Remove an earlier snapshot so a later migrate with views enabled can't pick up stale data
  await Deno.remove(`${projPath}/views.json`).catch(() => {});
  console.log("\nSkipping views extraction (disabled in config)");
} else {
  console.log("\nExtracting views...");
  try {
    const views = await extractViews(apiKey, domain, inputArgs.projKey);
    await writeSourceData(projPath, "views", views);
    if (views.length === 0) {
      console.log(
        "  No views found (if the project uses views, the token needs the viewView action to see them)",
      );
    }
    for (const v of views) {
      console.log(
        `  View ${v.key}: ${v.flags.length} flag(s), ${v.segments.length} segment(s)`,
      );
    }
  } catch (error) {
    await Deno.writeTextFile(`${projPath}/views.json`, "[]");
    console.log(
      `  Warning: could not extract views: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// Record what this extraction covered, so migrate can tell whether the segment files next to the
// flag data come from the same extraction (segment extraction can be disabled, leaving old files).
await writeSourceData(projPath, "extraction", {
  extractedAt: new Date().toISOString(),
  extractSegments: Boolean(inputArgs.extractSegments),
  extractBigSegments: Boolean(inputArgs.extractBigSegments),
  includeArchived: Boolean(inputArgs.includeArchived),
  environments: allEnvironments.map((e: any) => e.key),
  flagCount: flags.length,
});
