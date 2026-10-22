// deno-lint-ignore-file no-explicit-any
import yargs from "https://deno.land/x/yargs@v17.7.2-deno/deno.ts";
import {
  applyConflictPrefix,
  buildPatch,
  buildRulesReplace,
  checkViewExists,
  ConflictTracker,
  consoleLogger,
  createView,
  getJson,
  ldAPIPatchRequest,
  ldAPIPostRequest,
  ldAPIPutRequest,
  ldAPIRequest,
  rateLimitRequest,
  type Rule,
  sha256HexUtf8,
  stripRulesReferencingSegment,
  unknownSegmentFromError,
  type View,
  // delay
} from "../../utils/utils.ts";
import * as Colors from "https://deno.land/std@0.149.0/fmt/colors.ts";
import { parse as parseYaml } from "https://deno.land/std@0.224.0/yaml/parse.ts";
import { getDestinationApiKey } from "../../utils/api_keys.ts";
import { resolveDestinationProjectName } from "../../utils/workflow_config.ts";
import { mergeTags } from "../../utils/tags.ts";
import {
  abortMarker,
  adoptUnresolved,
  type DestinationIdentity,
  emptyRecord,
  legacySegmentEntries,
  markerAfterRun,
  ownedKeys,
  ownEntry,
  readSyncManifest,
  recordedDestination,
  type RunOutcome,
  segmentEnvironmentMismatches,
  stampIdentity,
  type SyncManifest,
  type SyncManifestEnv,
  type SyncManifestFlag,
  syncManifestPath as syncManifestPathFor,
  type SyncManifestSegment,
  withExtraDestKeys,
} from "../../utils/sync_manifest.ts";
import { classifyVanishedFlags } from "../../utils/archived_propagation.ts";
import {
  bigSegmentCsvPath,
  readExportedKeys,
} from "../../utils/big_segments.ts";
import { getAccountId } from "../../utils/account_guard.ts";
import { linkToView, type SourceView } from "../../utils/views.ts";

interface Arguments {
  projKeySource: string;
  projKeyDest: string;
  destProjectName?: string;
  assignMaintainerIds: boolean;
  migrateSegments: boolean;
  migrateBigSegments?: boolean;
  conflictPrefix?: string;
  tags?: string;
  onConflict?: string;
  targetView?: string;
  environments?: string;
  envMap?: string;
  domain?: string;
  config?: string;
  dryRun?: boolean;
  incremental?: boolean;
  since?: string;
  includeFlags?: string;
  excludeFlags?: string;
  concurrency?: number;
  createProject?: boolean;
  createEnvironments?: boolean;
  migrateViews?: boolean;
  adoptUnresolved?: boolean;
  propagateArchived?: boolean;
}

// Sync manifest types and path live in utils/sync_manifest.ts, shared with the revert tool

interface MigrationConfig {
  source: {
    projectKey: string;
    domain?: string;
  };
  destination: {
    projectKey: string;
    projectName?: string;
    domain?: string;
  };
  options?: {
    assignMaintainerIds?: boolean;
    migrateSegments?: boolean;
    tags?: string[] | null;
    migrateBigSegments?: boolean;
    conflictPrefix?: string;
    onConflict?: string;
    targetView?: string;
    environments?: string[];
    environmentMapping?: Record<string, string>;
    dryRun?: boolean;
    incremental?: boolean;
    since?: string;
    includeFlags?: string[];
    excludeFlags?: string[];
    concurrency?: number;
    createProject?: boolean;
    createEnvironments?: boolean;
    migrateViews?: boolean;
    adoptUnresolved?: boolean;
    propagateArchived?: boolean;
  };
  /** Alias for options — YAML configs may use migration: instead of options: */
  migration?: MigrationConfig["options"];
}

// ==================== Dry Run Helpers ====================

/**
 * Simulates an API POST request in dry-run mode
 */
function simulatePostRequest(resource: string, _data: any): Response {
  console.log(Colors.gray(`    [DRY RUN] Would POST to ${resource}`));
  return new Response(JSON.stringify({ success: true, _id: "dry-run-id" }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Simulates an API PATCH request in dry-run mode
 */
function simulatePatchRequest(
  resource: string,
  patches: any[],
  context?: string,
): Response {
  if (context) {
    console.log(
      Colors.gray(
        `    [DRY RUN] Would PATCH ${resource} for ${context} with ${patches.length} operation(s)`,
      ),
    );
  } else {
    console.log(
      Colors.gray(
        `    [DRY RUN] Would PATCH ${resource} with ${patches.length} operation(s)`,
      ),
    );
  }
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Wraps POST requests with dry-run support
 */
async function dryRunAwarePost(
  dryRun: boolean,
  apiKey: string,
  domain: string,
  path: string,
  body: any,
  useBeta = false,
  rateLimit: string = "default",
): Promise<Response> {
  if (dryRun) {
    return simulatePostRequest(path, body);
  }
  return await rateLimitRequest(
    ldAPIPostRequest(apiKey, domain, path, body, useBeta),
    rateLimit,
  );
}

// LD caps segment patches at 1500 target operations per request ("Total
// number of operations on targets must not exceed batch limit of 1500"),
// counting every target value in a replace. Oversized target lists are
// split: the initial replace carries at most this many values and the
// remainder is appended in follow-up patches.
const SEGMENT_TARGET_BATCH_LIMIT = 1500;

/**
 * Wraps PATCH requests with dry-run support
 */
async function dryRunAwarePatch(
  dryRun: boolean,
  apiKey: string,
  domain: string,
  path: string,
  patches: any[],
  _useBeta = false, // Not currently supported by ldAPIPatchRequest
  rateLimit: string = "default",
  context?: string, // Optional context for better dry-run logging (e.g., environment name)
): Promise<Response> {
  if (dryRun) {
    return simulatePatchRequest(path, patches, context);
  }
  return await rateLimitRequest(
    ldAPIPatchRequest(apiKey, domain, path, patches),
    rateLimit,
  );
}

// ==================== Project Helpers ====================

// Returns the raw HTTP status so callers can distinguish a missing project
// (404) from an auth failure (401/403) — the two need very different messages.
async function getProjectStatus(
  apiKey: string,
  domain: string,
  projectKey: string,
): Promise<number> {
  const req = ldAPIRequest(apiKey, domain, `projects/${projectKey}`);
  const response = await rateLimitRequest(req, "projects");
  return response.status;
}

// Add function to get existing project environments
async function getExistingEnvironments(
  apiKey: string,
  domain: string,
  projectKey: string,
): Promise<string[]> {
  const req = ldAPIRequest(
    apiKey,
    domain,
    `projects/${projectKey}/environments`,
  );
  const response = await rateLimitRequest(req, "environments");
  if (response.status === 200) {
    const data = await response.json();
    return data.items.map((env: any) => env.key);
  }
  return [];
}

/**
 * Creates the destination project, including the given environments.
 * Returns true if the project was created (or simulated in dry-run) or already exists.
 */
async function createProjectOnDestination(
  dryRun: boolean,
  apiKey: string,
  domain: string,
  projectKey: string,
  projectName: string,
  environments: Record<string, unknown>[],
): Promise<boolean> {
  const envList = environments.map((e) => e.key).join(", ") || "none";
  if (dryRun) {
    console.log(
      Colors.yellow(
        `  [DRY RUN] Would create project "${projectKey}" ("${projectName}") with environments: ${envList}`,
      ),
    );
    return true;
  }
  console.log(
    Colors.blue(
      `  Creating project "${projectKey}" ("${projectName}") with environments: ${envList}...`,
    ),
  );
  const body: Record<string, unknown> = { name: projectName, key: projectKey };
  if (environments.length > 0) body.environments = environments;
  // Not "projects": rateLimitRequest exits on a 409 for that category, and 409 here means it already exists
  const resp = await rateLimitRequest(
    ldAPIPostRequest(apiKey, domain, "projects", body),
    "projects-create",
  );
  if (resp.status >= 200 && resp.status < 300) {
    console.log(Colors.green(`  ✓ Created project "${projectKey}"`));
    return true;
  }
  if (resp.status === 409) {
    console.log(Colors.gray(`  Project "${projectKey}" already exists`));
    return true;
  }
  console.log(
    Colors.red(
      `  ✗ Failed to create project (${resp.status}): ${await resp.text()}`,
    ),
  );
  return false;
}

/**
 * Creates one environment in the destination project.
 * Returns true if created (or simulated in dry-run) or it already exists.
 */
async function createEnvironmentOnDestination(
  dryRun: boolean,
  apiKey: string,
  domain: string,
  projectKey: string,
  env: Record<string, unknown>,
): Promise<boolean> {
  if (dryRun) {
    console.log(
      Colors.yellow(
        `  [DRY RUN] Would create environment "${env.key}" in project "${projectKey}"`,
      ),
    );
    return true;
  }
  console.log(Colors.blue(`  Creating environment "${env.key}"...`));
  const resp = await rateLimitRequest(
    ldAPIPostRequest(
      apiKey,
      domain,
      `projects/${projectKey}/environments`,
      env,
    ),
    "environments",
  );
  if (resp.status >= 200 && resp.status < 300) {
    console.log(Colors.green(`  ✓ Created environment "${env.key}"`));
    return true;
  }
  if (resp.status === 409) {
    console.log(Colors.gray(`  Environment "${env.key}" already exists`));
    return true;
  }
  console.log(
    Colors.red(
      `  ✗ Failed to create environment "${env.key}" (${resp.status}): ${await resp
        .text()}`,
    ),
  );
  return false;
}

const cliArgs: Arguments = (yargs(Deno.args)
  .alias("p", "projKeySource")
  .alias("d", "projKeyDest")
  .alias("m", "assignMaintainerIds")
  .alias("s", "migrateSegments")
  .alias("c", "conflictPrefix")
  .string("tags")
  .alias("on-conflict", "onConflict")
  .choices("on-conflict", ["prompt", "skip", "overwrite", "prefix", "abort"])
  .alias("v", "targetView")
  .alias("e", "environments")
  .alias("env-map", "envMap")
  .alias("domain", "domain")
  .alias("f", "config")
  .alias("dry-run", "dryRun")
  .alias("i", "incremental")
  .alias("since", "since")
  .alias("include-flags", "includeFlags")
  .alias("exclude-flags", "excludeFlags")
  .alias("concurrency", "concurrency")
  .alias("migrate-big-segments", "migrateBigSegments")
  .boolean("migrate-big-segments")
  .default("migrate-big-segments", undefined)
  .describe(
    "migrate-big-segments",
    "Import big segment members from CSVs exported during extraction (extract with --extract-big-segments)",
  )
  .number("concurrency")
  .default("concurrency", 10)
  .alias("create-project", "createProject")
  .alias("create-environments", "createEnvironments")
  .alias("adopt-unresolved", "adoptUnresolved")
  .boolean("adopt-unresolved")
  .default("adopt-unresolved", undefined)
  .describe(
    "adopt-unresolved",
    "Record the destination resources an incomplete sync manifest lists as untracked as this migration's copies (after verifying by hand that the aborted run created them)",
  )
  .alias("propagate-archived", "propagateArchived")
  .boolean("propagate-archived")
  .default("propagate-archived", undefined)
  .describe(
    "propagate-archived",
    "Archive the destination copy of a recorded flag that was archived in the source since it was migrated (default: true; --propagate-archived=false to skip)",
  )
  .alias("migrate-views", "migrateViews")
  .boolean("migrate-views")
  .default("migrate-views", undefined)
  .describe(
    "migrate-views",
    "Recreate the source project's views and link flags and segments to them (default: true; --migrate-views=false to skip)",
  )
  .alias("dest-project-name", "destProjectName")
  .string("dest-project-name")
  .boolean("m")
  .boolean("s")
  .boolean("dry-run")
  .boolean("incremental")
  .boolean("create-project")
  .boolean("create-environments")
  .default("m", false)
  .default("s", true)
  .describe(
    "c",
    "Prefix to use when resolving key conflicts (e.g., 'imported-')",
  )
  .describe(
    "tags",
    "Comma-separated tags to add to migrated flags and segments",
  )
  .describe(
    "on-conflict",
    "What to do when a flag/segment key already exists and is not a copy recorded in the sync manifest (recorded copies are always updated): prompt (interactive), skip, overwrite (default), prefix (requires -c), abort",
  )
  .describe("v", "View key to link all migrated flags to")
  .describe(
    "e",
    "Comma-separated list of environment keys to migrate (e.g., 'production,staging')",
  )
  .describe(
    "env-map",
    "Environment mapping in format 'source1:dest1,source2:dest2' (e.g., 'prod:production,dev:development')",
  )
  .describe(
    "domain",
    "Destination LaunchDarkly domain (default: app.launchdarkly.com)",
  )
  .describe(
    "f",
    "Path to YAML config file. CLI arguments override config file values.",
  )
  .describe("dry-run", "Preview migration without making any changes")
  .describe(
    "incremental",
    "Skip flags unchanged since last sync (version-based)",
  )
  .describe(
    "since",
    "Only sync flags modified after this date (ISO 8601, e.g. 2026-01-15)",
  )
  .describe(
    "include-flags",
    "Comma-separated list of flag keys to migrate (only these flags)",
  )
  .describe(
    "exclude-flags",
    "Comma-separated list of flag keys to exclude from migration",
  )
  .describe(
    "concurrency",
    "Max number of flags to migrate in parallel (default: 10)",
  )
  .describe(
    "create-project",
    "Create the destination project if it doesn't exist, with the migrated environments",
  )
  .describe(
    "dest-project-name",
    "Name for a project created by --create-project (default: destination key if it differs from the source key, else the source project name)",
  )
  .describe(
    "create-environments",
    "Create environments missing from the destination project using source environment settings",
  )
  .parse() as unknown) as Arguments;

// Load and merge config file if provided
let inputArgs = cliArgs;
if (cliArgs.config) {
  console.log(Colors.cyan(`Loading configuration from: ${cliArgs.config}`));
  try {
    const configContent = await Deno.readTextFile(cliArgs.config);
    const config = parseYaml(configContent) as MigrationConfig;
    const opts = config.options ?? config.migration;

    // Merge config file with CLI args (CLI args take precedence)
    inputArgs = {
      projKeySource: cliArgs.projKeySource || config.source.projectKey,
      projKeyDest: cliArgs.projKeyDest || config.destination.projectKey,
      destProjectName: cliArgs.destProjectName ||
        config.destination?.projectName,
      assignMaintainerIds: cliArgs.assignMaintainerIds !== undefined &&
          cliArgs.assignMaintainerIds !== false
        ? cliArgs.assignMaintainerIds
        : opts?.assignMaintainerIds ?? false,
      migrateSegments: cliArgs.migrateSegments !== undefined &&
          cliArgs.migrateSegments !== true
        ? cliArgs.migrateSegments
        : opts?.migrateSegments ?? true,
      migrateBigSegments: cliArgs.migrateBigSegments ??
        opts?.migrateBigSegments ?? false,
      conflictPrefix: cliArgs.conflictPrefix || opts?.conflictPrefix,
      tags: cliArgs.tags ??
        (opts?.tags?.length ? opts.tags.join(",") : undefined),
      onConflict: cliArgs.onConflict || opts?.onConflict,
      targetView: cliArgs.targetView || opts?.targetView,
      environments: cliArgs.environments || opts?.environments?.join(","),
      envMap: cliArgs.envMap ||
        (opts?.environmentMapping
          ? Object.entries(opts.environmentMapping).map(([k, v]) => `${k}:${v}`)
            .join(",")
          : undefined),
      domain: cliArgs.domain || config.destination?.domain,
      dryRun: cliArgs.dryRun ?? opts?.dryRun ?? false,
      incremental: cliArgs.incremental ?? opts?.incremental ?? false,
      since: cliArgs.since || opts?.since,
      includeFlags: cliArgs.includeFlags ??
        (opts?.includeFlags?.length ? opts.includeFlags.join(",") : undefined),
      excludeFlags: cliArgs.excludeFlags ??
        (opts?.excludeFlags?.length ? opts.excludeFlags.join(",") : undefined),
      concurrency: cliArgs.concurrency ?? opts?.concurrency ?? 10,
      createProject: cliArgs.createProject ?? opts?.createProject ?? false,
      createEnvironments: cliArgs.createEnvironments ??
        opts?.createEnvironments ?? false,
      migrateViews: cliArgs.migrateViews ?? opts?.migrateViews ?? true,
      adoptUnresolved: cliArgs.adoptUnresolved ?? opts?.adoptUnresolved ??
        false,
      propagateArchived: cliArgs.propagateArchived ??
        opts?.propagateArchived ?? true,
      config: cliArgs.config,
    };

    console.log(Colors.green(`✓ Configuration loaded successfully\n`));
  } catch (error) {
    console.log(
      Colors.red(
        `Error loading config file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
    Deno.exit(1);
  }
}

const migrationTags = inputArgs.tags
  ?.split(",")
  .map((tag) => tag.trim())
  .filter(Boolean) ?? [];
// Views are migrated unless opted out; --target-view links are created either way
const migrateViews = inputArgs.migrateViews ?? true;
// A recorded flag archived in the source since it was migrated is archived in the destination unless opted out
const propagateArchived = inputArgs.propagateArchived ?? true;

console.log(Colors.blue("\n=== Migration Script Starting ==="));
console.log(
  Colors.gray(`Source Project: ${cliArgs.projKeySource || "(from config)"}`),
);
console.log(
  Colors.gray(`Destination Project: ${cliArgs.projKeyDest || "(from config)"}`),
);

// Validate required arguments
if (!inputArgs.projKeySource || !inputArgs.projKeyDest) {
  console.log(
    Colors.red(
      `Error: Both source project (-p) and destination project (-d) are required.`,
    ),
  );
  console.log(Colors.yellow(`Provide them via CLI arguments or config file.`));
  Deno.exit(1);
}

console.log(Colors.blue("\n📋 Configuration Summary:"));
console.log(Colors.gray(`  Source: ${inputArgs.projKeySource}`));
console.log(Colors.gray(`  Destination: ${inputArgs.projKeyDest}`));
console.log(
  Colors.gray(`  Assign Maintainers: ${inputArgs.assignMaintainerIds}`),
);
console.log(Colors.gray(`  Migrate Segments: ${inputArgs.migrateSegments}`));
console.log(
  Colors.gray(
    `  Migrate Big Segment Members: ${inputArgs.migrateBigSegments || false}`,
  ),
);
console.log(
  Colors.gray(`  Conflict Prefix: ${inputArgs.conflictPrefix || "none"}`),
);
console.log(
  Colors.gray(
    `  On Conflict: ${
      inputArgs.onConflict ||
      (inputArgs.conflictPrefix ? "prefix" : "overwrite")
    }`,
  ),
);
console.log(Colors.gray(`  Target View: ${inputArgs.targetView || "none"}`));
console.log(Colors.gray(`  Migrate Views: ${migrateViews}`));
console.log(Colors.gray(`  Propagate Archived: ${propagateArchived}`));
console.log(
  Colors.gray(`  Adopt Unresolved: ${inputArgs.adoptUnresolved || false}`),
);
console.log(
  Colors.gray(
    `  Tags: ${migrationTags.length > 0 ? migrationTags.join(", ") : "none"}`,
  ),
);
console.log(Colors.gray(`  Environments: ${inputArgs.environments || "all"}`));
console.log(Colors.gray(`  Env Mapping: ${inputArgs.envMap || "none"}`));
console.log(
  Colors.gray(`  Domain: ${inputArgs.domain || "app.launchdarkly.com"}`),
);
console.log(Colors.gray(`  Dry Run: ${inputArgs.dryRun || false}`));
console.log(Colors.gray(`  Incremental: ${inputArgs.incremental || false}`));
console.log(Colors.gray(`  Since: ${inputArgs.since || "none"}`));
console.log(Colors.gray(`  Include Flags: ${inputArgs.includeFlags || "all"}`));
console.log(
  Colors.gray(`  Exclude Flags: ${inputArgs.excludeFlags || "none"}`),
);
console.log(Colors.gray(`  Concurrency: ${inputArgs.concurrency ?? 10}`));
console.log(
  Colors.gray(`  Create Project: ${inputArgs.createProject || false}`),
);
console.log(
  Colors.gray(`  Dest Project Name: ${inputArgs.destProjectName || "default"}`),
);
console.log(
  Colors.gray(
    `  Create Environments: ${inputArgs.createEnvironments || false}`,
  ),
);

// Validate --incremental and --since are mutually exclusive
if (inputArgs.incremental && inputArgs.since) {
  console.log(
    Colors.red(
      `Error: --incremental and --since are mutually exclusive. Use one or the other.`,
    ),
  );
  Deno.exit(1);
}

if (inputArgs.dryRun) {
  console.log(Colors.yellow("\n⚠️  DRY RUN MODE - No changes will be made"));
  console.log(Colors.yellow("All API write operations will be simulated\n"));
}

// Get destination API key
console.log(Colors.blue("\n🔑 Loading API key from config..."));
const apiKey = await getDestinationApiKey();
console.log(Colors.green("✓ API key loaded"));

const domain = inputArgs.domain || "app.launchdarkly.com";
console.log(Colors.gray(`Using domain: ${domain}\n`));

// Get current authenticated member ID for approval request fallback
let currentMemberId: string | null = null;
try {
  const memberReq = ldAPIRequest(apiKey, domain, "members/me");
  const memberResp = await rateLimitRequest(memberReq, "members");
  if (memberResp.status === 200) {
    const memberData = await memberResp.json();
    currentMemberId = memberData._id;
    console.log(
      Colors.gray(
        `Authenticated as member: ${memberData.email || currentMemberId}`,
      ),
    );
  } else if (memberResp.status === 401) {
    // Fail fast: an invalid key would otherwise surface as a misleading
    // "project does not exist" once we hit the projects endpoint below.
    console.log(Colors.red(`\n❌ Destination API key is invalid (HTTP 401).`));
    console.log(
      Colors.yellow(
        `   Update "destination_account_api_key" in config/api_keys.json.`,
      ),
    );
    Deno.exit(1);
  } else {
    console.log(
      Colors.gray(
        `Authenticated with service token (approval requests may not notify anyone)`,
      ),
    );
  }
} catch {
  console.log(Colors.gray(`Could not determine authenticated user type`));
}

// Parse environment mapping
const envMapping: Record<string, string> = {};
const reverseEnvMapping: Record<string, string> = {};
if (inputArgs.envMap) {
  const mappings = inputArgs.envMap.split(",").map((m) => m.trim());
  for (const mapping of mappings) {
    const [source, dest] = mapping.split(":").map((s) => s.trim());
    if (!source || !dest) {
      console.log(
        Colors.red(`Error: Invalid environment mapping format: "${mapping}"`),
      );
      console.log(
        Colors.red(`Expected format: "source:dest" (e.g., "prod:production")`),
      );
      Deno.exit(1);
    }
    envMapping[source] = dest;
    if (!Object.hasOwn(reverseEnvMapping, dest)) {
      reverseEnvMapping[dest] = source; // first-wins for many-to-one maps
    }
  }

  console.log(Colors.cyan(`\n=== Environment Mapping ===`));
  console.log("Source → Destination:");
  Object.entries(envMapping).forEach(([src, dst]) => {
    console.log(`  ${src} → ${dst}`);
  });
  console.log();
}

// Initialize conflict tracker
const conflictTracker = new ConflictTracker();
if (inputArgs.conflictPrefix) {
  console.log(
    Colors.cyan(`Conflict prefix enabled: "${inputArgs.conflictPrefix}"`),
  );
  console.log(
    Colors.cyan(
      `Resources with conflicting keys will be created with this prefix.`,
    ),
  );
}

// ==================== Conflict Resolution Strategy ====================

type ConflictAction = "overwrite" | "skip" | "prefix" | "abort";

// Default preserves historical behavior: prefix when -c is set, else overwrite.
const onConflictMode: string = inputArgs.onConflict ??
  (inputArgs.conflictPrefix ? "prefix" : "overwrite");

if (onConflictMode === "prefix" && !inputArgs.conflictPrefix) {
  console.log(
    Colors.red(`Error: --on-conflict prefix requires a conflict prefix (-c).`),
  );
  Deno.exit(1);
}

// Remembered "apply to all" answer from interactive prompting.
let rememberedConflictAction: ConflictAction | null = null;
// Serializes prompts so concurrent flag processing doesn't interleave questions.
let promptLock: Promise<unknown> = Promise.resolve();

/**
 * Decides what to do with an existing destination resource, according to
 * --on-conflict. In prompt mode, asks interactively (with "apply to all"
 * options); outside a TTY or in dry-run mode, prompt falls back to overwrite.
 */
async function resolveConflictAction(
  resourceType: "flag" | "segment",
  key: string,
): Promise<ConflictAction> {
  if (onConflictMode !== "prompt") return onConflictMode as ConflictAction;
  if (rememberedConflictAction) return rememberedConflictAction;

  if (inputArgs.dryRun) {
    console.log(
      Colors.gray(
        `    [DRY RUN] ${resourceType} "${key}" exists — would prompt (treating as overwrite)`,
      ),
    );
    return "overwrite";
  }
  if (!Deno.stdin.isTerminal()) {
    console.log(
      Colors.yellow(
        `  ⚠ ${resourceType} "${key}" exists; not a TTY, defaulting to overwrite`,
      ),
    );
    return "overwrite";
  }

  const ask = (): ConflictAction => {
    const prefixChoices = inputArgs.conflictPrefix
      ? ", [p]refix, [P] prefix all"
      : "";
    while (true) {
      const answer = prompt(
        Colors.yellow(
          `  ⚠ ${resourceType} "${key}" already exists. ` +
            `[o]verwrite, [s]kip, [a]bort, [O] overwrite all, [S] skip all${prefixChoices}:`,
        ),
      );
      switch (answer) {
        case "o":
          return "overwrite";
        case "s":
          return "skip";
        case "a":
          return "abort";
        case "O":
          rememberedConflictAction = "overwrite";
          return "overwrite";
        case "S":
          rememberedConflictAction = "skip";
          return "skip";
        case "p":
          if (inputArgs.conflictPrefix) return "prefix";
          break;
        case "P":
          if (inputArgs.conflictPrefix) {
            rememberedConflictAction = "prefix";
            return "prefix";
          }
          break;
      }
      console.log(Colors.gray(`    Unrecognized answer "${answer}"`));
    }
  };

  const result = promptLock.then(() => rememberedConflictAction ?? ask());
  promptLock = result.catch(() => {});
  return await result;
}

// --on-conflict abort: set by the worker that met the conflict. No further flag starts processing; the
// workers already running settle (each writes its manifest entry or records its error), and only then
// is the inventory snapshotted, so no write can land after the snapshot.
let abortRequested: { resourceType: string; key: string } | null = null;

function requestAbort(resourceType: string, key: string): void {
  if (abortRequested) return;
  abortRequested = { resourceType, key };
  console.log(
    Colors.red(
      `\n❌ Aborting: ${resourceType} "${key}" already exists in the destination (--on-conflict abort).`,
    ),
  );
  console.log(
    Colors.yellow(
      `   Letting flags already being processed finish before saving the sync manifest...`,
    ),
  );
}

/** Persists everything recorded so far, marked incomplete with `reason`, then exits non-zero. */
async function persistAndExit(reason: string): Promise<never> {
  carryForwardManifestEntries();
  await writeSyncManifestFile({ reason, at: new Date().toISOString() });
  Deno.exit(1);
}

/** Writes the manifest, marked incomplete, with everything settled workers recorded, then exits. */
async function finalizeAbort(): Promise<never> {
  const { resourceType, key } = abortRequested!;
  return await persistAndExit(
    `aborted: ${resourceType} "${key}" already exists (--on-conflict abort)`,
  );
}

// Load maintainer mapping if needed
console.log(Colors.blue("👥 Loading maintainer mapping..."));
let maintainerMapping: Record<string, string | null> = {};
if (inputArgs.assignMaintainerIds) {
  try {
    maintainerMapping = await getJson(
      "./data/launchdarkly-migrations/mappings/maintainer_mapping.json",
    ) || {};
    console.log(
      Colors.green(
        `✓ Loaded maintainer mapping with ${
          Object.keys(maintainerMapping).length
        } entries`,
      ),
    );
  } catch (error) {
    console.log(
      Colors.yellow(
        `⚠ Warning: Could not load maintainer mapping file: ${error}`,
      ),
    );
    console.log(Colors.yellow(`  Continuing without maintainer mapping...`));
  }
} else {
  console.log(Colors.gray("  Maintainer mapping disabled"));
}

// Project Data //
console.log(
  Colors.blue(
    `\n📦 Loading source project data from: ${inputArgs.projKeySource}...`,
  ),
);
const projectJson = await getJson(
  `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/project.json`,
);

if (!projectJson) {
  console.log(
    Colors.red(
      `❌ Error: Could not load project data from ./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/project.json`,
    ),
  );
  console.log(
    Colors.yellow(`Make sure you've run the extract-source step first!`),
  );
  Deno.exit(1);
}
console.log(Colors.green(`✓ Project data loaded`));

const buildEnv: Array<any> = [];

projectJson.environments.items.forEach((env: any) => {
  const newEnv: any = {
    name: env.name,
    key: env.key,
    color: env.color,
  };

  if (env.defaultTtl) newEnv.defaultTtl = env.defaultTtl;
  if (env.confirmChanges) newEnv.confirmChanges = env.confirmChanges;
  if (env.secureMode) newEnv.secureMode = env.secureMode;
  if (env.defaultTrackEvents) {
    newEnv.defaultTrackEvents = env.defaultTrackEvents;
  }
  if (env.requireComments) newEnv.requireComments = env.requireComments;
  if (env.critical) newEnv.critical = env.critical;
  if (env.tags) newEnv.tags = env.tags;

  buildEnv.push(newEnv);
});

let envkeys: Array<string> = buildEnv.map((env: any) => env.key);

// Filter environments if specified
if (inputArgs.environments) {
  const requestedEnvs = inputArgs.environments.split(",").map((e) => e.trim());
  const originalEnvCount = envkeys.length;
  envkeys = envkeys.filter((key) => requestedEnvs.includes(key));

  console.log(Colors.cyan(`\n=== Environment Filtering ===`));
  console.log(`Requested environments: ${requestedEnvs.join(", ")}`);
  console.log(`Matched environments: ${envkeys.join(", ")}`);

  const notFound = requestedEnvs.filter((e) => !envkeys.includes(e));
  if (notFound.length > 0) {
    console.log(
      Colors.yellow(
        `Warning: Requested environments not found in source: ${
          notFound.join(", ")
        }`,
      ),
    );
  }

  if (envkeys.length === 0) {
    console.log(
      Colors.red(
        `Error: None of the requested environments exist in source project.`,
      ),
    );
    console.log(
      Colors.red(
        `Available environments: ${buildEnv.map((e: any) => e.key).join(", ")}`,
      ),
    );
    Deno.exit(1);
  }

  console.log(
    `Migrating ${envkeys.length} of ${originalEnvCount} environments\n`,
  );
}

// Apply environment mapping if specified
// If mapping is provided, filter to only mapped source environments
if (inputArgs.envMap) {
  const mappedSourceEnvs = Object.keys(envMapping);
  envkeys = envkeys.filter((key) => mappedSourceEnvs.includes(key));

  if (envkeys.length === 0) {
    console.log(
      Colors.red(
        `Error: None of the mapped source environments exist in the source project.`,
      ),
    );
    console.log(
      Colors.red(`Mapped source environments: ${mappedSourceEnvs.join(", ")}`),
    );
    console.log(
      Colors.red(
        `Available source environments: ${
          buildEnv.map((e: any) => e.key).join(", ")
        }`,
      ),
    );
    Deno.exit(1);
  }

  console.log(
    Colors.cyan(`Migrating ${envkeys.length} mapped environment(s)\n`),
  );
}

// Destination environment body built from source env settings (key is remapped when --env-map is used)
const destEnvBody = (srcKey: string): Record<string, unknown> => {
  const meta = buildEnv.find((e: any) => e.key === srcKey) ??
    { key: srcKey, name: srcKey, color: "417505" };
  const destKey = inputArgs.envMap ? envMapping[srcKey] : srcKey;
  return { ...meta, key: destKey, name: meta.name || destKey };
};

// ==================== Incremental Sync ====================

const syncManifestPath = syncManifestPathFor(
  inputArgs.projKeySource,
  inputArgs.projKeyDest,
);
let previousManifest: SyncManifest | null = null;
// Null-prototype dictionaries: a flag or environment named "__proto__" must be an own entry that serializes
const updatedManifestFlags = emptyRecord<SyncManifestFlag>();
const updatedManifestSegments = emptyRecord<
  Record<string, SyncManifestSegment>
>();
let incrementalSkipCount = 0;
let incrementalEnvSkipCount = 0;
let incrementalSegmentSkipCount = 0;

// Always load the previous manifest for tracking; it is only used for skipping with --incremental.
// Loaded before any destination write, including project and environment creation below: a manifest
// that cannot be read, or that records another project pair (keys containing "-" can share a file
// name), stops the run while the destination is still unchanged, since its entries would be carried
// forward and trusted by incremental skips, view linking and revert.
// The manifest is only trusted for the destination it was written for (same project keys in another
// account or domain are unrelated resources); the account is read best-effort from caller-identity
const destIdentity: DestinationIdentity = {
  domain,
  accountId: await getAccountId(apiKey, domain).catch(() => undefined),
};
try {
  previousManifest = await readSyncManifest(
    inputArgs.projKeySource,
    inputArgs.projKeyDest,
    undefined,
    destIdentity,
  );
} catch (error) {
  console.log(
    Colors.red(
      `\n❌ ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
  console.log(
    Colors.yellow(
      `   Move or delete ${syncManifestPath} to start a fresh manifest.`,
    ),
  );
  Deno.exit(1);
}

if (previousManifest && !previousManifest.destDomain) {
  console.log(Colors.yellow(
    `\n⚠ Sync manifest ${syncManifestPath} comes from an older version and does not record the destination it was written ` +
      `for, so it cannot be verified against ${domain}${
        destIdentity.accountId ? ` (account ${destIdentity.accountId})` : ""
      }. ` +
      `Make sure this working directory was only ever used for this destination; this run stamps it.`,
  ));
}

// Destination environment a selected source environment's segments migrate to (undefined: not migrated
// this run, including every environment when segment migration is off, so segment entries stay untouched)
const destEnvOfSelected = (sourceEnv: string): string | undefined =>
  inputArgs.migrateSegments && envkeys.includes(sourceEnv)
    ? (inputArgs.envMap && envMapping[sourceEnv]
      ? envMapping[sourceEnv]
      : sourceEnv)
    : undefined;

// The manifest records where each segment copy lives; a mapping that now sends a source environment
// elsewhere would make its entries claim unrelated segments there, so such a run stops before writing
const envMismatches = segmentEnvironmentMismatches(
  previousManifest,
  destEnvOfSelected,
);
if (envMismatches.length > 0) {
  console.log(
    Colors.red(
      `\n❌ The environment mapping differs from the one the sync manifest ${syncManifestPath} was written with:`,
    ),
  );
  envMismatches.forEach((m) => console.log(Colors.red(`   ${m}`)));
  console.log(
    Colors.yellow(
      `   Re-run with the previous mapping, or revert that migration and remove the manifest before migrating with the new one.`,
    ),
  );
  Deno.exit(1);
}

// Segment entries from older versions do not record their destination environment, so their ownership
// is only reused once the copy is found where the current mapping points: found entries are stamped,
// missing ones drop their ownership (conflict handling then applies), anything else stops the run
const legacySegments = legacySegmentEntries(
  previousManifest,
  destEnvOfSelected,
);
if (legacySegments.length > 0) {
  console.log(
    Colors.yellow(
      `\n⚠ Verifying ${legacySegments.length} segment entr${
        legacySegments.length === 1 ? "y" : "ies"
      } from an older sync manifest against the destination...`,
    ),
  );
  const dropped: string[] = [];
  for (const e of legacySegments) {
    const resp = await rateLimitRequest(
      ldAPIRequest(
        apiKey,
        domain,
        `segments/${inputArgs.projKeyDest}/${e.destEnv}/${e.destKey}`,
      ),
      "segments",
    );
    if (resp.status === 200) {
      previousManifest!.segments![e.sourceEnv][e.key].destEnv = e.destEnv;
    } else if (resp.status === 404) {
      delete previousManifest!.segments![e.sourceEnv][e.key];
      dropped.push(
        `${e.sourceEnv}/${e.key} (not found as ${e.destEnv}/${e.destKey})`,
      );
    } else if (resp.status === 401 || resp.status === 403) {
      console.log(
        Colors.red(
          `\n❌ Destination API key is invalid or lacks access (HTTP ${resp.status}).`,
        ),
      );
      console.log(
        Colors.yellow(
          `   Check "destination_account_api_key" in config/api_keys.json — it needs write access to "${inputArgs.projKeyDest}".`,
        ),
      );
      Deno.exit(1);
    } else {
      console.log(
        Colors.red(
          `\n❌ Could not verify legacy sync manifest entry ${e.sourceEnv}/${e.key} in ${e.destEnv} (HTTP ${resp.status}); stopping before any write.`,
        ),
      );
      Deno.exit(1);
    }
  }
  console.log(
    Colors.gray(
      `  ${legacySegments.length - dropped.length} confirmed and stamped${
        dropped.length > 0
          ? `; ownership dropped for ${dropped.join(", ")}`
          : ""
      }`,
    ),
  );
}

// Flag-scope filters leave flags unattempted, so they cannot complete an inventory an aborted run left incomplete
const flagScopeFiltered = Boolean(
  inputArgs.includeFlags || inputArgs.excludeFlags || inputArgs.since,
);
if (previousManifest?.incomplete) {
  console.log(Colors.yellow(
    `\n⚠ Previous sync manifest is marked incomplete (${previousManifest.incomplete.reason}, at ${previousManifest.incomplete.at}); ` +
      `revert refuses it until a run without includeFlags, excludeFlags or --since completes with no failed writes ` +
      `and an entry maps to every untracked destination resource` +
      (previousManifest.incomplete.unresolved
        ? ` (currently: ${
          [
            ...previousManifest.incomplete.unresolved.flags,
            ...previousManifest.incomplete.unresolved.segments,
          ].join(", ")
        }; ` +
          `verify the aborted run created them, then re-run with --adopt-unresolved to record them)`
        : ``) +
      (flagScopeFiltered
        ? `. This run is filtered, so the marker is kept.`
        : `. This run clears it if it completes cleanly.`),
  ));
}

if (inputArgs.incremental) {
  if (previousManifest) {
    const flagCount = Object.keys(previousManifest.flags).length;
    const segCount = previousManifest.segments
      ? Object.values(previousManifest.segments).reduce(
        (sum, envSegs) => sum + Object.keys(envSegs).length,
        0,
      )
      : 0;
    const segPart = segCount > 0 ? `, ${segCount} segments` : "";
    console.log(
      Colors.cyan(
        `\n📋 Incremental sync: loaded manifest from ${previousManifest.lastSyncTimestamp} (${flagCount} flags${segPart} tracked)`,
      ),
    );
  } else {
    console.log(
      Colors.cyan(
        `\n📋 Incremental sync: no previous manifest found, will sync all flags`,
      ),
    );
  }
}

// Destination project must exist unless --create-project is set.
// 401/403 means the token cannot see the project; do not treat that as "missing".
const projStatus = await getProjectStatus(
  apiKey,
  domain,
  inputArgs.projKeyDest,
);
let existingEnvs: string[];

if (projStatus === 401 || projStatus === 403) {
  console.log(
    Colors.red(
      `\n❌ Destination API key is invalid or lacks access (HTTP ${projStatus}).`,
    ),
  );
  console.log(
    Colors.yellow(
      `   Check "destination_account_api_key" in config/api_keys.json — it needs write access to "${inputArgs.projKeyDest}".`,
    ),
  );
  Deno.exit(1);
} else if (projStatus !== 200) {
  if (!inputArgs.createProject) {
    console.log(
      Colors.red(
        `\n❌ Destination project "${inputArgs.projKeyDest}" does not exist (HTTP ${projStatus}).`,
      ),
    );
    console.log(
      Colors.yellow(
        `   Use --create-project (migration.createProject: true) to create it, or create it in LaunchDarkly first.`,
      ),
    );
    Deno.exit(1);
  }
  const envBodies = envkeys.map(destEnvBody);
  const created = await createProjectOnDestination(
    inputArgs.dryRun || false,
    apiKey,
    domain,
    inputArgs.projKeyDest,
    resolveDestinationProjectName({
      explicit: inputArgs.destProjectName,
      sourceName: projectJson.name,
      sourceKey: inputArgs.projKeySource,
      destKey: inputArgs.projKeyDest,
    }),
    envBodies,
  );
  if (!created) {
    console.log(
      Colors.red(
        `\n❌ Failed to create destination project "${inputArgs.projKeyDest}".`,
      ),
    );
    Deno.exit(1);
  }
  // In dry-run the project doesn't exist, so use the environments it would have been created with
  existingEnvs = inputArgs.dryRun
    ? envBodies.map((e) => e.key as string)
    : await getExistingEnvironments(apiKey, domain, inputArgs.projKeyDest);
  console.log(
    Colors.gray(`  Destination environments: ${existingEnvs.join(", ")}`),
  );
} else {
  if (inputArgs.destProjectName) {
    console.log(
      Colors.gray(
        `  Destination project exists; projectName "${inputArgs.destProjectName}" ignored (not renamed)`,
      ),
    );
  }
  console.log(
    Colors.blue(
      `  Fetching existing environments for ${inputArgs.projKeyDest}...`,
    ),
  );
  existingEnvs = await getExistingEnvironments(
    apiKey,
    domain,
    inputArgs.projKeyDest,
  );
  console.log(
    Colors.gray(`  Found existing environments: ${existingEnvs.join(", ")}`),
  );
}

/**
 * Creates destination environments for the given source env keys, exiting on failure
 */
const createMissingEnvironments = async (srcKeys: string[]): Promise<void> => {
  console.log(
    Colors.cyan(
      `Creating ${srcKeys.length} missing environment(s) in ${inputArgs.projKeyDest}...`,
    ),
  );
  for (const srcKey of srcKeys) {
    const body = destEnvBody(srcKey);
    const ok = await createEnvironmentOnDestination(
      inputArgs.dryRun || false,
      apiKey,
      domain,
      inputArgs.projKeyDest,
      body,
    );
    if (!ok) {
      console.log(
        Colors.red(`Failed to create environment "${body.key}". Exiting.`),
      );
      Deno.exit(1);
    }
    existingEnvs.push(body.key as string);
  }
};

// If environment mapping is enabled, check destination environments exist
if (inputArgs.envMap) {
  const mappedDestEnvs = envkeys.map((srcKey) => envMapping[srcKey]);
  const missingDestEnvs = mappedDestEnvs.filter((destKey) =>
    !existingEnvs.includes(destKey)
  );

  if (missingDestEnvs.length > 0) {
    if (inputArgs.createEnvironments) {
      await createMissingEnvironments(
        [...new Set(missingDestEnvs)].map((destKey) =>
          reverseEnvMapping[destKey]
        ),
      );
    } else {
      console.log(
        Colors.red(
          `Error: The following mapped destination environments don't exist in target project:`,
        ),
      );
      missingDestEnvs.forEach((destKey) => {
        const srcKey = reverseEnvMapping[destKey];
        console.log(
          Colors.red(
            `  ${srcKey} → ${destKey} (destination "${destKey}" not found)`,
          ),
        );
      });
      console.log(
        Colors.red(
          `Available destination environments: ${existingEnvs.join(", ")}`,
        ),
      );
      console.log(
        Colors.yellow(
          `Use --create-environments (migration.createEnvironments: true) to create them.`,
        ),
      );
      Deno.exit(1);
    }
  }
} else {
  // Keep SOURCE env keys; only include those that exist in the target project.
  // (We must use source keys so that flag.environments[env] matches extracted flag data.)
  const missingEnvs = envkeys.filter((key) => !existingEnvs.includes(key));
  if (missingEnvs.length > 0) {
    if (inputArgs.createEnvironments) {
      await createMissingEnvironments(missingEnvs);
    } else {
      console.log(
        Colors.yellow(
          `Warning: The following environments from source project don't exist in target project: ${
            missingEnvs.join(", ")
          }`,
        ),
      );
      console.log(
        Colors.yellow(
          "Skipping these environments. Use --create-environments to create them.",
        ),
      );
    }
  }
  envkeys = envkeys.filter((key) => existingEnvs.includes(key));
  if (envkeys.length > 0) {
    console.log(
      Colors.cyan(
        `Migrating ${envkeys.length} environment(s) that exist in both projects\n`,
      ),
    );
  }
}

// View Management //
console.log(Colors.cyan("\n=== View Management ==="));

console.log(Colors.blue("\n📋 Loading flag list..."));
let flagList: Array<string> = await getJson(
  `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/flags.json`,
);

if (!flagList) {
  console.log(
    Colors.red(
      `❌ Error: Could not load flag list from ./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/flags.json`,
    ),
  );
  Deno.exit(1);
}
console.log(Colors.green(`✓ Loaded ${flagList.length} flags`));

// Flag files are named by their index in the extracted flags.json; capture it before filtering
const sourceIndexByKey = new Map(flagList.map((k, i) => [k, i]));

// Apply include/exclude flag filters
if (inputArgs.includeFlags) {
  const includeSet = new Set(
    inputArgs.includeFlags.split(",").map((s) => s.trim()).filter(Boolean),
  );
  if (includeSet.size > 0) {
    const before = flagList.length;
    flagList = flagList.filter((k) => includeSet.has(k));
    console.log(
      Colors.cyan(
        `  Include filter: ${flagList.length} of ${before} flag(s) match includeFlags`,
      ),
    );
  }
}
if (inputArgs.excludeFlags) {
  const excludeSet = new Set(
    inputArgs.excludeFlags.split(",").map((s) => s.trim()).filter(Boolean),
  );
  if (excludeSet.size > 0) {
    const before = flagList.length;
    flagList = flagList.filter((k) => !excludeSet.has(k));
    console.log(
      Colors.cyan(
        `  Exclude filter: ${
          before - flagList.length
        } flag(s) excluded, ${flagList.length} remaining`,
      ),
    );
  }
}

const flagsDir =
  `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/flags`;

// Try index-prefixed filename first (new format), then pure index, then SHA-based, then plain key (legacy).
// The index is the flag's position in the extracted (unfiltered) flags.json, not in the filtered flagList,
// so include/exclude filters don't make lookups miss or load another flag's file.
async function getFlagDataByIndexOrKey(
  _index: number,
  key: string,
): Promise<any> {
  const index = sourceIndexByKey.get(key);
  if (index === undefined) return await getJson(`${flagsDir}/${key}.json`);
  return await getJson(`${flagsDir}/${index}-${key}.json`) ??
    await getJson(`${flagsDir}/${index}.json`) ??
    await getJson(`${flagsDir}/${key}-${await sha256HexUtf8(key)}.json`) ??
    await getJson(`${flagsDir}/${key}.json`);
}

// Error tracking shared by the segment and flag phases. Anything added here makes the
// run exit non-zero after the summary, so partial migrations are never reported as success.
const segmentsWithErrors: Set<string> = new Set();
const flagsWithErrors: Set<string> = new Set();
// Checks that could not be completed (reconciliation, source archival); also fail the run
const reconciliationErrors: string[] = [];
// Declared with the shared tracking state so the flag phase and reconciliation both see it
const flagsSkippedByDate: Set<string> = new Set(); // --since: never attempted, excluded from reconciliation
// --on-conflict skip: the destination copy stays as it is, so the previous manifest entry is kept
const flagsSkippedByConflict: Set<string> = new Set();
const segmentsSkippedByConflict: Set<string> = new Set(); // "<sourceEnv>/<segmentKey>"
// --on-conflict prefix: the existing destination copy under the original key stays untracked
const flagsPrefixedByConflict: Set<string> = new Set();
const segmentsPrefixedByConflict: Set<string> = new Set(); // "<sourceEnv>/<segmentKey>"
// Segments whose create was attempted this run ("<sourceEnv>/<segmentKey>"); a previous manifest entry
// for anything else (no extracted data for the environment, unselected environment, segments off) is kept
const segmentsAttempted: Set<string> = new Set();
// Flags whose processing reached the destination (existence check onwards); on an abort, flags the run
// never got to keep their previous manifest entry
const flagsAttempted: Set<string> = new Set();
// Creates the API definitively rejected (4xx other than 409): nothing was written, so the resource is not
// a possibly-existing untracked copy and must not block revert through the incomplete marker
const flagsCreateRejected: Set<string> = new Set();
const segmentsCreateRejected: Set<string> = new Set(); // "<sourceEnv>/<segmentKey>"
// A manifest that could not be saved leaves no trustworthy inventory for revert or --incremental: the run
// fails so the workflow stops instead of advancing on a missing or stale manifest. Declared here because
// the manifest writer can run from an abort or phase failure before the flag phase.
let manifestWriteFailed = false;
const flagErrorDetails: Map<string, string> = new Map();

// Prerequisite check: with include/exclude filters, every prerequisite of a selected flag must be
// selected too, or already exist in destination. Without filters the whole project is migrated in
// prerequisite order, so the check is skipped (an archived prerequisite would otherwise block the run).
if (inputArgs.includeFlags || inputArgs.excludeFlags) {
  console.log("Checking flag prerequisites...");
  const selectedFlags = new Set(flagList);
  const missingPrereqs = new Map<string, Set<string>>(); // prereq key -> "flag (env)" entries that need it
  for (const flagkey of flagList) {
    const flag = await getFlagDataByIndexOrKey(0, flagkey) as
      | Record<string, any>
      | null;
    for (const env of envkeys) {
      for (const prereq of flag?.environments?.[env]?.prerequisites ?? []) {
        if (selectedFlags.has(prereq.key)) continue;
        if (!missingPrereqs.has(prereq.key)) {
          missingPrereqs.set(prereq.key, new Set());
        }
        missingPrereqs.get(prereq.key)!.add(`${flagkey} (${env})`);
      }
    }
  }
  for (const prereqKey of [...missingPrereqs.keys()]) {
    const resp = await rateLimitRequest(
      ldAPIRequest(
        apiKey,
        domain,
        `flags/${inputArgs.projKeyDest}/${prereqKey}`,
      ),
      "flags",
    );
    if (resp.status === 200) missingPrereqs.delete(prereqKey);
  }
  if (missingPrereqs.size > 0) {
    const color = inputArgs.dryRun ? Colors.yellow : Colors.red;
    console.log(
      color(
        `\n${
          inputArgs.dryRun ? "⚠️  Warning" : "❌ Error"
        }: ${missingPrereqs.size} prerequisite flag(s) are not selected for migration and do not exist in "${inputArgs.projKeyDest}":`,
      ),
    );
    for (const [prereqKey, neededBy] of missingPrereqs) {
      console.log(
        color(
          `   • ${prereqKey} — prerequisite of ${[...neededBy].join(", ")}`,
        ),
      );
    }
    console.log(
      Colors.yellow(
        `   Add them to includeFlags (or remove them from excludeFlags): ${
          [...missingPrereqs.keys()].join(",")
        }`,
      ),
    );
    if (!inputArgs.dryRun) Deno.exit(1);
    console.log(
      Colors.yellow(
        `   Continuing because this is a dry run; a real run would stop here.\n`,
      ),
    );
  } else {
    console.log(
      Colors.green(
        `✓ All prerequisites are included or already exist in destination`,
      ),
    );
  }
}

// Views come from the views API during extraction; flags don't report which views they belong to.
// With migrateViews off, no source view is recreated or linked; only --target-view applies.
const sourceViews: SourceView[] = migrateViews
  ? (await getJson(
    `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/views.json`,
  )) ?? []
  : [];
const viewsToCreate = new Map<string, View>();
for (const v of sourceViews) {
  const view: View = { key: v.key, name: v.name };
  if (v.description) view.description = v.description;
  if (v.tags) view.tags = v.tags;
  if (v.maintainerTeamKey) {
    view.maintainerTeamKey = v.maintainerTeamKey;
  } else if (
    inputArgs.assignMaintainerIds && v.maintainerId &&
    maintainerMapping[v.maintainerId]
  ) {
    view.maintainerId = maintainerMapping[v.maintainerId]!;
  }
  viewsToCreate.set(v.key, view);
}
if (inputArgs.targetView && !viewsToCreate.has(inputArgs.targetView)) {
  console.log(Colors.cyan(`Target view specified: "${inputArgs.targetView}"`));
  viewsToCreate.set(inputArgs.targetView, {
    key: inputArgs.targetView,
    name: inputArgs.targetView,
    description: `Migrated from project ${inputArgs.projKeySource}`,
  });
}

const usableViews = new Set<string>(); // views that exist (or would, in a dry run) in the destination
if (viewsToCreate.size === 0) {
  console.log(
    migrateViews
      ? "No views found in extracted source data."
      : "Views are not migrated (migrateViews: false).",
  );
}
for (const view of viewsToCreate.values()) {
  if (await checkViewExists(apiKey, domain, inputArgs.projKeyDest, view.key)) {
    console.log(Colors.green(`  ✓ View "${view.key}" already exists`));
    usableViews.add(view.key);
    continue;
  }
  if (inputArgs.dryRun) {
    console.log(
      Colors.gray(
        `    [DRY RUN] Would create view "${view.key}" (${
          JSON.stringify(view)
        })`,
      ),
    );
    usableViews.add(view.key);
    continue;
  }
  let result = await createView(apiKey, domain, inputArgs.projKeyDest, view);
  if (!result.success && (view.maintainerId || view.maintainerTeamKey)) {
    // The maintainer may not exist in the destination account; keep the view without one
    console.log(
      Colors.yellow(
        `  ⚠ Creating view "${view.key}" with its maintainer failed (${result.error}); retrying without maintainer`,
      ),
    );
    const { maintainerId: _m, maintainerTeamKey: _t, ...withoutMaintainer } =
      view;
    result = await createView(
      apiKey,
      domain,
      inputArgs.projKeyDest,
      withoutMaintainer,
    );
  }
  if (result.success) {
    console.log(Colors.green(`  ✓ View "${view.key}" created`));
    usableViews.add(view.key);
  } else {
    console.log(
      Colors.yellow(`  ⚠ Failed to create view "${view.key}": ${result.error}`),
    );
  }
}

// ==================== Context Kinds ====================
// Optional contextKinds.json in the source dir (written by source adapters
// like source_from_split.ts). Kinds must exist before segments and flag
// targeting reference them.

const contextKinds = await getJson(
  `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/contextKinds.json`,
) as Array<{ key: string; name: string; description?: string }> | undefined;

if (contextKinds && contextKinds.length > 0) {
  console.log(
    Colors.blue(`\n🧩 Creating ${contextKinds.length} context kind(s)...`),
  );
  for (const kind of contextKinds) {
    const body: Record<string, unknown> = { name: kind.name };
    if (kind.description) body.description = kind.description;

    if (inputArgs.dryRun) {
      console.log(
        Colors.gray(
          `    [DRY RUN] Would PUT projects/${inputArgs.projKeyDest}/context-kinds/${kind.key}`,
        ),
      );
      continue;
    }
    const resp = await rateLimitRequest(
      ldAPIPutRequest(
        apiKey,
        domain,
        `projects/${inputArgs.projKeyDest}/context-kinds/${kind.key}`,
        body,
      ),
      "context-kinds",
    );
    if (resp.status >= 200 && resp.status < 300) {
      console.log(Colors.green(`  ✓ Context kind "${kind.key}" upserted`));
    } else {
      console.log(
        Colors.red(
          `  ✗ Context kind "${kind.key}" failed (${resp.status}): ${await resp
            .text()}`,
        ),
      );
    }
  }
}

// ==================== Segment Tags ====================

/**
 * Merges the source tags and the migration tags into an existing destination segment's tags.
 * Only runs when migration tags are set: without them an existing segment keeps its tags.
 * Returns a short log note, empty when nothing was changed.
 */
async function syncExistingSegmentTags(
  destEnvKey: string,
  destSegmentKey: string,
  sourceTags: string[] | undefined,
): Promise<string> {
  if (migrationTags.length === 0) return "";
  const segmentPath =
    `segments/${inputArgs.projKeyDest}/${destEnvKey}/${destSegmentKey}`;
  const existingResp = await rateLimitRequest(
    ldAPIRequest(apiKey, domain, segmentPath),
    "segments",
  );
  if (existingResp.status !== 200) {
    // Without the current tags the merge cannot run; count it so the run does not report success with tags missing
    console.log(
      Colors.red(
        `    ✗ Could not read existing tags for segment ${destSegmentKey} (${existingResp.status})`,
      ),
    );
    segmentsWithErrors.add(`${destEnvKey}/${destSegmentKey}`);
    return "";
  }
  const existing = await existingResp.json();
  const desiredTags = mergeTags(sourceTags, migrationTags, existing.tags);
  if (JSON.stringify(desiredTags) === JSON.stringify(existing.tags ?? [])) {
    return "";
  }
  const tagResp = await dryRunAwarePatch(
    inputArgs.dryRun || false,
    apiKey,
    domain,
    segmentPath,
    [buildPatch("tags", "replace", desiredTags)],
    false,
    "segments",
    `environment: ${destEnvKey}`,
  );
  if (tagResp.status >= 400) {
    console.log(
      Colors.red(
        `    ✗ Failed to update tags for segment ${destSegmentKey} (${tagResp.status})`,
      ),
    );
    segmentsWithErrors.add(`${destEnvKey}/${destSegmentKey}`);
    return "";
  }
  return ", tags synced";
}

// ==================== Big Segment CSV Import ====================

/** LD big segment CSV imports cap at 1M rows / 40MB per file. */
const BIG_SEGMENT_IMPORT_ROW_LIMIT = 1_000_000;

const csvEscape = (key: string): string =>
  /[",\n\r]/.test(key) ? `"${key.replaceAll('"', '""')}"` : key;

/**
 * Loads big segment members via POST segments/{proj}/{env}/{key}/imports
 * (multipart CSV, no header row). The first chunk replaces existing members
 * so reruns are idempotent; subsequent chunks merge.
 */
async function importBigSegmentMembers(
  projKey: string,
  envKey: string,
  segmentKey: string,
  keys: string[],
): Promise<void> {
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += BIG_SEGMENT_IMPORT_ROW_LIMIT) {
    chunks.push(keys.slice(i, i + BIG_SEGMENT_IMPORT_ROW_LIMIT));
  }
  // An empty source still needs one replace import: it clears the destination's existing members
  if (chunks.length === 0) chunks.push([]);

  for (const [chunkIndex, chunk] of chunks.entries()) {
    const mode = chunkIndex === 0 ? "replace" : "merge";
    if (inputArgs.dryRun) {
      console.log(Colors.gray(
        `    [DRY RUN] Would import ${chunk.length} member(s) into big segment ${segmentKey} (${envKey}, mode=${mode})`,
      ));
      continue;
    }

    const csv = chunk.map(csvEscape).join("\n");
    const form = new FormData();
    form.append(
      "file",
      new Blob([csv], { type: "text/csv" }),
      `${segmentKey}.csv`,
    );
    form.append("mode", mode);

    const req = new Request(
      `https://${domain}/api/v2/segments/${projKey}/${envKey}/${segmentKey}/imports`,
      {
        method: "POST",
        headers: {
          "Authorization": apiKey,
          "User-Agent": "Project-Migrator-Script",
        },
        body: form,
      },
    );
    const resp = await rateLimitRequest(req, "segments");

    if (resp.status < 200 || resp.status >= 300) {
      console.log(Colors.red(
        `  ✗ Big segment import failed for ${segmentKey} (${resp.status}): ${await resp
          .text()}`,
      ));
      segmentsWithErrors.add(`${envKey}/${segmentKey}`);
      return;
    }

    // 204 with a Location header pointing at the import status resource.
    const location = resp.headers.get("location");
    const importId = location?.split("/").pop();
    console.log(Colors.green(
      `  ✓ Big segment ${segmentKey}: ${chunk.length} member(s) submitted (mode=${mode})`,
    ));

    if (importId) {
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const statusResp = await rateLimitRequest(
          ldAPIRequest(
            apiKey,
            domain,
            `segments/${projKey}/${envKey}/${segmentKey}/imports/${importId}`,
          ),
          "segments",
        );
        if (statusResp.status !== 200) break;
        const status = (await statusResp.json()).status;
        // The API reports "complete" (not "completed") when an import finishes
        if (status === "complete") {
          console.log(Colors.green(`    ✓ Import completed`));
          break;
        }
        if (
          status === "failed" || status === "cancelled" || status === "stopped"
        ) {
          console.log(Colors.red(`    ✗ Import ${status}`));
          segmentsWithErrors.add(`${envKey}/${segmentKey}`);
          break;
        }
      }
    }
  }
}

// Migrate segments if enabled
console.log(Colors.blue("\n🔷 Starting segment migration..."));
if (inputArgs.migrateSegments) {
  // An unexpected error here must not lose what was already written: persist, marked incomplete, and stop
  try {
    console.log(Colors.green("  Segment migration enabled"));
    // Filter environments to only those selected
    const envsToMigrate = projectJson.environments.items.filter((env: any) =>
      envkeys.includes(env.key)
    );
    console.log(
      Colors.gray(
        `  Processing ${envsToMigrate.length} environment(s) for segments`,
      ),
    );
    for (const env of envsToMigrate) {
      const segmentData = await getJson(
        `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/segments/${env.key}.json`,
      );

      // Skip if no segment data exists for this environment
      if (!segmentData || !segmentData.items) {
        console.log(
          Colors.yellow(
            `  ⚠ No segment data found for environment: ${env.key}, skipping...`,
          ),
        );
        continue;
      }

      // Determine destination environment key (mapped or original)
      const destEnvKey = inputArgs.envMap && envMapping[env.key]
        ? envMapping[env.key]
        : env.key;

      for (const segment of segmentData.items) {
        // Big (unbounded) segments are created with unbounded=true; members can
        // be loaded via CSV import when the source data provides _importKeys
        // (e.g. from the Split source adapter). Big segments synced from an
        // external store in the SOURCE LD project have no exportable members —
        // those are created empty with a warning.
        const isBigSegment = segment.unbounded == true;
        // LD sources: members exported as CSV during extraction (--extract-big-segments)
        if (
          isBigSegment && !segment._importKeys && inputArgs.migrateBigSegments
        ) {
          const csvPath = bigSegmentCsvPath(
            `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}`,
            env.key,
            segment.key,
          );
          const csv = await Deno.readTextFile(csvPath).catch(() => null);
          if (csv === null) {
            console.log(
              Colors.yellow(
                `  ⚠ No exported members for big segment ${segment.key} (${env.key}) at ${csvPath}; extract with migrateBigSegments: true`,
              ),
            );
          } else {
            segment._importKeys = readExportedKeys(csv);
            console.log(
              Colors.gray(
                `  Big segment ${segment.key} (${env.key}): ${segment._importKeys.length} exported member(s) to import`,
              ),
            );
          }
        }
        if (isBigSegment && segment._importKeys === undefined) {
          console.log(Colors.yellow(
            `Segment: ${segment.key} in Environment ${env.key} is a big segment (unbounded) with no exported members`,
          ));
          console.log(Colors.gray(
            `  → It will be created empty. Reconnect its sync or re-import members via CSV in the destination.`,
          ));
        }

        // Incremental sync: skip segments that haven't changed since last sync.
        // Big segments with exported members are always re-imported: member changes may not bump the version.
        if (
          inputArgs.incremental && previousManifest &&
          !(isBigSegment && segment._importKeys)
        ) {
          const prevSegment = ownEntry(
            ownEntry(previousManifest.segments, env.key),
            segment.key,
          );
          if (
            prevSegment && segment.version !== undefined &&
            prevSegment.version === segment.version
          ) {
            // Migration tags are not part of the source version, so reconcile them on the skipped segment too
            const tagNote = await syncExistingSegmentTags(
              destEnvKey,
              prevSegment.destKey ?? segment.key,
              segment.tags,
            );
            console.log(
              Colors.gray(
                `    ✓ ${segment.key}: unchanged (v${segment.version})${tagNote}, skipping`,
              ),
            );
            incrementalSegmentSkipCount++;
            // Carry forward previous manifest entry
            if (!updatedManifestSegments[env.key]) {
              updatedManifestSegments[env.key] = emptyRecord();
            }
            updatedManifestSegments[env.key][segment.key] = prevSegment;
            continue;
          }
        }

        segmentsAttempted.add(`${env.key}/${segment.key}`);
        // As for flags: a recorded destination key under another name is our own earlier prefixed copy
        const recordedSegment = recordedDestination(
          ownEntry(ownEntry(previousManifest?.segments, env.key), segment.key),
          segment,
          inputArgs.conflictPrefix,
        );
        let segmentKey = recordedSegment.key;
        let segmentName = recordedSegment.name;
        let attemptCount = 0;
        let segmentCreated = false;
        let segmentAlreadyExisted = false;

        while (!segmentCreated && attemptCount < 2) {
          attemptCount++;

          const newSegment: any = {
            name: segmentName,
            key: segmentKey,
          };

          const segmentTags = mergeTags(segment.tags, migrationTags);
          if (segmentTags.length > 0) newSegment.tags = segmentTags;
          if (segment.description) newSegment.description = segment.description;
          if (isBigSegment) {
            newSegment.unbounded = true;
            if (segment.unboundedContextKind) {
              newSegment.unboundedContextKind = segment.unboundedContextKind;
            }
          }

          const segmentResp = await dryRunAwarePost(
            inputArgs.dryRun || false,
            apiKey,
            domain,
            `segments/${inputArgs.projKeyDest}/${destEnvKey}`,
            newSegment,
            false,
            "segments",
          );

          let segmentStatus = segmentResp.status;
          if (inputArgs.dryRun && segmentStatus === 201) {
            // The simulated POST always succeeds; look the segment up so conflict handling and the tag patch are previewed
            const probe = await rateLimitRequest(
              ldAPIRequest(
                apiKey,
                domain,
                `segments/${inputArgs.projKeyDest}/${destEnvKey}/${segmentKey}`,
              ),
              "segments",
            );
            // Only 404 means absent; any other failure goes through the error path below instead of a "created" preview
            if (probe.status === 200) segmentStatus = 409;
            else if (probe.status !== 404) segmentStatus = probe.status;
          }

          if (segmentStatus === 201 || segmentStatus === 200) {
            segmentCreated = true;
            console.log(
              Colors.green(
                `  ✓ Segment ${newSegment.key} created (status: ${segmentStatus})`,
              ),
            );
          } else if (segmentStatus === 409) {
            // Segment already exists — resolve according to --on-conflict; our own recorded copy is not a conflict
            const action = attemptCount === 1 && !recordedSegment.recorded
              ? await resolveConflictAction("segment", segmentKey)
              : "overwrite";
            if (action === "abort") {
              // The segment phase is sequential: nothing else is in flight, and this segment was not written
              segmentsAttempted.delete(`${env.key}/${segment.key}`);
              requestAbort("segment", segmentKey);
              await finalizeAbort();
            } else if (action === "skip") {
              console.log(
                Colors.gray(`  → Segment "${segmentKey}" exists, skipping`),
              );
              segmentsSkippedByConflict.add(`${env.key}/${segment.key}`);
              break; // segmentCreated stays false: no patching, no manifest entry
            } else if (
              action === "prefix" && inputArgs.conflictPrefix &&
              attemptCount === 1
            ) {
              // Conflict detected with prefix enabled, retry with prefix
              console.log(
                Colors.yellow(
                  `  ⚠ Segment "${segmentKey}" already exists, retrying with prefix...`,
                ),
              );
              segmentsPrefixedByConflict.add(`${env.key}/${segment.key}`);
              segmentKey = applyConflictPrefix(
                segment.key,
                inputArgs.conflictPrefix,
              );
              segmentName = `${inputArgs.conflictPrefix}${segment.name}`;

              conflictTracker.addResolution({
                originalKey: segment.key,
                resolvedKey: segmentKey,
                resourceType: "segment",
                conflictPrefix: inputArgs.conflictPrefix,
              });
            } else {
              // Overwrite (or second attempt) - segment exists, proceed to update it
              segmentCreated = true;
              segmentAlreadyExisted = true;
              console.log(
                Colors.yellow(
                  `  ⚠ Segment "${segmentKey}" already exists, will update rules...`,
                ),
              );
              break; // Exit retry loop and proceed to patching
            }
          } else {
            console.log(
              Colors.red(
                `  ✗ Error creating segment ${newSegment.key} (status: ${segmentStatus})`,
              ),
            );
            segmentsWithErrors.add(`${destEnvKey}/${segmentKey}`);
            // A 4xx means the API rejected the create: nothing exists under this key (a 5xx is unknown)
            if (segmentStatus >= 400 && segmentStatus < 500) {
              segmentsCreateRejected.add(`${env.key}/${segment.key}`);
            }
            if (segmentStatus > 201) {
              console.log(
                Colors.gray(`  Payload: ${JSON.stringify(newSegment)}`),
              );
            }
            break; // Exit loop on non-conflict errors
          }
        }

        if (segmentCreated && segmentAlreadyExisted) {
          await syncExistingSegmentTags(destEnvKey, segmentKey, segment.tags);
        }

        // Big segments: load members via the CSV import endpoint instead of patches
        if (segmentCreated && isBigSegment) {
          // An empty array is a successful empty export: import it so destination members are cleared
          if (segment._importKeys !== undefined) {
            await importBigSegmentMembers(
              inputArgs.projKeyDest,
              destEnvKey,
              segmentKey,
              segment._importKeys as string[],
            );
          }
        }

        // Build Segment Patches - use the possibly updated segmentKey
        if (segmentCreated && !isBigSegment) {
          const sgmtPatches = [];
          // Target values beyond the per-request batch limit get appended in
          // follow-up patches after the initial replace succeeds.
          const followUpBatches: {
            label: string;
            ops: { op: string; path: string; value: unknown }[];
          }[] = [];
          let targetBudget = SEGMENT_TARGET_BATCH_LIMIT;

          // An existing copy may still hold targets or rules the source no longer has. A field empty in the
          // source is cleared when the destination still has values in it; the destination is read once for
          // that, since a replace on a path the resource lacks would fail the whole patch.
          let destinationSegment: any = null;
          if (segmentAlreadyExisted) {
            const existingResp = await rateLimitRequest(
              ldAPIRequest(
                apiKey,
                domain,
                `segments/${inputArgs.projKeyDest}/${destEnvKey}/${segmentKey}`,
              ),
              "segments",
            );
            if (existingResp.status === 200) {
              destinationSegment = await existingResp.json();
            } else {
              // Removed targeting cannot be cleared: count it as an error so the run fails and the manifest
              // writer drops the segment's cached version instead of recording the stale copy as synced
              console.log(
                Colors.red(
                  `    ✗ Could not read existing segment ${segmentKey} (HTTP ${existingResp.status}); targeting removed in the source is not cleared`,
                ),
              );
              segmentsWithErrors.add(`${destEnvKey}/${segmentKey}`);
            }
          }
          const clearIfRemoved = (field: string): void => {
            if (
              Array.isArray(destinationSegment?.[field]) &&
              destinationSegment[field].length > 0
            ) {
              console.log(
                Colors.gray(`    Clearing ${field}: removed in the source`),
              );
              sgmtPatches.push(buildPatch(field, "replace", []));
            }
          };

          // Legacy user targeting (single context kind) — use replace for idempotency
          for (const field of ["included", "excluded"] as const) {
            const keys: string[] = segment[field] ?? [];
            if (keys.length === 0) {
              clearIfRemoved(field);
              continue;
            }
            const take = Math.min(keys.length, targetBudget);
            sgmtPatches.push(buildPatch(field, "replace", keys.slice(0, take)));
            targetBudget -= take;
            for (
              let i = take;
              i < keys.length;
              i += SEGMENT_TARGET_BATCH_LIMIT
            ) {
              const chunk = keys.slice(i, i + SEGMENT_TARGET_BATCH_LIMIT);
              followUpBatches.push({
                label: `${field} ${i + chunk.length}/${keys.length}`,
                ops: chunk.map((k) => ({
                  op: "add",
                  path: `/${field}/-`,
                  value: k,
                })),
              });
            }
            if (keys.length > take) {
              console.log(Colors.gray(
                `    ${keys.length} ${field} targets exceed the ${SEGMENT_TARGET_BATCH_LIMIT}/request limit; appending the rest in ${
                  Math.ceil((keys.length - take) / SEGMENT_TARGET_BATCH_LIMIT)
                } follow-up patch(es)`,
              ));
            }
          }

          // Multi-context targeting — use replace for the whole array for idempotency
          for (
            const field of ["includedContexts", "excludedContexts"] as const
          ) {
            const entries: { values?: string[] }[] = segment[field] ?? [];
            if (entries.length === 0) {
              clearIfRemoved(field);
              continue;
            }
            const initialEntries: unknown[] = [];
            const overflowOps: { op: string; path: string; value: unknown }[] =
              [];
            entries.forEach((entry, idx) => {
              const values = entry.values ?? [];
              // Every entry keeps at least one value so the replace never
              // writes an entry with an empty target list.
              const take = Math.max(
                Math.min(values.length, 1),
                Math.min(values.length, targetBudget),
              );
              initialEntries.push({ ...entry, values: values.slice(0, take) });
              targetBudget = Math.max(0, targetBudget - take);
              for (const v of values.slice(take)) {
                overflowOps.push({
                  op: "add",
                  path: `/${field}/${idx}/values/-`,
                  value: v,
                });
              }
            });
            sgmtPatches.push(buildPatch(field, "replace", initialEntries));
            console.log(
              Colors.gray(`    Replacing ${entries.length} ${field} entries`),
            );
            for (
              let i = 0;
              i < overflowOps.length;
              i += SEGMENT_TARGET_BATCH_LIMIT
            ) {
              const chunk = overflowOps.slice(
                i,
                i + SEGMENT_TARGET_BATCH_LIMIT,
              );
              followUpBatches.push({
                label: `${field} values ${
                  i + chunk.length
                }/${overflowOps.length} appended`,
                ops: chunk,
              });
            }
          }

          if (segment.rules?.length > 0) {
            console.log(`Copying Segment: ${segmentKey} rules`);
            sgmtPatches.push(buildRulesReplace(segment.rules));
          } else {
            clearIfRemoved("rules");
          }

          const patchRules = await dryRunAwarePatch(
            inputArgs.dryRun || false,
            apiKey,
            domain,
            `segments/${inputArgs.projKeyDest}/${destEnvKey}/${segmentKey}`,
            sgmtPatches,
            false,
            "segments",
            `environment: ${destEnvKey}`, // Pass environment context for better dry-run logging
          );

          const segPatchStatus = patchRules.statusText;
          consoleLogger(
            patchRules.status,
            `Patching segment ${segmentKey} status: ${segPatchStatus}`,
          );
          if (patchRules.status >= 400) {
            // Surface the API's reason — status text alone hides the cause
            // (e.g. which patch operation was rejected and why).
            const errBody = await patchRules.text().catch(() => "");
            console.log(
              Colors.red(
                `    ✗ ${segmentKey} patch rejected: ${errBody.slice(0, 500)}`,
              ),
            );
            segmentsWithErrors.add(`${destEnvKey}/${segmentKey}`);
            console.log(Colors.gray(
              `    Patch ops: ${
                sgmtPatches.map((p) =>
                  `${p.op} ${p.path} (${
                    Array.isArray(p.value)
                      ? p.value.length + " values"
                      : typeof p.value
                  })`
                ).join(", ")
              }`,
            ));
          } else {
            for (const batch of followUpBatches) {
              const appendResp = await dryRunAwarePatch(
                inputArgs.dryRun || false,
                apiKey,
                domain,
                `segments/${inputArgs.projKeyDest}/${destEnvKey}/${segmentKey}`,
                batch.ops,
                false,
                "segments",
                `environment: ${destEnvKey}`,
              );
              consoleLogger(
                appendResp.status,
                `    Appending ${segmentKey} targets (${batch.label}): ${appendResp.statusText}`,
              );
              if (appendResp.status >= 400) {
                const errBody = await appendResp.text().catch(() => "");
                console.log(
                  Colors.red(
                    `    ✗ ${segmentKey} target append rejected: ${
                      errBody.slice(0, 500)
                    }`,
                  ),
                );
                segmentsWithErrors.add(`${destEnvKey}/${segmentKey}`);
                break;
              }
            }
          }
        }

        // Track segment version for sync manifest only if it was actually created/patched
        if (segmentCreated) {
          if (!updatedManifestSegments[env.key]) {
            updatedManifestSegments[env.key] = emptyRecord();
          }
          updatedManifestSegments[env.key][segment.key] = withExtraDestKeys(
            {
              version: segment.version ?? 0,
              lastModified: segment.lastModifiedDate,
              ...(segmentKey !== segment.key && { destKey: segmentKey }),
              destEnv: destEnvKey,
            },
            ownEntry(
              ownEntry(previousManifest?.segments, env.key),
              segment.key,
            ),
            segment.key,
          );
        }
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(
      Colors.red(`\n❌ Segment migration failed unexpectedly: ${msg}`),
    );
    await persistAndExit(`segment phase failed: ${msg.slice(0, 200)}`);
  }
} else {
  console.log(Colors.gray("  Segment migration disabled, skipping..."));
}

// ==================== Semantic Patch Conversion ====================
// Converts JSON Patch operations to LaunchDarkly's Semantic Patch format

type VariationIdMapper = (index: number) => string | undefined;
type SemanticInstruction = Record<string, any>;
type ConversionResult = {
  instructions: SemanticInstruction[];
  skippedFields: string[];
};

/**
 * Creates a variation ID mapper from flag variations
 */
const createVariationMapper =
  (variations: any[]): VariationIdMapper => (index: number) =>
    variations[index]?._id;

/**
 * Extracts the environment field name from a JSON Patch path
 */
const extractFieldFromPath = (path: string): string | null => {
  const pathParts = path.split("/");
  const envIndex = pathParts.indexOf("environments");
  return envIndex !== -1 ? pathParts[envIndex + 2] : null;
};

/**
 * Converts rollout variations from indices to UUIDs
 */
const convertRolloutVariations = (
  rollout: any,
  getVariationId: VariationIdMapper,
) => ({
  ...rollout,
  variations: rollout.variations?.map((v: any) => ({
    ...v,
    variation: getVariationId(v.variation) || v.variation,
  })),
});

/**
 * Converts a flag on/off patch to semantic instruction
 */
const convertOnOffInstruction = (value: boolean): SemanticInstruction => ({
  kind: value ? "turnFlagOn" : "turnFlagOff",
});

/**
 * Converts an off variation patch to semantic instruction
 */
const convertOffVariationInstruction = (
  value: number,
  getVariationId: VariationIdMapper,
): SemanticInstruction | null => {
  const variationId = getVariationId(value);
  return variationId ? { kind: "updateOffVariation", variationId } : null;
};

/**
 * Converts a fallthrough patch to semantic instruction
 */
const convertFallthroughInstruction = (
  value: any,
  getVariationId: VariationIdMapper,
): SemanticInstruction | null => {
  const instruction: SemanticInstruction = {
    kind: "updateFallthroughVariationOrRollout",
  };

  if (value.variation !== undefined) {
    const variationId = getVariationId(value.variation);
    if (variationId) {
      instruction.variationId = variationId;
    }
  } else if (value.rollout) {
    instruction.rollout = convertRolloutVariations(
      value.rollout,
      getVariationId,
    );
  }

  return (instruction.variationId || instruction.rollout) ? instruction : null;
};

/**
 * Converts a rule patch to semantic instruction
 */
const convertRuleInstruction = (
  patch: any,
  getVariationId: VariationIdMapper,
): SemanticInstruction | null => {
  if (patch.op !== "add" || !patch.path.includes("rules/-")) {
    return null;
  }

  const instruction: SemanticInstruction = {
    kind: "addRule",
    clauses: patch.value.clauses || [],
    ...(patch.value.description && { description: patch.value.description }),
  };

  if (patch.value.variation !== undefined) {
    const variationId = getVariationId(patch.value.variation);
    if (variationId) {
      instruction.variationId = variationId;
    }
  } else if (patch.value.rollout) {
    instruction.rollout = convertRolloutVariations(
      patch.value.rollout,
      getVariationId,
    );
  }

  return instruction;
};

/**
 * Converts a single JSON Patch to a semantic instruction
 */
const convertPatchToSemanticInstruction = (
  patch: any,
  getVariationId: VariationIdMapper,
): {
  instruction: SemanticInstruction | null;
  shouldSkip: boolean;
  multipleInstructions?: SemanticInstruction[];
} => {
  const field = extractFieldFromPath(patch.path);
  if (!field) return { instruction: null, shouldSkip: false };

  switch (field) {
    case "on":
      return {
        instruction: convertOnOffInstruction(patch.value),
        shouldSkip: false,
      };
    case "offVariation":
      // Semantic patches have no instruction that clears the off variation (the source serves the SDK
      // fallback while off); report it as skipped so it shows up under the approval's skipped fields
      if (patch.op === "remove") return { instruction: null, shouldSkip: true };
      return {
        instruction: convertOffVariationInstruction(
          patch.value,
          getVariationId,
        ),
        shouldSkip: false,
      };
    case "fallthrough":
      return {
        instruction: convertFallthroughInstruction(patch.value, getVariationId),
        shouldSkip: false,
      };
    case "rules":
      // Handle replace op on entire rules array
      if (patch.op === "replace" && Array.isArray(patch.value)) {
        // NOTE: The LD semantic patch API has no "removeAllRules" instruction.
        // For approval-required envs, old rules won't be auto-removed.
        if (patch.value.length > 0) {
          console.log(
            Colors.yellow(
              `\t    ⚠ Approval workflow: converting rules replace to addRule instructions (existing rules cannot be removed via semantic patch)`,
            ),
          );
        }
        const instructions = patch.value.map((rule: any) => {
          const inst: SemanticInstruction = {
            kind: "addRule",
            clauses: rule.clauses || [],
          };
          if (rule.description) inst.description = rule.description;
          if (rule.variation !== undefined) {
            const vid = getVariationId(rule.variation);
            if (vid) inst.variationId = vid;
          } else if (rule.rollout) {
            inst.rollout = convertRolloutVariations(
              rule.rollout,
              getVariationId,
            );
          }
          return inst;
        });
        return {
          instruction: null,
          shouldSkip: false,
          multipleInstructions: instructions,
        };
      }
      return {
        instruction: convertRuleInstruction(patch, getVariationId),
        shouldSkip: false,
      };
    case "trackEvents":
      return { instruction: null, shouldSkip: true };
    default:
      return { instruction: null, shouldSkip: true };
  }
};

/**
 * Convert JSON Patch format to Semantic Patch format for approval requests
 */
const convertToSemanticPatch = (
  jsonPatches: any[],
  _envKey: string,
  variations: any[],
): ConversionResult => {
  const getVariationId = createVariationMapper(variations);
  const skippedFields = new Set<string>();

  const instructions = jsonPatches.reduce<SemanticInstruction[]>(
    (acc, patch) => {
      const { instruction, shouldSkip, multipleInstructions } =
        convertPatchToSemanticInstruction(patch, getVariationId);

      if (shouldSkip) {
        const field = extractFieldFromPath(patch.path);
        if (field) skippedFields.add(field);
      }

      if (multipleInstructions) {
        acc.push(...multipleInstructions);
      } else if (instruction) {
        acc.push(instruction);
      }

      return acc;
    },
    [],
  );

  if (skippedFields.size > 0) {
    console.log(Colors.gray(
      `\t    ⓘ Skipped fields (set manually after approval): ${
        Array.from(skippedFields).join(", ")
      }`,
    ));
  }

  return {
    instructions,
    skippedFields: Array.from(skippedFields),
  };
};

// ==================== Approval Request Management ====================

type ApprovalRequest = { _id: string; status: string };
type ApprovalRequestBody = {
  description: string;
  instructions: SemanticInstruction[];
  notifyMemberIds?: string[];
};

/**
 * Checks if an approval request is active (should prevent duplicate creation)
 */
const isActiveApprovalRequest = (request: ApprovalRequest): boolean => {
  const activeStatuses = ["pending", "scheduled", "failed"];
  return activeStatuses.includes(request.status);
};

/**
 * Finds active approval requests for a flag environment
 */
const findActiveApprovalRequests = async (
  flagKey: string,
  env: string,
): Promise<ApprovalRequest[]> => {
  const listApprovalsReq = ldAPIRequest(
    apiKey,
    domain,
    `projects/${inputArgs.projKeyDest}/flags/${flagKey}/environments/${env}/approval-requests`,
  );

  const response = await rateLimitRequest(
    listApprovalsReq,
    "approval-requests",
  );

  if (response.status !== 200) {
    return [];
  }

  const data = await response.json();
  return (data.items || []).filter(isActiveApprovalRequest);
};

/**
 * Determines who should be notified about an approval request
 * Priority: 1. Flag maintainer, 2. Authenticated member, 3. No one
 */
const determineNotificationRecipients = (
  maintainerId: string | null,
  fallbackMemberId: string | null,
): { recipients: string[]; warning: string | null } => {
  if (maintainerId) {
    return { recipients: [maintainerId], warning: null };
  }

  if (fallbackMemberId) {
    return {
      recipients: [fallbackMemberId],
      warning: "No maintainer mapped, notifying creating member",
    };
  }

  return {
    recipients: [],
    warning: "No one to notify (service token used and no maintainer)",
  };
};

/**
 * Creates an approval request body
 */
const createApprovalRequestBody = (
  flagKey: string,
  env: string,
  instructions: SemanticInstruction[],
  maintainerId: string | null,
  fallbackMemberId: string | null,
): { body: ApprovalRequestBody; warning: string | null } => {
  const { recipients, warning } = determineNotificationRecipients(
    maintainerId,
    fallbackMemberId,
  );

  const body: ApprovalRequestBody = {
    description:
      `Migration of flag "${flagKey}" environment "${env}" from project "${inputArgs.projKeySource}"`,
    instructions,
  };

  if (recipients.length > 0) {
    body.notifyMemberIds = recipients;
  }

  return { body, warning };
};

/**
 * Tracks an approval request and its skipped fields
 */
const trackApprovalRequest = (
  flagKey: string,
  env: string,
  skippedFields: string[],
): void => {
  approvalRequestsCreated.push({ flag: flagKey, env, skippedFields });

  if (skippedFields.length > 0) {
    if (!skippedFieldsByFlag.has(flagKey)) {
      skippedFieldsByFlag.set(flagKey, new Set());
    }
    const flagSkipped = skippedFieldsByFlag.get(flagKey)!;
    skippedFields.forEach((field) => flagSkipped.add(field));
  }
};

/**
 * Handles approval request creation when direct patch fails with 405
 */
const handleApprovalWorkflow = async (
  flagKey: string,
  env: string,
  patchReq: any[],
  maintainerId: string | null,
  fallbackMemberId: string | null,
  variations: any[],
): Promise<void> => {
  console.log(
    Colors.cyan(
      `\t  → ${env}: Requires approval, checking for existing requests...`,
    ),
  );

  try {
    // Check for existing active approval requests
    const activeApprovals = await findActiveApprovalRequests(flagKey, env);

    if (activeApprovals.length > 0) {
      const approval = activeApprovals[0];
      console.log(Colors.yellow(
        `\t  ⚠ ${env}: Existing approval request found (ID: ${approval._id}, status: ${approval.status})`,
      ));
      console.log(Colors.gray(`\t    Skipping creation to avoid duplicates`));

      trackApprovalRequest(flagKey, env, []); // Don't know existing request's skipped fields
      return;
    }

    // Convert patches to semantic instructions
    console.log(
      Colors.gray(
        `\t    No existing requests, creating new approval request...`,
      ),
    );
    const conversionResult = convertToSemanticPatch(patchReq, env, variations);

    console.log(Colors.gray(
      `\t    Converting ${patchReq.length} JSON patches → ${conversionResult.instructions.length} semantic instructions`,
    ));

    if (conversionResult.instructions.length === 0) {
      console.log(
        Colors.yellow(
          `\t  ⚠ ${env}: No valid instructions to approve, skipping`,
        ),
      );
      return;
    }

    // Create approval request body
    const { body, warning } = createApprovalRequestBody(
      flagKey,
      env,
      conversionResult.instructions,
      maintainerId,
      fallbackMemberId,
    );

    if (warning) {
      console.log(Colors.gray(`\t    ${warning}`));
    }

    // Submit approval request
    const approvalResp = await dryRunAwarePost(
      inputArgs.dryRun || false,
      apiKey,
      domain,
      `projects/${inputArgs.projKeyDest}/flags/${flagKey}/environments/${env}/approval-requests`,
      body,
      false,
      "approval-requests",
    );

    if (approvalResp.status >= 200 && approvalResp.status < 300) {
      console.log(Colors.green(`\t  ✓ ${env}: Approval request created`));
      trackApprovalRequest(flagKey, env, conversionResult.skippedFields);
    } else {
      const errorBody = await approvalResp.text();
      console.log(Colors.yellow(
        `\t  ⚠ ${env}: Failed to create approval request (status: ${approvalResp.status})`,
      ));
      console.log(Colors.gray(`\t    API response: ${errorBody}`));
      flagsWithErrors.add(flagKey);
    }
  } catch {
    console.log(Colors.red(`\t  ✗ ${env}: Error creating approval request`));
    flagsWithErrors.add(flagKey);
  }
};

/**
 * Handles the result of a patch request
 */
const handlePatchResponse = async (
  status: number,
  response: Response,
  flagKey: string,
  env: string,
): Promise<void> => {
  if (status >= 400) {
    flagsWithErrors.add(flagKey);
    console.log(Colors.red(`\t  ✗ ${env}: Error ${status}`));

    if (status === 400) {
      const errorBody = await response.text();
      console.log(Colors.red(`\t    ${errorBody}`));
    }
  } else if (status > 201) {
    console.log(Colors.yellow(`\t  ⚠ ${env}: Status ${status}`));
  } else {
    console.log(Colors.green(`\t  ✓ ${env}: updated`));
  }
};

/**
 * Checks if a patch would actually change the environment configuration
 * Returns true if changes are needed, false if environment is already in desired state
 */
const wouldPatchChangeEnvironment = (
  currentEnvConfig: any,
  patchOperations: any[],
  _variations: any[],
): boolean => {
  // If no current config, changes are needed
  if (!currentEnvConfig) return true;

  // Check each patch operation to see if it would actually change something
  for (const patch of patchOperations) {
    const pathParts = patch.path.split("/");
    // Path format: /environments/{envKey}/{field} or /environments/{envKey}/rules/-

    if (pathParts.length < 4) continue;

    const field = pathParts[3];

    // Get current value from the environment config
    const currentValue = currentEnvConfig[field];

    switch (patch.op) {
      case "replace":
        if (field === "rules") {
          // Strip internal fields from current rules before comparing
          const cleanCurrent = (currentEnvConfig.rules || []).map(
            (rule: any) => {
              const { _id, _generation, _deleted, _version, _ref, ...rest } =
                rule;
              return {
                ...rest,
                clauses: (rest.clauses || []).map(({ _id, ...c }: any) => c),
              };
            },
          );
          if (JSON.stringify(cleanCurrent) !== JSON.stringify(patch.value)) {
            return true;
          }
        } else if (field === "offVariation" || field === "on") {
          if (currentValue !== patch.value) return true;
        } else {
          if (JSON.stringify(currentValue) !== JSON.stringify(patch.value)) {
            return true;
          }
        }
        break;

      case "add":
        // add operations always indicate a change
        return true;

      case "remove":
        if (currentValue !== undefined && currentValue !== null) {
          return true;
        }
        break;

      default:
        return true;
    }
  }

  // If we got here, no meaningful changes were detected
  return false;
};

/**
 * Makes a patch call to update flag environment configuration
 * Handles approval workflows when direct patching requires approval (405)
 * Retries 404s after a delay (environment may not be ready yet)
 * Skips patch if environment is already in desired state
 */
// Segment keys per source environment from the extracted data; null when not extracted.
// Segment files are only trusted when the extraction that produced the flag data also extracted
// segments (extraction.json): with segment extraction disabled, older segment files stay on disk
// and would misclassify a segment created since as a dangling reference.
const sourceSegmentKeysCache = new Map<string, Set<string> | null>();
let extractionIncludedSegments: boolean | null = null;
async function segmentsFromSameExtraction(): Promise<boolean> {
  if (extractionIncludedSegments === null) {
    try {
      const meta = JSON.parse(
        await Deno.readTextFile(
          `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/extraction.json`,
        ),
      );
      extractionIncludedSegments = meta.extractSegments === true;
    } catch (_) {
      extractionIncludedSegments = false; // no metadata (older extraction): cannot establish
    }
  }
  return extractionIncludedSegments;
}
// Environments whose patch was applied without one or more dead rules, keyed flag\0destEnv.
// Their version is left out of the sync manifest so --incremental reconsiders them.
const envsWithDroppedRules = new Set<string>();
async function segmentAbsentInSource(
  sourceEnv: string,
  segmentKey: string,
): Promise<boolean> {
  if (!(await segmentsFromSameExtraction())) return false;
  if (!sourceSegmentKeysCache.has(sourceEnv)) {
    try {
      const data = JSON.parse(
        await Deno.readTextFile(
          `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/segments/${sourceEnv}.json`,
        ),
      );
      sourceSegmentKeysCache.set(
        sourceEnv,
        new Set((data.items ?? []).map((s: any) => s.key)),
      );
    } catch (_) {
      sourceSegmentKeysCache.set(sourceEnv, null); // segments not extracted: absence cannot be established
    }
  }
  const keys = sourceSegmentKeysCache.get(sourceEnv);
  return keys !== null && keys !== undefined && !keys.has(segmentKey);
}

const makePatchCall = async (
  flagKey: string,
  patchReq: any[],
  env: string,
  maintainerId: string | null,
  fallbackMemberId: string | null,
  variations: any[],
  destinationFlag: any,
  sourceEnv: string,
  retryCount: number = 0,
  unknownSegmentRetried: boolean = false,
): Promise<Set<string>> => {
  // Check if this patch would actually change anything
  const currentEnvConfig = destinationFlag?.environments?.[env];
  const hasChanges = wouldPatchChangeEnvironment(
    currentEnvConfig,
    patchReq,
    variations,
  );

  if (!hasChanges) {
    console.log(Colors.gray(`\t  ✓ ${env}: Already up to date, skipping`));
    return flagsWithErrors;
  }

  console.log(Colors.cyan(`\t  → ${env}: applying changes`));
  const patchFlagReq = await dryRunAwarePatch(
    inputArgs.dryRun || false,
    apiKey,
    domain,
    `flags/${inputArgs.projKeyDest}/${flagKey}`,
    patchReq,
    false,
    "flags",
    `environment: ${env}`, // Pass environment context for better dry-run logging
  );

  const flagPatchStatus = patchFlagReq.status;

  if (flagPatchStatus === 404 && retryCount < 2) {
    // Environment not ready yet, wait and retry
    console.log(
      Colors.gray(
        `\t  ⏳ ${env}: Environment not ready, retrying in 3s... (attempt ${
          retryCount + 1
        }/2)`,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return await makePatchCall(
      flagKey,
      patchReq,
      env,
      maintainerId,
      fallbackMemberId,
      variations,
      destinationFlag,
      sourceEnv,
      retryCount + 1,
      unknownSegmentRetried,
    );
  } else if (flagPatchStatus === 405) {
    // Environment requires approval workflow
    await handleApprovalWorkflow(
      flagKey,
      env,
      patchReq,
      maintainerId,
      fallbackMemberId,
      variations,
    );
  } else if (flagPatchStatus === 400 && !unknownSegmentRetried) {
    // A rule referencing a segment that does not exist in this destination environment is
    // rejected as a whole patch. Such a rule can never match, so drop it, retry once, and
    // report it under the flag's skipped fields.
    const errorBody = await patchFlagReq.text();
    const segmentKey = unknownSegmentFromError(errorBody);
    // `env` is the destination environment key; `sourceEnv` is the environment this patch was built
    // from (passed by the caller, so many-to-one mappings check the right one). The segment must be
    // a dangling reference in the source too, not a segment we failed to migrate, before dropping.
    const absentInSource = segmentKey
      ? await segmentAbsentInSource(sourceEnv, segmentKey)
      : false;
    if (segmentKey && absentInSource) {
      const { patches: stripped, removed, unsafe } =
        stripRulesReferencingSegment(patchReq, env, segmentKey);
      if (unsafe.length > 0) {
        console.log(
          Colors.red(
            `\t  ✗ ${env}: segment "${segmentKey}" is unknown, but ${unsafe.length} rule(s) reference it alongside other segments or negated (${
              unsafe.join(", ")
            }); not removed automatically`,
          ),
        );
      } else if (removed.length > 0) {
        console.log(
          Colors.yellow(
            `\t  ⚠ ${env}: segment "${segmentKey}" does not exist in source or destination; dropping ${removed.length} dead rule(s) and retrying`,
          ),
        );
        if (!skippedFieldsByFlag.has(flagKey)) {
          skippedFieldsByFlag.set(flagKey, new Set());
        }
        for (const r of removed) {
          skippedFieldsByFlag.get(flagKey)!.add(
            `${env}: ${r} (references unknown segment "${segmentKey}")`,
          );
        }
        envsWithDroppedRules.add(`${flagKey}\u0000${env}`);
        return await makePatchCall(
          flagKey,
          stripped,
          env,
          maintainerId,
          fallbackMemberId,
          variations,
          destinationFlag,
          sourceEnv,
          retryCount,
          true,
        );
      }
    } else if (segmentKey) {
      console.log(
        Colors.red(
          `\t  ✗ ${env}: segment "${segmentKey}" exists in the source environment (${sourceEnv}) but not in the destination; migrate segments first`,
        ),
      );
    }
    flagsWithErrors.add(flagKey);
    console.log(Colors.red(`\t  ✗ ${env}: Error 400`));
    console.log(Colors.red(`\t    ${errorBody}`));
  } else {
    await handlePatchResponse(flagPatchStatus, patchFlagReq, flagKey, env);
  }

  return flagsWithErrors;
};

console.log(Colors.blue("\n🚩 Starting flag migration..."));
// flagsWithErrors and flagsSkippedByDate are declared with the shared tracking state above the segment phase
const approvalRequestsCreated: Array<
  { flag: string; env: string; skippedFields: string[] }
> = [];
const skippedFieldsByFlag: Map<string, Set<string>> = new Map();

let sinceDate: Date | null = null;
if (inputArgs.since) {
  sinceDate = new Date(inputArgs.since);
  if (isNaN(sinceDate.getTime())) {
    console.log(
      Colors.red(
        `Error: Invalid --since date: "${inputArgs.since}". Use ISO 8601 format (e.g., 2026-01-15).`,
      ),
    );
    Deno.exit(1);
  }
  console.log(
    Colors.cyan(
      `\n📋 Since filter: only syncing flags modified after ${sinceDate.toISOString()}`,
    ),
  );
}

interface Variation {
  _id: string;
  value: any;
  name?: string;
  description?: string;
}

// Creating Global Flags //
const CONCURRENCY = Math.max(1, inputArgs.concurrency ?? 10);
console.log(
  Colors.blue(
    `\n🏁 Creating ${flagList.length} flags in destination project (concurrency: ${CONCURRENCY})...\n`,
  ),
);

interface FlagProcessResult {
  incrementalSkipCountDelta: number;
  incrementalEnvSkipCountDelta: number;
}

async function processOneFlag(
  index: number,
  flagkey: string,
): Promise<FlagProcessResult> {
  let incrementalSkipCountDelta = 0;
  let incrementalEnvSkipCountDelta = 0;

  // An abort is pending: start nothing new (this flag keeps its previous manifest entry, if any)
  if (abortRequested) {
    return { incrementalSkipCountDelta, incrementalEnvSkipCountDelta };
  }

  // Read flag
  console.log(
    Colors.cyan(
      `\n[${index + 1}/${flagList.length}] Processing flag: ${flagkey}`,
    ),
  );

  const flag = await getFlagDataByIndexOrKey(index, flagkey);

  if (!flag) {
    // Counted as an error: the flag was not examined, so the run must not report success or clear an
    // incomplete manifest marker on its account
    console.log(
      Colors.red(`\t✗ Could not load extracted flag data for ${flagkey}`),
    );
    flagsWithErrors.add(flagkey);
    flagErrorDetails.set(flagkey, "extracted flag data could not be loaded");
    return { incrementalSkipCountDelta: 0, incrementalEnvSkipCountDelta: 0 };
  }

  // Incremental sync: check if flag-level AND all environment versions match
  // Flag-level _version alone isn't reliable — LD doesn't always bump it for env-only changes
  if (
    inputArgs.incremental && previousManifest && flag._version !== undefined
  ) {
    const prevEntry = ownEntry(previousManifest.flags, flag.key);
    if (prevEntry && prevEntry.version === flag._version) {
      // Flag-level version matches — check if all environment versions also match
      let allEnvsUnchanged = true;
      if (flag.environments && prevEntry.environments) {
        for (const envKey of envkeys) {
          const envData = flag.environments[envKey];
          const prevEnvData = prevEntry.environments[envKey];
          if (
            envData && prevEnvData && envData.version !== prevEnvData.version
          ) {
            allEnvsUnchanged = false;
            break;
          }
          if (envData && !prevEnvData) {
            allEnvsUnchanged = false;
            break;
          }
        }
      }
      if (allEnvsUnchanged) {
        // Sync lifecycle (archived/deprecated) even when versions match — LD may not bump version for lifecycle-only
        // changes — and reconcile migration tags, which are not part of the source version either.
        // The destination key comes from the manifest, so a flag renamed by a conflict prefix is patched, not its namesake.
        const destKey = prevEntry.destKey ?? flag.key;
        let lifecycleSynced = false;
        // A failed read or patch here leaves lifecycle/tags unsynced; record it so the summary and exit code say so
        const reconcileFailed = (detail: string) => {
          console.log(Colors.red(`\t  ✗ ${destKey}: ${detail}`));
          flagsWithErrors.add(flag.key);
          flagErrorDetails.set(
            flag.key,
            `lifecycle/tags reconcile failed: ${detail.slice(0, 300)}`,
          );
        };
        try {
          const destReq = ldAPIRequest(
            apiKey,
            domain,
            `flags/${inputArgs.projKeyDest}/${destKey}`,
          );
          const destResp = await rateLimitRequest(destReq, "flags");
          if (destResp.status !== 200) {
            reconcileFailed(
              `could not read destination flag (HTTP ${destResp.status})`,
            );
          } else {
            const destFlag = await destResp.json();
            const changed = (a: any, b: any) =>
              JSON.stringify(a) !== JSON.stringify(b);
            const lifecyclePatches: any[] = [];
            if (
              flag.archived !== undefined &&
              changed(flag.archived, destFlag.archived)
            ) {
              lifecyclePatches.push(
                buildPatch("archived", "replace", flag.archived),
              );
            }
            if (
              flag.deprecated !== undefined &&
              changed(flag.deprecated, destFlag.deprecated)
            ) {
              lifecyclePatches.push(
                buildPatch("deprecated", "replace", flag.deprecated),
              );
            }
            // deprecatedDate is API-managed (stamped when `deprecated` flips); a lone replace is rejected.
            if (migrationTags.length > 0) {
              const desiredTags = mergeTags(
                flag.tags,
                migrationTags,
                destFlag.tags,
              );
              if (changed(desiredTags, destFlag.tags ?? [])) {
                lifecyclePatches.push(
                  buildPatch("tags", "replace", desiredTags),
                );
              }
            }
            if (lifecyclePatches.length > 0) {
              const patchResp = await dryRunAwarePatch(
                inputArgs.dryRun || false,
                apiKey,
                domain,
                `flags/${inputArgs.projKeyDest}/${destKey}`,
                lifecyclePatches,
                false,
                "flags",
                "lifecycle (archived/deprecated) and tags",
              );
              if (patchResp.status >= 200 && patchResp.status < 300) {
                console.log(
                  Colors.gray(
                    `\t  → synced ${
                      lifecyclePatches.map((p) => p.path.replace(/^\//, ""))
                        .join(
                          ", ",
                        )
                    }`,
                  ),
                );
                lifecycleSynced = true;
              } else {
                reconcileFailed(
                  `patch of ${
                    lifecyclePatches.map((p) => p.path.replace(/^\//, "")).join(
                      ", ",
                    )
                  } failed (HTTP ${patchResp.status}): ${
                    (await patchResp.text()).slice(0, 200)
                  }`,
                );
              }
            }
          }
        } catch (error) {
          reconcileFailed(
            error instanceof Error ? error.message : String(error),
          );
        }
        const ts = flag.creationDate ? `, updated ${flag.creationDate}` : "";
        console.log(
          Colors.gray(
            `\t✓ ${flag.key}: unchanged (v${flag._version}${ts})${
              lifecycleSynced ? ", lifecycle/tags synced" : ""
            }, skipping`,
          ),
        );
        // Carry forward the previous manifest entry unchanged
        updatedManifestFlags[flag.key] = prevEntry;
        incrementalSkipCountDelta++;
        return { incrementalSkipCountDelta, incrementalEnvSkipCountDelta };
      }
    }
  }

  // --since filter: skip flags not modified after the given date
  if (sinceDate && flag.environments) {
    const latestModified = Object.values(flag.environments).reduce(
      (latest: number, env: any) => {
        const envDate = env?.lastModified
          ? new Date(env.lastModified).getTime()
          : 0;
        return Math.max(latest, envDate);
      },
      0,
    );
    if (latestModified > 0 && latestModified < sinceDate.getTime()) {
      console.log(
        Colors.gray(
          `\t✓ ${flag.key}: not modified since ${inputArgs.since}, skipping`,
        ),
      );
      flagsSkippedByDate.add(flag.key);
      incrementalSkipCountDelta++;
      return { incrementalSkipCountDelta, incrementalEnvSkipCountDelta };
    }
  }

  if (!flag.variations) {
    console.log(Colors.yellow(`\t⚠ No variations, skipping`));
    return { incrementalSkipCountDelta, incrementalEnvSkipCountDelta };
  }

  if (!flag.key || flag.key.trim() === "") {
    console.log(
      Colors.red(`\t✗ ERROR: Flag data has empty key! Expected: "${flagkey}"`),
    );
    return { incrementalSkipCountDelta, incrementalEnvSkipCountDelta };
  }

  const newVariations = flag.variations.map(({ _id, ...rest }: Variation) =>
    rest
  );

  // A previous manifest entry under another key names this migration's own earlier copy (conflict
  // prefix): update it instead of creating a second prefixed duplicate
  const recorded = recordedDestination(
    ownEntry(previousManifest?.flags, flag.key),
    flag,
    inputArgs.conflictPrefix,
  );
  let flagKey = recorded.key;
  let flagName = recorded.name;
  let attemptCount = 0;
  let flagCreated = false;
  let createdFlagKey = flagKey;
  let flagMaintainerId: string | null = null;
  let flagAlreadyExisted = false;

  flagsAttempted.add(flag.key);
  // First, check if the flag already exists in the destination
  try {
    const checkFlagReq = ldAPIRequest(
      apiKey,
      domain,
      `flags/${inputArgs.projKeyDest}/${flagKey}`,
    );
    const checkFlagResp = await rateLimitRequest(checkFlagReq, "flags");

    if (checkFlagResp.status === 200 && recorded.recorded) {
      // Our own earlier copy, recorded in the manifest: not a conflict, update it in place
      flagCreated = true;
      flagAlreadyExisted = true;
      createdFlagKey = flagKey;
      console.log(
        Colors.gray(
          `\t→ Updating the copy recorded in the sync manifest (${flagKey})`,
        ),
      );
    } else if (checkFlagResp.status === 200) {
      // Flag already exists — resolve according to --on-conflict
      const action = await resolveConflictAction("flag", flagKey);
      if (action === "abort") {
        // The conflicting flag was not written: it is not an in-flight write of ours
        flagsAttempted.delete(flag.key);
        requestAbort("flag", flagKey);
        return { incrementalSkipCountDelta, incrementalEnvSkipCountDelta };
      } else if (action === "skip") {
        console.log(
          Colors.gray(`\t→ Flag already exists, skipping (--on-conflict)`),
        );
        flagsSkippedByConflict.add(flag.key);
        return { incrementalSkipCountDelta, incrementalEnvSkipCountDelta };
      } else if (action === "prefix" && inputArgs.conflictPrefix) {
        // Conflict prefix enabled - we'll try creating with prefix
        console.log(
          Colors.yellow(
            `\t⚠ Flag exists, will try with prefix "${inputArgs.conflictPrefix}"`,
          ),
        );
        flagsPrefixedByConflict.add(flag.key);
        flagKey = applyConflictPrefix(flag.key, inputArgs.conflictPrefix);
        flagName = `${inputArgs.conflictPrefix}${flag.name}`;
        flagAlreadyExisted = false; // Will attempt creation with prefixed key

        conflictTracker.addResolution({
          originalKey: flag.key,
          resolvedKey: flagKey,
          resourceType: "flag",
          conflictPrefix: inputArgs.conflictPrefix,
        });
      } else {
        // Overwrite - update existing flag
        flagCreated = true;
        flagAlreadyExisted = true;
        createdFlagKey = flagKey;
        console.log(
          Colors.gray(`\t⚠ Flag already exists, will update environments...`),
        );
      }
    } else if (checkFlagResp.status === 404) {
      // Flag doesn't exist, we'll create it
      flagAlreadyExisted = false;
    }
  } catch {
    // If check fails, proceed with creation attempt
    console.log(
      Colors.gray(
        `\t  Could not check if flag exists, will attempt creation...`,
      ),
    );
  }

  while (!flagCreated && attemptCount < 2) {
    attemptCount++;

    const newFlag: any = {
      key: flagKey,
      name: flagName,
      variations: newVariations,
      temporary: flag.temporary,
      description: flag.description,
      maintainerId: null, // Set to null by default to prevent API from assigning token owner
    };
    const flagTags = mergeTags(flag.tags, migrationTags);
    if (flagTags.length > 0) newFlag.tags = flagTags;
    // Only assign maintainerId if explicitly requested and mapping exists
    if (inputArgs.assignMaintainerIds) {
      if (flag.maintainerId && maintainerMapping[flag.maintainerId]) {
        newFlag.maintainerId = maintainerMapping[flag.maintainerId];
        flagMaintainerId = newFlag.maintainerId;
      } else {
        newFlag.maintainerId = null;
      }
    } else {
      newFlag.maintainerId = null;
    }

    if (flag.clientSideAvailability) {
      newFlag.clientSideAvailability = flag.clientSideAvailability;
    } else if (flag.includeInSnippet) {
      newFlag.includeInSnippet = flag.includeInSnippet;
    }
    if (flag.customProperties) {
      newFlag.customProperties = flag.customProperties;
    }

    if (flag.defaults) {
      newFlag.defaults = flag.defaults;
    }

    // Sync lifecycle state so archived/deprecated match source
    if (flag.archived !== undefined) newFlag.archived = flag.archived;
    if (flag.deprecated !== undefined) newFlag.deprecated = flag.deprecated;
    if (flag.deprecatedDate !== undefined) {
      newFlag.deprecatedDate = flag.deprecatedDate;
    }

    // Skip the creation POST if flag already exists
    if (!flagAlreadyExisted) {
      // Collect view associations for flag creation
      // API supports "viewKeys" (plural, array) field during creation (NO beta header needed)
      const viewKeys: string[] = [];

      // Add target view if specified (highest priority)
      if (inputArgs.targetView) {
        viewKeys.push(inputArgs.targetView);
      }

      // Add source flag's view associations (if not already added)
      if (migrateViews && flag.viewKeys && Array.isArray(flag.viewKeys)) {
        flag.viewKeys.forEach((viewKey: string) => {
          if (!viewKeys.includes(viewKey)) {
            viewKeys.push(viewKey);
          }
        });
      }

      // Add viewKeys to newFlag if any views specified
      if (viewKeys.length > 0) {
        (newFlag as any).viewKeys = viewKeys;
      }

      const flagResp = await dryRunAwarePost(
        inputArgs.dryRun || false,
        apiKey,
        domain,
        `flags/${inputArgs.projKeyDest}`,
        newFlag,
        false, // Standard API (no beta header needed for viewKeys)
        "flags",
      );

      if (flagResp.status == 200 || flagResp.status == 201) {
        flagCreated = true;
        createdFlagKey = flagKey;
        if (viewKeys.length > 0) {
          console.log(
            Colors.green(
              `\t✓ Created and linked to view(s): ${viewKeys.join(", ")}`,
            ),
          );
        } else {
          console.log(Colors.green(`\t✓ Created`));
        }
      } else if (flagResp.status === 409) {
        // The flag appeared between the existence check and the POST, or the check itself failed.
        // Without a prefix it is treated like a flag found by the check: flag-level properties
        // (name, tags, variations, lifecycle, ...) and environments are updated below.
        // A recorded copy is never prefixed, even when the existence probe failed and only the POST saw it
        if (
          inputArgs.conflictPrefix && attemptCount === 1 && !recorded.recorded
        ) {
          // Conflict detected with prefix enabled, retry with prefix
          console.log(
            Colors.yellow(
              `\t⚠ Conflict detected, retrying with prefix "${inputArgs.conflictPrefix}"`,
            ),
          );
          flagsPrefixedByConflict.add(flag.key);
          flagKey = applyConflictPrefix(flag.key, inputArgs.conflictPrefix);
          flagName = `${inputArgs.conflictPrefix}${flag.name}`;
          flagAlreadyExisted = false; // Reset to attempt creation with new key

          conflictTracker.addResolution({
            originalKey: flag.key,
            resolvedKey: flagKey,
            resourceType: "flag",
            conflictPrefix: inputArgs.conflictPrefix,
          });
        } else {
          // No prefix or second attempt - flag exists, proceed to update it
          flagCreated = true;
          flagAlreadyExisted = true;
          createdFlagKey = flagKey;
          console.log(
            Colors.gray(`\t⚠ Flag exists (409), will update environments...`),
          );
          break; // Exit retry loop and proceed to patching
        }
      } else {
        // Real error: record it so the summary and exit code reflect the failure
        console.log(Colors.red(`\t✗ Error ${flagResp.status}`));
        const errorText = await flagResp.text();
        console.log(Colors.red(`\t  ${errorText}`));
        flagsWithErrors.add(flag.key);
        flagErrorDetails.set(
          flag.key,
          `create failed (HTTP ${flagResp.status}): ${errorText.slice(0, 300)}`,
        );
        // A 4xx means the API rejected the create: nothing exists under this key (a 5xx is unknown)
        if (flagResp.status >= 400 && flagResp.status < 500) {
          flagsCreateRejected.add(flag.key);
        }
        break; // Exit loop on non-conflict errors
      }
    }
  }

  // Track per-flag manifest entry as we process environments
  const flagManifestEnvs: Record<string, SyncManifestEnv> = {};

  // Add flag env settings - use the potentially updated flag key
  if (flagCreated) {
    // Fetch the destination flag to get the correct variation IDs and current environment state
    // (LaunchDarkly generates new UUIDs when the flag is created)
    let destinationVariations = flag.variations; // Fallback to source variations
    let destinationFlag: any = null;

    try {
      const destFlagReq = ldAPIRequest(
        apiKey,
        domain,
        `flags/${inputArgs.projKeyDest}/${createdFlagKey}?env=*`, // Request all environments
      );
      const destFlagResp = await rateLimitRequest(destFlagReq, "flags");

      if (destFlagResp.status === 200) {
        destinationFlag = await destFlagResp.json();
        if (
          destinationFlag.variations &&
          Array.isArray(destinationFlag.variations)
        ) {
          destinationVariations = destinationFlag.variations;
        }
      }
    } catch {
      console.log(
        Colors.yellow(
          `\t⚠ Could not fetch destination flag, using source IDs (may cause issues with approval requests and skip detection)`,
        ),
      );
    }

    // Update flag-level properties when the flag already existed, or when it was just created
    // from a source that is archived or deprecated: the create endpoint ignores those fields, so
    // without this patch an archived source flag would go live in the destination (and be served).
    // Only patch properties that have actually changed vs the destination.
    if (
      !destinationFlag && !flagAlreadyExisted &&
      (flag.archived || flag.deprecated) && !inputArgs.dryRun
    ) {
      // The create endpoint ignores archived/deprecated and we could not read the flag back to
      // patch them: the flag would stay live. Record it so the run does not report success.
      console.log(
        Colors.red(
          `\t✗ Could not read the created flag back; archived/deprecated state not applied`,
        ),
      );
      flagsWithErrors.add(flag.key);
      flagErrorDetails.set(
        flag.key,
        "created, but archived/deprecated state could not be applied (destination read failed)",
      );
    }
    if (
      destinationFlag &&
      (flagAlreadyExisted || flag.archived || flag.deprecated)
    ) {
      const flagLevelPatches: any[] = [];
      const changed = (srcVal: any, destVal: any) =>
        JSON.stringify(srcVal) !== JSON.stringify(destVal);

      if (flag.name && changed(flagName, destinationFlag.name)) {
        flagLevelPatches.push(buildPatch("name", "replace", flagName));
      }
      if (
        flag.description !== undefined &&
        changed(flag.description, destinationFlag.description)
      ) {
        flagLevelPatches.push(
          buildPatch("description", "replace", flag.description),
        );
      }
      const desiredTags = migrationTags.length > 0
        ? mergeTags(flag.tags, migrationTags, destinationFlag.tags)
        : flag.tags;
      if (desiredTags && changed(desiredTags, destinationFlag.tags)) {
        flagLevelPatches.push(buildPatch("tags", "replace", desiredTags));
      }
      if (
        flag.temporary !== undefined &&
        changed(flag.temporary, destinationFlag.temporary)
      ) {
        flagLevelPatches.push(
          buildPatch("temporary", "replace", flag.temporary),
        );
      }
      if (
        flag.clientSideAvailability &&
        changed(
          flag.clientSideAvailability,
          destinationFlag.clientSideAvailability,
        )
      ) {
        flagLevelPatches.push(
          buildPatch(
            "clientSideAvailability",
            "replace",
            flag.clientSideAvailability,
          ),
        );
      }
      if (
        flag.customProperties &&
        changed(flag.customProperties, destinationFlag.customProperties)
      ) {
        flagLevelPatches.push(
          buildPatch("customProperties", "replace", flag.customProperties),
        );
      }
      if (
        flag.archived !== undefined &&
        changed(flag.archived, destinationFlag.archived)
      ) {
        flagLevelPatches.push(buildPatch("archived", "replace", flag.archived));
      }
      if (
        flag.deprecated !== undefined &&
        changed(flag.deprecated, destinationFlag.deprecated)
      ) {
        flagLevelPatches.push(
          buildPatch("deprecated", "replace", flag.deprecated),
        );
      }
      // deprecatedDate is managed by the API (stamped when `deprecated` flips) and cannot be patched
      // on its own: a lone `replace /deprecatedDate` is rejected with "Unsupported json-patch operation".

      // Variations and defaults must be patched together to avoid index conflicts
      // Strip _id from both sides before comparing
      const stripIds = (v: any[]) => v.map(({ _id, ...rest }: any) => rest);
      const destVarsClean = destinationFlag.variations
        ? stripIds(destinationFlag.variations)
        : [];
      if (newVariations?.length > 0 && changed(newVariations, destVarsClean)) {
        flagLevelPatches.push(
          buildPatch("variations", "replace", newVariations),
        );
        if (flag.defaults) {
          flagLevelPatches.push(
            buildPatch("defaults", "replace", flag.defaults),
          );
        }
      } else if (
        flag.defaults && changed(flag.defaults, destinationFlag.defaults)
      ) {
        flagLevelPatches.push(buildPatch("defaults", "replace", flag.defaults));
      }

      if (flagLevelPatches.length > 0) {
        console.log(
          Colors.gray(
            `\tUpdating flag-level properties (${flagLevelPatches.length} field(s))...`,
          ),
        );
        const flagLevelResp = await dryRunAwarePatch(
          inputArgs.dryRun || false,
          apiKey,
          domain,
          `flags/${inputArgs.projKeyDest}/${createdFlagKey}`,
          flagLevelPatches,
          false,
          "flags",
          "flag-level properties",
        );
        if (flagLevelResp.status >= 200 && flagLevelResp.status < 300) {
          console.log(Colors.green(`\t✓ Flag-level properties updated`));
        } else {
          const errText = await flagLevelResp.text();
          console.log(
            Colors.yellow(
              `\t⚠ Flag-level update failed (${flagLevelResp.status}): ${errText}`,
            ),
          );
          flagsWithErrors.add(createdFlagKey);
        }
      }
    }

    for (const env of envkeys) {
      if (!flag.environments || !flag.environments[env]) {
        continue;
      }

      // Determine destination environment key (mapped or original)
      const destEnvKey = inputArgs.envMap && envMapping[env]
        ? envMapping[env]
        : env;

      const flagEnvData = flag.environments[env];

      // Read env version and lastModified before filtering
      const envVersion = flagEnvData.version as number | undefined;
      const envLastModified = flagEnvData.lastModified as string | undefined;

      // Incremental sync: skip unchanged environments by version comparison
      if (inputArgs.incremental && previousManifest) {
        const prevFlag = ownEntry(previousManifest.flags, flag.key);
        const prevEnv = prevFlag?.environments?.[env];
        if (
          prevEnv && envVersion !== undefined && prevEnv.version === envVersion
        ) {
          const ts = envLastModified ? `, updated ${envLastModified}` : "";
          console.log(
            Colors.gray(
              `\t  ✓ ${destEnvKey}: unchanged (v${envVersion}${ts}), skipping`,
            ),
          );
          flagManifestEnvs[env] = {
            version: envVersion,
            lastModified: envLastModified,
          };
          incrementalEnvSkipCountDelta++;
          continue;
        }
      }

      const patchReq: any[] = [];
      const parsedData: Record<string, string> = Object.keys(flagEnvData)
        .filter((key) => !key.includes("salt"))
        .filter((key) => !key.includes("version"))
        .filter((key) => !key.includes("lastModified"))
        .filter((key) => !key.includes("_environmentName"))
        .filter((key) => !key.includes("_site"))
        .filter((key) => !key.includes("_summary"))
        .filter((key) => !key.includes("sel"))
        .filter((key) => !key.includes("access"))
        .filter((key) => !key.includes("_debugEventsUntilDate"))
        .filter((key) => !key.startsWith("_"))
        .filter((key) => !key.startsWith("-"))
        .reduce((cur, key) => {
          return Object.assign(cur, { [key]: flagEnvData[key] });
        }, {});

      // A source environment with no off variation serves the SDK fallback value while off, but the
      // destination flag is created with the default off variation, so remove it explicitly. Only when
      // the destination has one: a JSON Patch remove on a missing path fails the whole patch.
      if (
        parsedData.offVariation === undefined ||
        parsedData.offVariation === null
      ) {
        delete parsedData.offVariation;
        if (destinationFlag?.environments?.[destEnvKey]?.offVariation != null) {
          patchReq.push(
            buildPatch(
              `environments/${destEnvKey}/offVariation`,
              "remove",
              undefined,
            ),
          );
        }
      }

      Object.keys(parsedData)
        .map((key) => {
          if (key == "rules") {
            patchReq.push(
              buildRulesReplace(
                parsedData[key] as unknown as Rule[],
                "environments/" + destEnvKey,
              ),
            );
          } else {
            patchReq.push(
              buildPatch(
                `environments/${destEnvKey}/${key}`,
                "replace",
                parsedData[key],
              ),
            );
          }
        });
      await makePatchCall(
        createdFlagKey,
        patchReq,
        destEnvKey,
        flagMaintainerId,
        currentMemberId,
        destinationVariations,
        destinationFlag,
        env,
      );

      // Track env version in manifest. An environment applied without dead rules gets no entry, so
      // the next --incremental run re-evaluates it (and restores the rules if the segment exists by then).
      if (
        envVersion !== undefined &&
        !envsWithDroppedRules.has(`${createdFlagKey}\u0000${destEnvKey}`)
      ) {
        flagManifestEnvs[env] = {
          version: envVersion,
          lastModified: envLastModified,
        };
      }
    }
  }

  // Track flag version for sync manifest (flag-level lastModified comes from creationDate or _version).
  // A flag whose create failed gets no new entry; carryForwardManifestEntries keeps its previous one with
  // cleared versions, so the next --incremental run retries it.
  if (flagCreated) {
    updatedManifestFlags[flag.key] = withExtraDestKeys(
      {
        version: flag._version ?? 0,
        lastModified: flag.creationDate,
        environments: flagManifestEnvs,
        ...(createdFlagKey !== flag.key && { destKey: createdFlagKey }),
      },
      ownEntry(previousManifest?.flags, flag.key),
      flag.key,
    );
  }

  return { incrementalSkipCountDelta, incrementalEnvSkipCountDelta };
}

// ==================== Prerequisite-aware ordering ====================
// Flags referenced as prerequisites must exist (with their variations) before
// dependents patch environments, so order flags into topological levels:
// level 0 has no prerequisites within this migration, level 1 depends only on
// level 0, and so on. Levels run sequentially; flags within a level run
// concurrently. Cycles are reported and processed last in source order.

async function computeTopologicalLevels(
  entries: Array<[number, string]>,
): Promise<Array<Array<[number, string]>>> {
  const keySet = new Set(entries.map(([, key]) => key));
  const depsByKey = new Map<string, Set<string>>();

  for (const [index, key] of entries) {
    const flag = await getFlagDataByIndexOrKey(index, key);
    const deps = new Set<string>();
    for (const envData of Object.values(flag?.environments ?? {})) {
      for (const prereq of (envData as any)?.prerequisites ?? []) {
        // Only order against flags that are part of this migration
        if (prereq?.key && keySet.has(prereq.key) && prereq.key !== key) {
          deps.add(prereq.key);
        }
      }
    }
    depsByKey.set(key, deps);
  }

  const hasAnyPrereqs = [...depsByKey.values()].some((deps) => deps.size > 0);
  if (!hasAnyPrereqs) return [entries];

  const levels: Array<Array<[number, string]>> = [];
  const placed = new Set<string>();
  let remaining = [...entries];

  while (remaining.length > 0) {
    const ready = remaining.filter(([, key]) =>
      [...depsByKey.get(key)!].every((dep) => placed.has(dep))
    );
    if (ready.length === 0) {
      // Cycle: process the rest in source order with a warning
      console.log(Colors.yellow(
        `⚠ Prerequisite cycle detected among: ${
          remaining.map(([, k]) => k).join(", ")
        } — ` +
          `migrating in source order; some prerequisite patches may fail and need a re-run`,
      ));
      levels.push(remaining);
      break;
    }
    levels.push(ready);
    ready.forEach(([, key]) => placed.add(key));
    remaining = remaining.filter(([, key]) => !placed.has(key));
  }

  console.log(Colors.cyan(
    `\n📐 Prerequisites detected: migrating in ${levels.length} dependency level(s) ` +
      `(${levels.map((l) => l.length).join(" → ")})`,
  ));
  return levels;
}

// Run flag migration with concurrency limit, honoring prerequisite order
const entries = [...flagList.entries()];
// An unexpected error outside the per-flag handlers must not lose settled work: persist, marked incomplete, and stop
try {
  const levels = await computeTopologicalLevels(entries);
  for (const level of levels) {
    for (let offset = 0; offset < level.length; offset += CONCURRENCY) {
      const chunk = level.slice(offset, offset + CONCURRENCY);
      const results = await Promise.all(
        chunk.map(([idx, key]) =>
          processOneFlag(idx, key).catch((err: unknown): FlagProcessResult => {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(Colors.red(`\t✗ ${key}: unexpected error: ${msg}`));
            flagsWithErrors.add(key);
            flagErrorDetails.set(key, `unexpected error: ${msg.slice(0, 300)}`);
            return {
              incrementalSkipCountDelta: 0,
              incrementalEnvSkipCountDelta: 0,
            };
          })
        ),
      );
      for (const r of results) {
        incrementalSkipCount += r.incrementalSkipCountDelta;
        incrementalEnvSkipCount += r.incrementalEnvSkipCountDelta;
      }
      // Every worker of this chunk has settled; snapshot the inventory and stop
      if (abortRequested) await finalizeAbort();
    }
  }
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  console.log(Colors.red(`\n❌ Flag migration failed unexpectedly: ${msg}`));
  await persistAndExit(`flag phase failed: ${msg.slice(0, 200)}`);
}

// ==================== Flags archived or deleted in the source ====================
// The flags API omits archived flags unless --include-archived, so a flag archived in the source
// after it was migrated leaves flags.json and the flag loop never sees it again: its destination copy
// would stay live (and be served). The extraction records the source's archived keys
// (archived-flags.json); every recorded flag that is no longer in the flag list and is archived in the
// source is archived in the destination too. A recorded flag that is neither live nor archived in the
// source was deleted there; its destination copy is kept and reported, never deleted.
// Destination copies of recorded flags whose source flag is archived and that exist in the destination:
// expected by reconciliation (archived or not), so they are not reported as extra
const archivedSourceDestKeys: string[] = [];
// Destination copies archived this run, or found archived already; a failed patch is in flagsWithErrors instead
const flagsArchivedInSource: string[] = [];
// Destination copies of recorded flags deleted in the source, kept in the destination
const flagsDeletedInSource: string[] = [];

/** Archives one destination copy of a source flag that is archived; failures land in flagsWithErrors. */
async function archiveDestinationCopy(
  key: string,
  destKey: string,
): Promise<void> {
  const copy = destKey !== key ? ` (source ${key})` : "";
  const fail = (detail: string) => {
    console.log(Colors.red(`\t✗ ${destKey}${copy}: ${detail}`));
    flagsWithErrors.add(destKey);
    flagErrorDetails.set(
      destKey,
      `source flag ${key} is archived, but this destination copy could not be archived: ${
        detail.slice(0, 300)
      }`,
    );
  };
  try {
    const destResp = await rateLimitRequest(
      ldAPIRequest(apiKey, domain, `flags/${inputArgs.projKeyDest}/${destKey}`),
      "flags",
    );
    if (destResp.status === 404) {
      console.log(
        Colors.gray(
          `\t- ${destKey}${copy}: archived in the source, no copy in the destination`,
        ),
      );
      return;
    }
    if (destResp.status !== 200) {
      fail(`could not read the destination flag (HTTP ${destResp.status})`);
      return;
    }
    archivedSourceDestKeys.push(destKey);
    const destFlag = await destResp.json();
    if (destFlag.archived === true) {
      console.log(
        Colors.gray(
          `\t✓ ${destKey}${copy}: already archived in the destination`,
        ),
      );
      flagsArchivedInSource.push(destKey);
      return;
    }
    const patchResp = await dryRunAwarePatch(
      inputArgs.dryRun || false,
      apiKey,
      domain,
      `flags/${inputArgs.projKeyDest}/${destKey}`,
      [buildPatch("archived", "replace", true)],
      false,
      "flags",
      "archived in the source",
    );
    if (patchResp.status >= 200 && patchResp.status < 300) {
      flagsArchivedInSource.push(destKey);
      console.log(
        Colors.green(
          `\t✓ ${destKey}${copy}: ${
            inputArgs.dryRun ? "would be archived" : "archived"
          } in the destination (archived in the source)`,
        ),
      );
    } else {
      fail(`HTTP ${patchResp.status}: ${await patchResp.text()}`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function propagateSourceArchival(): Promise<void> {
  if (!propagateArchived || !previousManifest) return;
  // Only a missing file (an extraction from before this version) is tolerated with a warning; an unreadable
  // or malformed one throws to the caller, which records the failure so the run does not exit 0 with
  // recorded flags possibly left live
  const archivedListPath =
    `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/archived-flags.json`;
  let archivedListText: string;
  try {
    archivedListText = await Deno.readTextFile(archivedListPath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    console.log(
      Colors.yellow(
        `\n⚠ The extracted data does not list the source's archived flags (archived-flags.json; re-extract with this version). ` +
          `Flags archived in the source since the last run were not archived in the destination.`,
      ),
    );
    return;
  }
  const archivedKeys: unknown = JSON.parse(archivedListText);
  if (
    !Array.isArray(archivedKeys) ||
    !archivedKeys.every((k) => typeof k === "string")
  ) {
    throw new Error(`${archivedListPath} is not a list of flag keys`);
  }
  // The cumulative entries: carried forward from the previous manifest, rewritten by this run, and
  // including copies adopted this run (--adopt-unresolved), so none of them is left live
  const manifestFlags = updatedManifestFlags;
  const { archived, deleted, archivedInList } = classifyVanishedFlags({
    manifestKeys: Object.keys(manifestFlags),
    extractedKeys: sourceIndexByKey.keys(),
    archivedKeys,
    includeFlags: inputArgs.includeFlags,
    excludeFlags: inputArgs.excludeFlags,
  });
  // Adopted extra copies of archived flags that are in the flag list: the flag loop only archives the
  // primary copy, so the extra copies are handled here, same as copies of vanished flags
  const extraCopies = archivedInList.flatMap((key) => {
    const entry = ownEntry(manifestFlags, key);
    return entry
      ? ownedKeys(key, entry).slice(1).map((destKey) => [key, destKey])
      : [];
  });
  if (
    archived.length === 0 && deleted.length === 0 && extraCopies.length === 0
  ) return;
  console.log(
    Colors.cyan(
      `\n🗄  Recorded flags no longer in the source flag list: ${archived.length} archived in the source, ${deleted.length} deleted in the source` +
        (extraCopies.length > 0
          ? `; ${extraCopies.length} adopted copies of archived flags in the list`
          : ""),
    ),
  );
  // Every destination copy an entry owns (primary and adopted) is handled on its own
  const copies: Array<[string, string]> = [];
  for (const key of archived) {
    const entry = ownEntry(manifestFlags, key);
    if (!entry) continue;
    for (const destKey of ownedKeys(key, entry)) copies.push([key, destKey]);
  }
  copies.push(...(extraCopies as Array<[string, string]>));
  for (const [key, destKey] of copies) {
    await archiveDestinationCopy(key, destKey);
  }
  for (const key of deleted) {
    const entry = ownEntry(manifestFlags, key);
    if (!entry) continue;
    for (const destKey of ownedKeys(key, entry)) {
      flagsDeletedInSource.push(
        destKey !== key ? `${destKey} (source ${key})` : destKey,
      );
      console.log(
        Colors.yellow(
          `\t⚠ ${destKey}: source flag ${key} was deleted; the destination copy is kept`,
        ),
      );
    }
  }
}

// The manifest is the inventory revert and view linking use to find migrated copies, so it stays
// cumulative: entries for flags and segments outside this run's scope (include/exclude filters,
// --since, unselected environments, migrateSegments: false) are carried over. Resources attempted
// this run were rewritten above; a failed one keeps its previous entry with cleared versions so the
// next --incremental run retries it. Runs before view linking, so a flag or segment skipped this run
// (--since, --on-conflict skip) still resolves to its recorded destination key instead of its raw key.
function carryForwardManifestEntries(): void {
  if (!previousManifest) return;
  // A previous entry is kept unless this run rewrote it. One whose resource was attempted but got no
  // new entry (the write failed, or was still in flight at an abort) keeps its ownership, destination
  // mapping and adopted copies, with the cached versions dropped so the next --incremental run retries
  // it. Resources not attempted this run (filters, --since, unselected environments, segments off,
  // never loaded, not reached before an abort, conflict-skipped) keep their entry unchanged.
  for (const [key, entry] of Object.entries(previousManifest.flags ?? {})) {
    if (Object.hasOwn(updatedManifestFlags, key)) continue;
    const attempted = flagsAttempted.has(key) &&
      !flagsSkippedByConflict.has(key);
    updatedManifestFlags[key] = attempted
      ? { ...entry, version: 0, lastModified: undefined, environments: {} }
      : entry;
  }
  for (
    const [envKey, segments] of Object.entries(previousManifest.segments ?? {})
  ) {
    for (const [key, entry] of Object.entries(segments)) {
      const envEntries = Object.hasOwn(updatedManifestSegments, envKey)
        ? updatedManifestSegments[envKey]
        : (updatedManifestSegments[envKey] = emptyRecord());
      if (Object.hasOwn(envEntries, key)) continue;
      const id = `${envKey}/${key}`;
      const attempted = segmentsAttempted.has(id) &&
        !segmentsSkippedByConflict.has(id);
      envEntries[key] = attempted
        ? { ...entry, version: 0, lastModified: undefined }
        : entry;
    }
  }
}

carryForwardManifestEntries();
// Adoption (--adopt-unresolved) is staged before archival so copies adopted this run are archived too
stageAdoptedCopies();
// Runs on the cumulative entries, before the manifest is written: an archival failure clears the
// entry's cached versions and counts as a failed write for the incomplete marker
try {
  await propagateSourceArchival();
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  console.log(
    Colors.red(`\n❌ Propagating source archival failed unexpectedly: ${msg}`),
  );
  reconciliationErrors.push(`archived in source: ${msg}`);
}
// Persisted before view linking, so a failure there cannot lose the inventory of what was written
await writeSyncManifestFile();

// Link migrated flags and segments to their views. Done after migration so it also covers
// flags and segments that already existed in the destination.
let viewLinkingFailed = false;
if (usableViews.size > 0) {
  try {
    console.log(Colors.cyan("\n=== View Links ==="));
    // Destination keys come from the manifest entries written (or carried forward by incremental
    // skips) this run, so prefix renames from earlier runs survive. Segment keys are per environment.
    const flagRenamesThisRun = new Map(
      conflictTracker.getResolutions().filter((r) => r.resourceType === "flag")
        .map((r) => [r.originalKey, r.resolvedKey]),
    );
    const destFlagKey = (key: string) =>
      updatedManifestFlags[key]?.destKey ?? flagRenamesThisRun.get(key) ?? key;
    const destSegmentKey = (sourceEnvKey: string, key: string) =>
      updatedManifestSegments[sourceEnvKey]?.[key]?.destKey ?? key;
    const destEnvIds = new Map<string, string>();
    const envResp = await rateLimitRequest(
      ldAPIRequest(
        apiKey,
        domain,
        `projects/${inputArgs.projKeyDest}/environments`,
      ),
      "environments",
    );
    if (envResp.status === 200) {
      for (const e of (await envResp.json()).items) {
        destEnvIds.set(e.key, e._id);
      }
    }
    const selectedFlags = new Set(flagList);

    for (const viewKey of usableViews) {
      const source = sourceViews.find((v) => v.key === viewKey);
      const flagKeys = [
        ...new Set([
          ...(source?.flags ?? []).filter((k) => selectedFlags.has(k)),
          ...(viewKey === inputArgs.targetView ? flagList : []),
        ]),
      ].map(destFlagKey);
      const segmentIds = !inputArgs.migrateSegments
        ? []
        : (source?.segments ?? [])
          .filter((s) => envkeys.includes(s.environmentKey))
          .map((s) => {
            const destEnvKey = inputArgs.envMap && envMapping[s.environmentKey]
              ? envMapping[s.environmentKey]
              : s.environmentKey;
            return {
              environmentId: destEnvIds.get(destEnvKey) ?? "",
              segmentKey: destSegmentKey(s.environmentKey, s.segmentKey),
            };
          })
          .filter((s) => s.environmentId);

      if (inputArgs.dryRun) {
        console.log(
          Colors.gray(
            `    [DRY RUN] Would link ${flagKeys.length} flag(s) and ${segmentIds.length} segment(s) to view "${viewKey}"`,
          ),
        );
        continue;
      }
      for (
        const [type, items] of [["flags", flagKeys], [
          "segments",
          segmentIds,
        ]] as const
      ) {
        if (items.length === 0) continue;
        const result = await linkToView(
          apiKey,
          domain,
          inputArgs.projKeyDest,
          viewKey,
          type,
          items as any,
        );
        console.log(
          result.failed.length === 0
            ? Colors.green(
              `  ✓ View "${viewKey}": linked ${result.linked} ${type}`,
            )
            : Colors.yellow(
              `  ⚠ View "${viewKey}": linked ${result.linked} ${type}, failed: ${
                result.failed.join("; ")
              }`,
            ),
        );
      }
    }
  } catch (error) {
    viewLinkingFailed = true;
    console.log(
      Colors.red(
        `\n❌ View linking failed unexpectedly: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }
}

// --adopt-unresolved: the user verified the untracked resources are the aborted run's writes; record them
// as this migration's extra copies so the marker can clear and revert removes them too. Idempotent:
// adoption runs once, after carry-forward, before archival propagation and the manifest write.
let adoptionStaged = false;
function stageAdoptedCopies(): void {
  if (
    adoptionStaged || !inputArgs.adoptUnresolved ||
    !previousManifest?.incomplete?.unresolved
  ) return;
  adoptionStaged = true;
  const adopted = adoptUnresolved(
    previousManifest,
    {
      flags: updatedManifestFlags,
      segments: Object.keys(updatedManifestSegments).length > 0
        ? updatedManifestSegments
        : undefined,
    },
    inputArgs.conflictPrefix,
  );
  const list = [...adopted.flags, ...adopted.segments];
  const verb = inputArgs.dryRun ? "[DRY RUN] Would adopt" : "Adopted";
  console.log(
    list.length > 0
      ? Colors.cyan(
        `\n${verb} ${list.length} untracked destination resource(s) into the sync manifest: ${
          list.join(", ")
        }`,
      )
      : Colors.yellow(
        `\nNo untracked destination resource could be adopted (no matching source resource in this run)`,
      ),
  );
}

// Always write sync manifest so --incremental works on next run
/**
 * Writes the cumulative manifest. An explicit `incomplete` marks a run that stopped early and skips the
 * recovery checks; otherwise markerAfterRun decides whether an earlier marker is kept or a new one raised.
 */
async function writeSyncManifestFile(
  incomplete?: SyncManifest["incomplete"],
): Promise<void> {
  const entries = {
    flags: updatedManifestFlags,
    segments: Object.keys(updatedManifestSegments).length > 0
      ? updatedManifestSegments
      : undefined,
  };
  const run: RunOutcome = {
    flagScopeFiltered,
    failedWrites: flagsWithErrors.size > 0 || segmentsWithErrors.size > 0,
    conflictedFlags: [...flagsSkippedByConflict, ...flagsPrefixedByConflict],
    // The existing copy sits in the destination environment the current mapping targets
    conflictedSegments: [
      ...segmentsSkippedByConflict,
      ...segmentsPrefixedByConflict,
    ].map((id) => {
      const slash = id.indexOf("/");
      const sourceEnv = id.slice(0, slash), key = id.slice(slash + 1);
      return {
        sourceEnv,
        key,
        destEnv: destEnvOfSelected(sourceEnv) ?? sourceEnv,
      };
    }),
  };
  // --adopt-unresolved: staged once a completed flag phase, before archival; an abort never adopts
  if (!incomplete) stageAdoptedCopies();
  // Attempted resources without an entry whose outcome is unknown: in flight at an abort, or failed after
  // a create may already have succeeded (a create the API rejected with a 4xx is excluded: nothing exists).
  // Their destination keys (the key being written, plus the prefixed key for a prefix retry) may exist
  // without an entry, so they are recorded as pending in the marker.
  {
    const prefix = inputArgs.conflictPrefix;
    const splitId = (id: string): [string, string] => {
      const slash = id.indexOf("/");
      return [id.slice(0, slash), id.slice(slash + 1)];
    };
    const pendingFlags = [...flagsAttempted]
      .filter((k) =>
        !flagsSkippedByConflict.has(k) && !flagsCreateRejected.has(k) &&
        !Object.hasOwn(updatedManifestFlags, k)
      )
      // A prefix retry only ever wrote the prefixed key; the original belongs to someone else
      .map((k) =>
        prefix && flagsPrefixedByConflict.has(k)
          ? applyConflictPrefix(k, prefix)
          : ownEntry(previousManifest?.flags, k)?.destKey ?? k
      );
    const pendingSegments = [...segmentsAttempted]
      .filter((id) => {
        const [env, key] = splitId(id);
        return !segmentsSkippedByConflict.has(id) &&
          !segmentsCreateRejected.has(id) &&
          !(Object.hasOwn(updatedManifestSegments, env) &&
            Object.hasOwn(updatedManifestSegments[env], key));
      })
      .flatMap((id) => {
        const [env, key] = splitId(id);
        const prev = ownEntry(ownEntry(previousManifest?.segments, env), key);
        // Pending segments are identified by the destination environment this run wrote to
        const destEnv = destEnvOfSelected(env) ?? env;
        return prefix && segmentsPrefixedByConflict.has(id)
          ? [`${destEnv}/${applyConflictPrefix(key, prefix)}`]
          : [`${destEnv}/${prev?.destKey ?? key}`];
      });
    run.pendingDestKeys = { flags: pendingFlags, segments: pendingSegments };
  }
  // A resource whose synchronization failed keeps its entry (ownership) but not its cached versions,
  // so the next --incremental run retries it instead of taking the failed sync for current
  // Errors are recorded under source or destination keys, so match an entry on all keys it owns
  for (const [key, entry] of Object.entries(entries.flags)) {
    const owned = [key, entry.destKey ?? key, ...(entry.extraDestKeys ?? [])];
    if (owned.some((k) => flagsWithErrors.has(k))) {
      Object.assign(entry, {
        version: 0,
        lastModified: undefined,
        environments: {},
      });
    }
  }
  for (const [srcEnv, segments] of Object.entries(entries.segments ?? {})) {
    for (const [key, entry] of Object.entries(segments)) {
      const destEnv = entry.destEnv ?? srcEnv;
      const owned = [
        `${srcEnv}/${key}`,
        `${destEnv}/${entry.destKey ?? key}`,
        ...(entry.extraDestKeys ?? []).map((k) => `${destEnv}/${k}`),
      ];
      if (owned.some((id) => segmentsWithErrors.has(id))) {
        Object.assign(entry, { version: 0, lastModified: undefined });
      }
    }
  }
  // An abort keeps the gaps found so far (previous marker plus this run's conflicts on unrecorded keys);
  // a completed run retains an earlier marker, or raises one when failed writes left resources untracked
  const marker = incomplete
    ? abortMarker(previousManifest, incomplete, run, entries)
    : markerAfterRun(previousManifest, run, entries, new Date().toISOString());
  const manifest: SyncManifest = {
    lastSyncTimestamp: new Date().toISOString(),
    sourceProject: inputArgs.projKeySource,
    destProject: inputArgs.projKeyDest,
    ...stampIdentity(previousManifest, destIdentity),
    ...entries,
    ...(marker ? { incomplete: marker } : {}),
  };
  // A dry run changes nothing, so recording it would make a later --incremental run skip unsynced resources
  if (inputArgs.dryRun) {
    console.log(
      Colors.gray(
        `\n[DRY RUN] Sync manifest not written (${syncManifestPath} left unchanged)`,
      ),
    );
    return;
  }
  try {
    await Deno.mkdir("./data/launchdarkly-migrations", { recursive: true });
    await Deno.writeTextFile(
      syncManifestPath,
      JSON.stringify(manifest, null, 2),
    );
    const envCount = Object.values(manifest.flags).reduce(
      (sum, f) => sum + Object.keys(f.environments).length,
      0,
    );
    const segCount = Object.values(updatedManifestSegments).reduce(
      (sum, envSegs) => sum + Object.keys(envSegs).length,
      0,
    );
    const segPart = segCount > 0 ? `, ${segCount} segments` : "";
    const untracked = [
      ...(marker?.unresolved?.flags ?? []),
      ...(marker?.unresolved?.segments ?? []),
    ];
    const note = marker
      ? ` — marked incomplete (${marker.reason})${
        untracked.length > 0
          ? `; untracked destination resources: ${untracked.join(", ")}`
          : ""
      }`
      : "";
    console.log(
      Colors.green(
        `\n✓ Sync manifest written to ${syncManifestPath} (${
          Object.keys(manifest.flags).length
        } flags, ${envCount} environments${segPart} tracked)${note}`,
      ),
    );
  } catch (error) {
    manifestWriteFailed = true;
    console.log(
      Colors.red(
        `\n❌ Could not write sync manifest ${syncManifestPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
    console.log(
      Colors.yellow(
        `   The destination was written but the inventory was not saved; fix the cause and re-run (an --incremental run re-records what exists).`,
      ),
    );
  }
}

if (
  incrementalSkipCount > 0 || incrementalEnvSkipCount > 0 ||
  incrementalSegmentSkipCount > 0
) {
  const parts = [];
  if (incrementalSkipCount > 0) parts.push(`${incrementalSkipCount} flag(s)`);
  if (incrementalEnvSkipCount > 0) {
    parts.push(`${incrementalEnvSkipCount} environment(s)`);
  }
  if (incrementalSegmentSkipCount > 0) {
    parts.push(`${incrementalSegmentSkipCount} segment(s)`);
  }
  console.log(
    Colors.cyan(
      `\n📋 Incremental sync: skipped ${parts.join(", ")} as unchanged`,
    ),
  );
}

// Send one patch per Flag for all Environments //
const envList: string[] = [];
projectJson.environments.items.forEach((env: any) => {
  envList.push(env.key);
});

// The # of patch calls is the # of environments * flags,
// if you need to limit run time, a good place to start is to only patch the critical environments in a shorter list
//const envList: string[] = ["test"];

// ==================== Summary Report ====================

type ApprovalSummary = { flag: string; env: string; skippedFields: string[] };

/**
 * Groups approval requests by flag
 */
const groupApprovalsByFlag = (
  approvals: ApprovalSummary[],
): Map<string, string[]> => {
  return approvals.reduce((map, req) => {
    if (!map.has(req.flag)) {
      map.set(req.flag, []);
    }
    map.get(req.flag)!.push(req.env);
    return map;
  }, new Map<string, string[]>());
};

/**
 * Prints approval requests section
 */
const printApprovalRequestsSection = (approvals: ApprovalSummary[]): void => {
  if (approvals.length === 0) return;

  console.log(Colors.yellow("\n⏳ APPROVAL REQUESTS CREATED"));
  console.log(
    Colors.yellow(
      "The following flags require approval before changes take effect:\n",
    ),
  );

  const approvalsByFlag = groupApprovalsByFlag(approvals);

  approvalsByFlag.forEach((envs, flag) => {
    console.log(Colors.cyan(`  📋 ${flag}`));
    console.log(Colors.gray(`     Environments: ${envs.join(", ")}`));
  });

  console.log(Colors.yellow(
    `\n  Total: ${approvals.length} approval request(s) across ${approvalsByFlag.size} flag(s)`,
  ));
  console.log(
    Colors.gray(`  → Review and approve these in the LaunchDarkly UI`),
  );
};

/**
 * Prints non-migrated settings section
 */
const printNonMigratedSettingsSection = (
  skippedFields: Map<string, Set<string>>,
): void => {
  if (skippedFields.size === 0) return;

  console.log(Colors.yellow("\n⚠️  NON-MIGRATED SETTINGS"));
  console.log(
    Colors.yellow(
      "The following fields could not be migrated via approval requests:",
    ),
  );
  console.log(
    Colors.gray(
      "These will need to be set manually after approvals are applied.\n",
    ),
  );

  skippedFields.forEach((fields, flag) => {
    console.log(Colors.cyan(`  📋 ${flag}`));
    console.log(Colors.gray(`     Fields: ${Array.from(fields).join(", ")}`));
  });

  console.log(
    Colors.yellow(
      `\n  Total: ${skippedFields.size} flag(s) with non-migrated settings`,
    ),
  );
};

/**
 * Prints the destination copies whose source flag left the flag list since they were migrated.
 * Copies whose archival failed are not listed here; they are in the errors section.
 */
const printSourceLifecycleSection = (): void => {
  if (flagsArchivedInSource.length === 0 && flagsDeletedInSource.length === 0) {
    return;
  }
  console.log(Colors.cyan("\n🗄  FLAGS ARCHIVED OR DELETED IN THE SOURCE"));
  if (flagsArchivedInSource.length > 0) {
    console.log(
      Colors.gray(
        `  Source flag archived since the migration; destination copy ${
          inputArgs.dryRun ? "would be archived (dry run)" : "archived"
        }:`,
      ),
    );
    flagsArchivedInSource.forEach((k) => console.log(Colors.gray(`    ${k}`)));
  }
  if (flagsDeletedInSource.length > 0) {
    console.log(
      Colors.yellow(
        `  Source flag deleted; this destination copy is kept (delete it by hand if it should go):`,
      ),
    );
    flagsDeletedInSource.forEach((k) => console.log(Colors.yellow(`    ${k}`)));
  }
};

/**
 * Prints flags with errors section
 */
const printErrorsSection = (flagsWithErrors: Set<string>): void => {
  if (flagsWithErrors.size === 0) return;

  console.log(Colors.red("\n❌ FLAGS WITH ERRORS"));
  console.log(
    Colors.red("The following flags encountered errors during migration:\n"),
  );

  flagsWithErrors.forEach((flag) => {
    console.log(Colors.red(`  ✗ ${flag}`));
    const detail = flagErrorDetails.get(flag);
    if (detail) console.log(Colors.gray(`      ${detail}`));
  });

  console.log(
    Colors.red(`\n  Total: ${flagsWithErrors.size} flag(s) with errors`),
  );
  console.log(Colors.gray(`  → Review these flags manually`));
};

/**
 * Prints segments with errors section
 */
const printSegmentErrorsSection = (segmentsWithErrors: Set<string>): void => {
  if (segmentsWithErrors.size === 0) return;
  console.log(Colors.red("\n❌ SEGMENTS WITH ERRORS (env/key)"));
  segmentsWithErrors.forEach((s) => console.log(Colors.red(`  ✗ ${s}`)));
  console.log(
    Colors.red(`\n  Total: ${segmentsWithErrors.size} segment(s) with errors`),
  );
};

/**
 * Determines the final migration status message
 */
const getMigrationStatusMessage = (
  approvalsCount: number,
  errorsCount: number,
): { message: string; color: (text: string) => string } => {
  if (errorsCount > 0) {
    return {
      message: `✗ Migration finished with ${errorsCount} error(s)${
        approvalsCount > 0 ? ` and ${approvalsCount} pending approval(s)` : ""
      } — see the sections above; the process exits with code 1`,
      color: Colors.red,
    };
  }

  if (approvalsCount > 0) {
    return {
      message:
        `✓ Migration complete with ${approvalsCount} pending approval(s)`,
      color: Colors.cyan,
    };
  }

  return {
    message: "✓ Migration complete successfully",
    color: Colors.green,
  };
};

/**
 * Prints the complete migration summary report
 */
const printMigrationSummary = (
  approvals: ApprovalSummary[],
  skippedFields: Map<string, Set<string>>,
  flagsWithErrors: Set<string>,
  conflictReport: string,
): void => {
  const divider = "=".repeat(70);

  console.log(Colors.blue(`\n\n${divider}`));
  console.log(Colors.blue("📊 MIGRATION SUMMARY"));
  console.log(Colors.blue(divider));

  printApprovalRequestsSection(approvals);
  printNonMigratedSettingsSection(skippedFields);
  printSourceLifecycleSection();
  printErrorsSection(flagsWithErrors);
  printSegmentErrorsSection(segmentsWithErrors);
  if (reconciliationErrors.length > 0) {
    console.log(Colors.red("\n❌ RECONCILIATION NOT COMPLETED"));
    reconciliationErrors.forEach((e) => console.log(Colors.red(`  ✗ ${e}`)));
    console.log(
      Colors.gray("  → Destination state was not verified for these resources"),
    );
  }

  console.log(conflictReport);

  const { message, color } = getMigrationStatusMessage(
    approvals.length,
    flagsWithErrors.size + segmentsWithErrors.size +
      reconciliationErrors.length,
  );

  console.log(Colors.blue(`\n${divider}`));
  console.log(color(message));
  console.log(Colors.blue(`${divider}\n`));
};

// ==================== Reconciliation ====================
// Cheap safety net: compare the keys we meant to migrate with what the destination now has.
// Field-level parity is a separate tool's job; this catches silently dropped resources.
async function listDestinationKeys(path: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let next: string | null = path;
  let fetched = 0;
  while (next) {
    const resp = await rateLimitRequest(
      ldAPIRequest(apiKey, domain, next),
      "flags",
    );
    if (resp.status !== 200) {
      throw new Error(
        `HTTP ${resp.status} listing ${next}: ${
          (await resp.text()).slice(0, 200)
        }`,
      );
    }
    const body = await resp.json();
    const items: any[] = body.items ?? [];
    for (const item of items) keys.add(item.key);
    fetched += items.length;
    const href: string | undefined = body._links?.next?.href;
    if (href) {
      next = href.replace(/^\/api\/v2\//, "");
    } else if (
      typeof body.totalCount === "number" && fetched < body.totalCount &&
      items.length > 0
    ) {
      // Some list endpoints (segments) omit _links.next; page by offset/totalCount instead.
      const current: string = next;
      const q = current.indexOf("?");
      const base: string = q >= 0 ? current.slice(0, q) : current;
      const params: URLSearchParams = new URLSearchParams(
        q >= 0 ? current.slice(q + 1) : "",
      );
      params.set("offset", String(fetched));
      next = `${base}?${params.toString()}`;
    } else {
      next = null;
    }
  }
  return keys;
}

async function reconcileDestination(): Promise<void> {
  if (inputArgs.dryRun) return;
  console.log(Colors.blue("\n🔎 RECONCILIATION (source data vs destination)"));
  const resolved = new Map(
    conflictTracker.getResolutions().filter((r) => r.resourceType === "flag")
      .map((r) => [r.originalKey, r.resolvedKey]),
  );
  // Scope = every flag in the source data that was attempted (or already present), minus flags
  // --since skipped without attempting. Failed attempts stay in scope so they are reported.
  // Destination keys come from the manifest entries written this run (prefix renames from earlier runs
  // included), then from this run's conflict resolutions, else the source key
  const expectedFlags = new Set([
    ...flagList.filter((k: string) => !flagsSkippedByDate.has(k))
      .map((k: string) =>
        ownEntry(updatedManifestFlags, k)?.destKey ?? resolved.get(k) ?? k
      ),
    // Recorded copies whose source flag is archived stay in the destination (archived, or listed as an error)
    ...archivedSourceDestKeys,
  ]);
  try {
    const dest = await listDestinationKeys(
      `flags/${inputArgs.projKeyDest}?summary=true&limit=50&offset=0`,
    );
    const destArchived = await listDestinationKeys(
      `flags/${inputArgs.projKeyDest}?summary=true&limit=50&offset=0&filter=state:archived`,
    );
    for (const k of destArchived) dest.add(k);
    const missing = [...expectedFlags].filter((k) => !dest.has(k));
    const extra = [...dest].filter((k) => !expectedFlags.has(k));
    console.log(
      `  flags: source ${expectedFlags.size} → destination ${dest.size} (missing ${missing.length}, extra ${extra.length})`,
    );
    for (const k of missing) {
      console.log(Colors.red(`    ✗ missing in destination: ${k}`));
      flagsWithErrors.add(k);
      if (!flagErrorDetails.has(k)) {
        flagErrorDetails.set(k, "not found in destination after migration");
      }
    }
    if (extra.length) {
      console.log(
        Colors.gray(
          `    extra in destination (not in source data): ${
            extra.slice(0, 20).join(", ")
          }${extra.length > 20 ? ", …" : ""}`,
        ),
      );
    }
  } catch (err) {
    const msg = `flags: ${err instanceof Error ? err.message : String(err)}`;
    console.log(Colors.red(`  ✗ Could not reconcile ${msg}`));
    reconciliationErrors.push(msg);
  }
  if (!inputArgs.migrateSegments) return;
  for (const env of envkeys) {
    const destEnvKey = inputArgs.envMap && envMapping[env]
      ? envMapping[env]
      : env;
    let sourceKeys: string[] = [];
    try {
      const data = JSON.parse(
        await Deno.readTextFile(
          `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/segments/${env}.json`,
        ),
      );
      sourceKeys = (data.items ?? []).map((s: any) => s.key);
    } catch (_) {
      continue; // no segment data extracted for this env
    }
    try {
      const dest = await listDestinationKeys(
        `segments/${inputArgs.projKeyDest}/${destEnvKey}?limit=50&offset=0`,
      );
      const expectedKey = (k: string) =>
        ownEntry(ownEntry(updatedManifestSegments, env), k)?.destKey ?? k;
      const missing = sourceKeys.map(expectedKey).filter((k) => !dest.has(k));
      console.log(
        `  segments ${env} → ${destEnvKey}: source ${sourceKeys.length} → destination ${dest.size} (missing ${missing.length})`,
      );
      for (const k of missing) {
        console.log(
          Colors.red(`    ✗ missing in destination: ${destEnvKey}/${k}`),
        );
        segmentsWithErrors.add(`${destEnvKey}/${k}`);
      }
    } catch (err) {
      const msg = `segments ${destEnvKey}: ${
        err instanceof Error ? err.message : String(err)
      }`;
      console.log(Colors.red(`  ✗ Could not reconcile ${msg}`));
      reconciliationErrors.push(msg);
    }
  }
}

await reconcileDestination();

// Print the migration summary
printMigrationSummary(
  approvalRequestsCreated,
  skippedFieldsByFlag,
  flagsWithErrors,
  conflictTracker.getReport(),
);

if (
  flagsWithErrors.size > 0 || segmentsWithErrors.size > 0 ||
  reconciliationErrors.length > 0 || viewLinkingFailed || manifestWriteFailed
) {
  Deno.exit(1);
}
