// deno-lint-ignore-file no-explicit-any
/**
 * LaunchDarkly Migration Revert Tool
 * 
 * Safely reverts a failed or unwanted migration by:
 * 1. Finding flags created by the migration script
 * 2. Deleting any outstanding approval requests
 * 3. Removing flags from views
 * 4. Archiving and deleting flags
 * 5. Optionally deleting views created during migration
 */

import yargs from "https://deno.land/x/yargs@v17.7.2-deno/deno.ts";
import * as Colors from "https://deno.land/std@0.149.0/fmt/colors.ts";
import { parse as parseYaml } from "https://deno.land/std@0.224.0/yaml/parse.ts";
import { ldAPIRequest, ldAPIPostRequest, rateLimitRequest } from "../../utils/utils.ts";
import { getDestinationApiKey, getSourceApiKey } from "../../utils/api_keys.ts";
import {
  assertManifestComplete,
  manifestDestinationFlagKeys,
  readSyncManifest,
  syncManifestPath,
} from "../../utils/sync_manifest.ts";
import {
  coerceProjectKey,
  resolveProjectPairs,
  usesProjectKeysList,
  type WorkflowConfig,
} from "../../utils/workflow_config.ts";

// ==================== Type Definitions ====================

export interface RevertConfig {
  projectKey: string;
  sourceProjectKey?: string;
  /** Other source projects migrated into the same destination (projectKeyMapping merges) */
  siblingSourceKeys?: string[];
  domain?: string;
  dryRun?: boolean;
  deleteViews?: boolean;
  viewKeys?: string[];
  configFile?: string;
  useSourceData?: boolean;
}

export interface Arguments {
  project?: string;
  sourceProject?: string;
  domain?: string;
  dryRun?: boolean;
  deleteViews?: boolean;
  views?: string;
  config?: string;
  useSourceData?: boolean;
}

interface Flag {
  key: string;
  name: string;
  description?: string;
  archived?: boolean;
  viewKeys?: string[];
}

interface ApprovalRequest {
  _id: string;
  status: string;
  description?: string;
}

interface ViewLink {
  resource: {
    type: string;
    key: string;
  };
}

interface RevertStats {
  flagsChecked: number;
  flagsIdentified: number;
  approvalsDeleted: number;
  viewLinksRemoved: number;
  flagsArchived: number;
  flagsDeleted: number;
  viewsDeleted: number;
  errors: string[];
}

// ==================== Constants ====================

const MIGRATION_DESCRIPTION_MARKER = "Migration of flag";

// ==================== Config Loading ====================

/**
 * Loads migration config YAML file
 */
const loadMigrationConfig = async (configPath: string): Promise<WorkflowConfig> => {
  try {
    const configContent = await Deno.readTextFile(configPath);
    return parseYaml(configContent) as WorkflowConfig;
  } catch (error) {
    console.log(Colors.red(
      `Error loading config file: ${error instanceof Error ? error.message : String(error)}`
    ));
    Deno.exit(1);
  }
};

/**
 * Builds revert configs from a migration workflow config (one per project).
 * With -p, reverts only that project; otherwise reverts every project in
 * source.projectKeys, or the single source/destination pair.
 * @throws Error if no project key can be resolved
 */
export const buildRevertConfigs = (
  workflowConfig: WorkflowConfig,
  cliArgs: Arguments,
  configPath: string
): RevertConfig[] => {
  const cliProject = coerceProjectKey(cliArgs.project);
  const cliSourceProject = coerceProjectKey(cliArgs.sourceProject);

  const revert = workflowConfig.revert ?? {};

  // CLI flags win; unset flags (undefined) fall back to the revert: block
  const shared = {
    domain: cliArgs.domain || workflowConfig.destination?.domain || "app.launchdarkly.com",
    dryRun: cliArgs.dryRun ?? revert.dryRun ?? false,
    deleteViews: cliArgs.deleteViews ?? revert.deleteViews ?? false,
    viewKeys: cliArgs.views
      ? cliArgs.views.split(",")
      : revert.viewKeys?.length
        ? revert.viewKeys
        : workflowConfig.migration?.targetView
          ? [workflowConfig.migration.targetView]
          : undefined,
    configFile: configPath,
    useSourceData: cliArgs.useSourceData !== false // Default to true when config is provided
  };

  const multi = usesProjectKeysList(workflowConfig);
  // Resolved eagerly only with projectKeys: `-p` alone must keep working when no source key is set
  const multiPairs = multi ? resolveProjectPairs(workflowConfig) : [];
  const withSiblings = (config: RevertConfig): RevertConfig => {
    const siblingSourceKeys = multiPairs
      .filter(p => p.destination === config.projectKey && p.source !== config.sourceProjectKey)
      .map(p => p.source);
    return siblingSourceKeys.length > 0 ? { ...config, siblingSourceKeys } : config;
  };

  if (cliProject) {
    if (cliSourceProject) {
      return [withSiblings({ ...shared, projectKey: cliProject, sourceProjectKey: cliSourceProject })];
    }
    if (!multi) {
      return [{
        ...shared,
        projectKey: cliProject,
        sourceProjectKey: coerceProjectKey(workflowConfig.source?.projectKey),
      }];
    }
    // Every source mapped into this destination (several when projects were merged)
    const mapped = multiPairs.filter(({ destination }) => destination === cliProject);
    if (mapped.length > 0) {
      return mapped.map(({ source }) =>
        withSiblings({ ...shared, projectKey: cliProject, sourceProjectKey: source })
      );
    }
    return [{ ...shared, projectKey: cliProject, sourceProjectKey: cliProject }];
  }

  const pairs = multi ? multiPairs : resolveProjectPairs(workflowConfig);

  return pairs.map(({ source, destination }) => withSiblings({
    ...shared,
    projectKey: destination,
    // -s without -p only makes sense for a single project
    sourceProjectKey: (pairs.length === 1 && cliSourceProject) || source,
  }));
};

/**
 * Extracts revert configs from a migration workflow config file
 */
const extractRevertConfigFromWorkflow = async (
  configPath: string,
  cliArgs: Arguments
): Promise<RevertConfig[]> => {
  const workflowConfig = await loadMigrationConfig(configPath);
  try {
    return buildRevertConfigs(workflowConfig, cliArgs, configPath);
  } catch (error) {
    console.log(Colors.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    Deno.exit(1);
  }
};

// ==================== Argument Parsing ====================

const parseArguments = async (): Promise<RevertConfig[]> => {
  const args: Arguments = yargs(Deno.args)
    .alias("p", "project")
    .alias("s", "source-project")
    .alias("d", "domain")
    .alias("f", "config")
    .alias("dry-run", "dry-run")
    .alias("delete-views", "delete-views")
    .alias("v", "views")
    .alias("use-source-data", "use-source-data")
    .boolean("dry-run")
    .boolean("delete-views")
    .boolean("use-source-data")
    .describe("p", "Destination project key")
    .describe("s", "Source project key (used to identify migrated flags)")
    .describe("f", "Path to migration workflow YAML config (auto-detects settings)")
    .describe("d", "LaunchDarkly domain (default: app.launchdarkly.com)")
    .describe("dry-run", "Preview actions without making changes (overrides revert.dryRun; --no-dry-run forces a real run)")
    .describe("delete-views", "Delete views after unlinking flags (overrides revert.deleteViews)")
    .describe("v", "Comma-separated list of view keys to process (overrides revert.viewKeys and migration.targetView)")
    .describe("use-source-data", "Use extracted source data for faster flag list (default: true with --config)")
    .parse() as Arguments;

  // If config file provided, extract settings from it
  if (args.config) {
    return await extractRevertConfigFromWorkflow(args.config, args);
  }

  // Otherwise, require project key
  const projectKey = coerceProjectKey(args.project);
  if (!projectKey) {
    console.log(Colors.red("Error: Either --project or --config is required"));
    Deno.exit(1);
  }

  return [{
    projectKey,
    sourceProjectKey: coerceProjectKey(args.sourceProject),
    domain: args.domain || "app.launchdarkly.com",
    dryRun: args.dryRun || false,
    deleteViews: args.deleteViews || false,
    viewKeys: args.views ? args.views.split(",") : undefined,
    useSourceData: false
  }];
};

// ==================== API Request Helpers ====================

/**
 * Creates a DELETE request for LaunchDarkly API
 */
const ldAPIDeleteRequest = (apiKey: string, domain: string, path: string) => {
  const req = new Request(
    `https://${domain}/api/v2/${path}`,
    {
      method: "DELETE",
      headers: {
        "Authorization": apiKey,
        "User-Agent": "launchdarkly-migration-revert-script",
      },
    },
  );
  return req;
};

/**
 * Creates a PATCH request for LaunchDarkly API
 */
const ldAPIPatchRequest = (
  apiKey: string,
  domain: string,
  path: string,
  body: any,
  useBetaVersion = false
) => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; domain-model=launchdarkly.semanticpatch",
    "Authorization": apiKey,
    "User-Agent": "launchdarkly-migration-revert-script",
  };
  
  if (useBetaVersion) {
    headers["LD-API-Version"] = "beta";
  }

  const req = new Request(
    `https://${domain}/api/v2/${path}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    },
  );
  return req;
};

// ==================== Flag Discovery ====================

/**
 * Loads flag list from extracted source data
 */
const loadFlagListFromSourceData = async (sourceProjectKey: string): Promise<string[] | null> => {
  const flagsPath = `./data/launchdarkly-migrations/source/project/${sourceProjectKey}/flags.json`;
  
  try {
    const fileContent = await Deno.readTextFile(flagsPath);
    const flagsData = JSON.parse(fileContent);
    
    // Extract flag keys from the items array
    if (flagsData.items && Array.isArray(flagsData.items)) {
      return flagsData.items.map((item: any) => item.key);
    }
    
    // Fallback: if it's a direct array of keys
    if (Array.isArray(flagsData)) {
      return flagsData;
    }
    
    console.log(Colors.yellow(`Warning: Unexpected format in ${flagsPath}`));
    return null;
  } catch (error) {
    console.log(Colors.yellow(
      `Warning: Could not load source data from ${flagsPath}: ${error}`
    ));
    return null;
  }
};

/** Flag keys a source's migration created in the destination, and whether they are actual destination keys. */
export interface MigratedFlagKeys {
  /** Source project the keys belong to */
  project: string;
  keys: string[];
  /**
   * manifest: real destination keys from the sync manifest (prefix renames included);
   * extract: raw keys from the extracted source flag list; none: neither is available
   */
  source: "manifest" | "extract" | "none";
}

/**
 * Loads the destination flag keys of one source's migration. The sync manifest migrate writes is
 * authoritative: it records the destination key of every migrated flag, including conflict-prefixed
 * ones. Only when there is no manifest at all (for example after a dry run only) is the extracted
 * source flag list used.
 * @throws Error when a manifest exists but is unreadable, records another project pair, or is marked
 *   incomplete by an aborted run: falling back to raw keys could select another source's flag
 */
const loadMigratedFlagKeys = async (
  sourceProjectKey: string,
  destProjectKey: string
): Promise<MigratedFlagKeys> => {
  const manifestPath = syncManifestPath(sourceProjectKey, destProjectKey);
  const manifest = await readSyncManifest(sourceProjectKey, destProjectKey);
  if (manifest) {
    assertManifestComplete(manifest, manifestPath);
    const keys = manifestDestinationFlagKeys(manifest);
    console.log(Colors.gray(`  Using sync manifest ${manifestPath} (${keys.length} flag(s), destination keys)`));
    return { project: sourceProjectKey, keys, source: "manifest" };
  }
  console.log(Colors.gray(`  No sync manifest at ${manifestPath}; using the extracted source flag list`));
  const extracted = await loadFlagListFromSourceData(sourceProjectKey);
  return extracted
    ? { project: sourceProjectKey, keys: extracted, source: "extract" }
    : { project: sourceProjectKey, keys: [], source: "none" };
};

/**
 * Splits a source's flag keys into the ones this revert may remove and the ambiguous ones.
 * Manifest keys are real destination keys and are all kept. Extracted source keys are not: a key
 * that another source merged into the same destination holds (per that sibling's manifest) may be
 * the sibling's flag, ours having been created with a conflict prefix, so it is left in place.
 * A sibling's own extracted list says nothing about its destination keys (a prefix may have renamed
 * them), so without a manifest for every sibling, raw-key deletion is refused.
 * @throws Error when `own` has no manifest and some sibling has no manifest either
 */
export const selectRevertFlagKeys = (
  own: MigratedFlagKeys,
  siblings: MigratedFlagKeys[]
): { keys: string[]; ambiguous: string[] } => {
  const unique = [...new Set(own.keys)];
  if (own.source === "manifest" || siblings.length === 0) {
    return { keys: unique, ambiguous: [] };
  }
  const unverifiable = siblings.filter(s => s.source !== "manifest").map(s => s.project);
  if (unverifiable.length > 0) {
    throw new Error(
      `Cannot attribute ${own.project}'s flags: no sync manifest for ${own.project}, and ${unverifiable.join(", ")} ` +
      `migrated into the same destination without a sync manifest of their own (extracted keys are not destination ` +
      `keys: a conflict prefix may have renamed them). Re-run those migrations to write their manifests, or revert ` +
      `with --no-use-source-data after checking the flags by hand.`
    );
  }
  const siblingKeys = new Set(siblings.flatMap(s => s.keys));
  const keys: string[] = [];
  const ambiguous: string[] = [];
  for (const key of unique) {
    (siblingKeys.has(key) ? ambiguous : keys).push(key);
  }
  return { keys, ambiguous };
};

/**
 * Fetches a single flag by key
 * Uses beta API to ensure viewKeys are included
 */
const fetchFlagByKey = async (
  apiKey: string,
  domain: string,
  projectKey: string,
  flagKey: string
): Promise<Flag | null> => {
  try {
    // Use beta API to get viewKeys field
    const req = ldAPIRequest(apiKey, domain, `flags/${projectKey}/${flagKey}`, true);
    const response = await rateLimitRequest(req, 'flags');
    
    if (response.status === 200) {
      return await response.json();
    }
    
    // Flag doesn't exist (404) or other error
    return null;
  } catch (error) {
    console.log(Colors.gray(`  Warning: Could not fetch flag ${flagKey}: ${error}`));
    return null;
  }
};

/**
 * Fetches multiple flags by their keys
 */
const fetchFlagsByKeys = async (
  apiKey: string,
  domain: string,
  projectKey: string,
  flagKeys: string[]
): Promise<Flag[]> => {
  console.log(Colors.gray(`  Fetching ${flagKeys.length} flag(s) from destination...`));
  const flags: Flag[] = [];
  
  for (const flagKey of flagKeys) {
    const flag = await fetchFlagByKey(apiKey, domain, projectKey, flagKey);
    if (flag) {
      flags.push(flag);
    }
  }
  
  return flags;
};

/**
 * Checks if a flag was created by the migration script
 */
const isMigrationFlag = (flag: Flag, sourceProjectKey?: string): boolean => {
  if (!flag.description) return false;
  
  const hasMarker = flag.description.includes(MIGRATION_DESCRIPTION_MARKER);
  
  if (sourceProjectKey) {
    return hasMarker && flag.description.includes(`from project "${sourceProjectKey}"`);
  }
  
  return hasMarker;
};

/**
 * Flag keys from other sources merged into the same destination that this revert leaves in place.
 * Used to keep views those sources' flags may still rely on.
 */
export const findRemainingSiblingFlagKeys = (
  siblingFlagKeys: string[],
  revertingFlagKeys: Set<string>
): string[] =>
  [...new Set(siblingFlagKeys)].filter(key => !revertingFlagKeys.has(key));

/**
 * Fetches all flags from a project
 */
const fetchAllFlags = async (
  apiKey: string,
  domain: string,
  projectKey: string
): Promise<Flag[]> => {
  const req = ldAPIRequest(apiKey, domain, `flags/${projectKey}?limit=1000`);
  const response = await rateLimitRequest(req, 'flags');
  
  if (response.status !== 200) {
    throw new Error(`Failed to fetch flags: HTTP ${response.status}`);
  }
  
  const data = await response.json();
  return data.items || [];
};

/**
 * Filters flags to only those created by migration
 */
const identifyMigrationFlags = (flags: Flag[], sourceProjectKey?: string): Flag[] =>
  flags.filter(flag => isMigrationFlag(flag, sourceProjectKey));

/**
 * Smart flag discovery - uses source data when available
 */
const discoverMigrationFlags = async (
  apiKey: string,
  domain: string,
  config: RevertConfig
): Promise<{ flags: Flag[], stats: { checked: number, identified: number } }> => {
  // Strategy 1: Use the sync manifest or source data for a precise flag list (much faster!)
  if (config.useSourceData && config.sourceProjectKey) {
    console.log(Colors.cyan("  Using the sync manifest / extracted source data for the flag list (smart mode)"));
    const own = await loadMigratedFlagKeys(config.sourceProjectKey, config.projectKey);
    // Siblings only matter for raw source keys; manifest keys already are the destination keys
    const siblings: MigratedFlagKeys[] = [];
    if (own.source !== "manifest") {
      for (const sibling of config.siblingSourceKeys ?? []) {
        siblings.push(await loadMigratedFlagKeys(sibling, config.projectKey));
      }
    }
    const { keys: sourceFlags, ambiguous } = selectRevertFlagKeys(own, siblings);
    if (ambiguous.length > 0) {
      console.log(Colors.yellow(
        `  ⚠ Leaving ${ambiguous.length} flag(s) in place: the sync manifests of ${config.siblingSourceKeys!.join(", ")} hold the same key(s), ` +
        `and without a sync manifest for ${config.sourceProjectKey} they cannot be attributed to one source: ${ambiguous.join(", ")}`
      ));
      console.log(Colors.gray(`    Revert them by hand, or re-run after a migration has written ${syncManifestPath(config.sourceProjectKey, config.projectKey)}`));
    }
    if (own.source === "extract" && siblings.length > 0) {
      console.log(Colors.gray(
        `  Note: flags ${config.sourceProjectKey} migrated under a conflict prefix are not detected without its sync manifest`
      ));
    }
    
    if (sourceFlags.length > 0) {
      console.log(Colors.gray(`  Found ${sourceFlags.length} flag(s) in source data`));
      console.log(Colors.gray(`  Checking which exist in destination...`));
      
      const destinationFlags = await fetchFlagsByKeys(
        apiKey,
        domain,
        config.projectKey,
        sourceFlags
      );
      
      console.log(Colors.gray(`  Found ${destinationFlags.length} matching flag(s) in destination`));
      
      let migrationFlags: Flag[];
      if (own.source === "manifest") {
        // Manifest keys are the destination keys this migration wrote: every fetched flag is one of its
        // copies, prefixed or not, so the description-marker heuristic must not filter them
        migrationFlags = destinationFlags;
      } else {
        // Raw source keys: prefer flags carrying the migration marker in their description
        migrationFlags = identifyMigrationFlags(destinationFlags, config.sourceProjectKey);
        // If no flags found with description marker, assume all flags from source list are migration flags
        // This handles the case where the migration script doesn't add description markers
        if (migrationFlags.length === 0 && destinationFlags.length > 0) {
          console.log(Colors.yellow(`  Note: No migration markers found in descriptions`));
          console.log(Colors.cyan(`  Assuming all ${destinationFlags.length} flag(s) from source are migration flags`));
          migrationFlags = destinationFlags;
        }
      }
      
      return {
        flags: migrationFlags,
        stats: {
          checked: sourceFlags.length,
          identified: migrationFlags.length
        }
      };
    }
    
    if (own.source === "manifest") {
      // An empty manifest is authoritative too (e.g. every flag was conflict-skipped): a destination-wide
      // scan could select marker-matching flags that this migration never wrote
      console.log(Colors.yellow("  The sync manifest lists no flags for this source; nothing to revert"));
      return { flags: [], stats: { checked: 0, identified: 0 } };
    }
    if (ambiguous.length > 0) {
      // Every key was ambiguous: a full scan would only find marker-less flags, which could be the siblings'
      console.log(Colors.yellow("  No unambiguous flags to revert"));
      return { flags: [], stats: { checked: own.keys.length, identified: 0 } };
    }
    console.log(Colors.yellow("  No source data found, falling back to full scan"));
  }
  
  // Strategy 2: Fetch all flags and filter (slower but works without source data)
  console.log(Colors.gray("  Fetching all flags from destination project..."));
  const allFlags = await fetchAllFlags(apiKey, domain, config.projectKey);
  const migrationFlags = identifyMigrationFlags(allFlags, config.sourceProjectKey);
  
  return {
    flags: migrationFlags,
    stats: {
      checked: allFlags.length,
      identified: migrationFlags.length
    }
  };
};

// ==================== Approval Request Management ====================

/**
 * Fetches approval requests for a flag across all environments
 */
const fetchFlagApprovalRequests = async (
  apiKey: string,
  domain: string,
  projectKey: string,
  flagKey: string,
  environments: string[]
): Promise<ApprovalRequest[]> => {
  const allRequests: ApprovalRequest[] = [];
  
  for (const env of environments) {
    try {
      const req = ldAPIRequest(
        apiKey,
        domain,
        `projects/${projectKey}/flags/${flagKey}/environments/${env}/approval-requests`
      );
      const response = await rateLimitRequest(req, 'approval-requests');
      
      if (response.status === 200) {
        const data = await response.json();
        const envRequests = (data.items || []).map((r: any) => ({
          ...r,
          environment: env
        }));
        allRequests.push(...envRequests);
      }
    } catch (error) {
      // Environment might not exist or no permissions, continue
      console.log(Colors.gray(`  Warning: Could not fetch approvals for ${env}`));
    }
  }
  
  return allRequests;
};

/**
 * Deletes a single approval request
 */
const deleteApprovalRequest = async (
  apiKey: string,
  domain: string,
  projectKey: string,
  flagKey: string,
  environment: string,
  approvalId: string,
  dryRun: boolean
): Promise<boolean> => {
  if (dryRun) {
    console.log(Colors.gray(`  [DRY RUN] Would delete approval ${approvalId} for ${environment}`));
    return true;
  }
  
  const req = ldAPIDeleteRequest(
    apiKey,
    domain,
    `projects/${projectKey}/flags/${flagKey}/environments/${environment}/approval-requests/${approvalId}`
  );
  
  const response = await rateLimitRequest(req, 'approval-requests');
  return response.status === 204 || response.status === 200;
};

/**
 * Deletes all approval requests for a flag
 */
const deleteAllApprovalRequests = async (
  apiKey: string,
  domain: string,
  projectKey: string,
  flagKey: string,
  approvals: ApprovalRequest[],
  dryRun: boolean
): Promise<number> => {
  let deletedCount = 0;
  
  for (const approval of approvals) {
    const success = await deleteApprovalRequest(
      apiKey,
      domain,
      projectKey,
      flagKey,
      (approval as any).environment,
      approval._id,
      dryRun
    );
    
    if (success) {
      deletedCount++;
    }
  }
  
  return deletedCount;
};

// ==================== View Management ====================

/**
 * Fetches all views from a project
 */
const fetchProjectViews = async (
  apiKey: string,
  domain: string,
  projectKey: string
): Promise<any[]> => {
  try {
    const req = ldAPIRequest(apiKey, domain, `projects/${projectKey}/views`, true);
    const response = await rateLimitRequest(req, 'views');
    
    if (response.status === 200) {
      const data = await response.json();
      return data.items || [];
    }
  } catch (error) {
    console.log(Colors.yellow(`Warning: Could not fetch views: ${error}`));
  }
  
  return [];
};

/**
 * Fetches views linked to a flag
 */
const fetchFlagViews = async (
  apiKey: string,
  domain: string,
  projectKey: string,
  flagKey: string,
  debug: boolean = false
): Promise<string[]> => {
  try {
    const req = ldAPIRequest(
      apiKey,
      domain,
      `projects/${projectKey}/flags/${flagKey}/views`,
      true  // Use beta API version
    );
    const response = await rateLimitRequest(req, 'flags');
    
    if (debug) {
      console.log(Colors.gray(`      DEBUG: GET /api/v2/projects/${projectKey}/flags/${flagKey}/views -> ${response.status}`));
    }
    
    if (response.status === 200) {
      const data = await response.json();
      if (debug) {
        console.log(Colors.gray(`      DEBUG: Response has ${data.items?.length || 0} view(s): ${(data.items || []).map((v: any) => v.key).join(', ') || 'none'}`));
      }
      // Extract view keys from the response
      return (data.items || []).map((item: any) => item.key);
    } else if (debug) {
      const errorText = await response.text();
      console.log(Colors.yellow(`      DEBUG: Error - ${errorText}`));
    }
  } catch (error) {
    if (debug) {
      console.log(Colors.yellow(`      DEBUG: Exception - ${error}`));
    }
  }
  
  return [];
};

/**
 * Finds flags linked to a view by checking each flag individually
 * This is a fallback when the /views/{viewKey}/linked/flags endpoint fails
 */
const findFlagsLinkedToView = async (
  apiKey: string,
  domain: string,
  projectKey: string,
  viewKey: string,
  flagKeys: string[]
): Promise<string[]> => {
  console.log(Colors.gray(`    Checking ${flagKeys.length} flag(s) for view links...`));
  const linkedFlags: string[] = [];
  
  for (let i = 0; i < flagKeys.length; i++) {
    const flagKey = flagKeys[i];
    // Debug first 3 flags
    const debug = i < 3;
    const views = await fetchFlagViews(apiKey, domain, projectKey, flagKey, debug);
    if (views.includes(viewKey)) {
      linkedFlags.push(flagKey);
    }
  }
  
  return linkedFlags;
};

/**
 * Removes a flag from a view
 */
const unlinkFlagFromView = async (
  apiKey: string,
  domain: string,
  projectKey: string,
  viewKey: string,
  flagKey: string,
  dryRun: boolean
): Promise<boolean> => {
  if (dryRun) {
    console.log(Colors.gray(`  [DRY RUN] Would unlink ${flagKey} from view ${viewKey}`));
    return true;
  }
  
  try {
    const req = ldAPIDeleteRequest(
      apiKey,
      domain,
      `projects/${projectKey}/views/${viewKey}/links/flag/${flagKey}`
    );
    
    const response = await rateLimitRequest(req, 'views');
    return response.status === 204 || response.status === 200;
  } catch (error) {
    console.log(Colors.red(`  Error unlinking ${flagKey} from view: ${error}`));
    return false;
  }
};

/**
 * Removes multiple flags from a view
 */
const unlinkFlagsFromView = async (
  apiKey: string,
  domain: string,
  projectKey: string,
  viewKey: string,
  flagKeys: string[],
  dryRun: boolean
): Promise<number> => {
  let unlinkedCount = 0;
  
  for (const flagKey of flagKeys) {
    const success = await unlinkFlagFromView(
      apiKey,
      domain,
      projectKey,
      viewKey,
      flagKey,
      dryRun
    );
    
    if (success) {
      unlinkedCount++;
    }
  }
  
  return unlinkedCount;
};

/**
 * Deletes a view
 */
const deleteView = async (
  apiKey: string,
  domain: string,
  projectKey: string,
  viewKey: string,
  dryRun: boolean
): Promise<boolean> => {
  if (dryRun) {
    console.log(Colors.gray(`  [DRY RUN] Would delete view ${viewKey}`));
    return true;
  }
  
  try {
    const req = ldAPIDeleteRequest(
      apiKey,
      domain,
      `projects/${projectKey}/views/${viewKey}`
    );
    
    const response = await rateLimitRequest(req, 'views');
    return response.status === 204 || response.status === 200;
  } catch (error) {
    console.log(Colors.red(`  Error deleting view ${viewKey}: ${error}`));
    return false;
  }
};

// ==================== Flag Operations ====================

/**
 * Fetches project environments
 */
const fetchProjectEnvironments = async (
  apiKey: string,
  domain: string,
  projectKey: string
): Promise<string[]> => {
  try {
    const req = ldAPIRequest(apiKey, domain, `projects/${projectKey}/environments`);
    const response = await rateLimitRequest(req, 'environments');
    
    if (response.status === 200) {
      const data = await response.json();
      return (data.items || []).map((env: any) => env.key);
    }
  } catch (error) {
    console.log(Colors.yellow(`Warning: Could not fetch environments: ${error}`));
  }
  
  return [];
};

/**
 * Archives a flag
 */
const archiveFlag = async (
  apiKey: string,
  domain: string,
  projectKey: string,
  flagKey: string,
  dryRun: boolean
): Promise<boolean> => {
  if (dryRun) {
    console.log(Colors.gray(`  [DRY RUN] Would archive flag ${flagKey}`));
    return true;
  }
  
  // ldAPIPatchRequest sends the semantic patch content type, so the body must use instructions
  const patch = { instructions: [{ kind: "archiveFlag" }] };
  const req = ldAPIPatchRequest(apiKey, domain, `flags/${projectKey}/${flagKey}`, patch);
  
  const response = await rateLimitRequest(req, 'flags');
  return response.status >= 200 && response.status < 300;
};

/**
 * Deletes a flag
 */
const deleteFlag = async (
  apiKey: string,
  domain: string,
  projectKey: string,
  flagKey: string,
  dryRun: boolean
): Promise<boolean> => {
  if (dryRun) {
    console.log(Colors.gray(`  [DRY RUN] Would delete flag ${flagKey}`));
    return true;
  }
  
  const req = ldAPIDeleteRequest(apiKey, domain, `flags/${projectKey}/${flagKey}`);
  const response = await rateLimitRequest(req, 'flags');
  return response.status === 204 || response.status === 200;
};

// ==================== Revert Orchestration ====================

/**
 * Processes a single flag for revert
 */
const revertFlag = async (
  apiKey: string,
  domain: string,
  config: RevertConfig,
  flag: Flag,
  environments: string[],
  stats: RevertStats
): Promise<void> => {
  console.log(Colors.cyan(`\n Processing flag: ${flag.key}`));
  
  try {
    // 1. Delete approval requests
    const approvals = await fetchFlagApprovalRequests(
      apiKey,
      domain,
      config.projectKey,
      flag.key,
      environments
    );
    
    if (approvals.length > 0) {
      console.log(Colors.gray(`  Found ${approvals.length} approval request(s)`));
      const deleted = await deleteAllApprovalRequests(
        apiKey,
        domain,
        config.projectKey,
        flag.key,
        approvals,
        config.dryRun || false
      );
      stats.approvalsDeleted += deleted;
      console.log(Colors.green(`  ✓ Deleted ${deleted} approval request(s)`));
    }
    
    // 2. Archive flag
    const archived = await archiveFlag(
      apiKey,
      domain,
      config.projectKey,
      flag.key,
      config.dryRun || false
    );
    
    if (archived) {
      stats.flagsArchived++;
      console.log(Colors.green(`  ✓ Archived flag`));
    } else {
      console.log(Colors.yellow(`  ⚠ Could not archive flag`));
    }
    
    // 3. Delete flag
    const deleted = await deleteFlag(
      apiKey,
      domain,
      config.projectKey,
      flag.key,
      config.dryRun || false
    );
    
    if (deleted) {
      stats.flagsDeleted++;
      console.log(Colors.green(`  ✓ Deleted flag`));
    } else {
      console.log(Colors.yellow(`  ⚠ Could not delete flag`));
    }
    
  } catch (error) {
    const errorMsg = `Error processing flag ${flag.key}: ${error}`;
    stats.errors.push(errorMsg);
    console.log(Colors.red(`  ✗ ${errorMsg}`));
  }
};

/**
 * Processes views for revert
 */
const revertViews = async (
  apiKey: string,
  domain: string,
  config: RevertConfig,
  migrationFlags: Flag[],
  stats: RevertStats
): Promise<void> => {
  console.log(Colors.cyan("\n🔷 Processing Views"));
  
  if (!config.viewKeys || config.viewKeys.length === 0) {
    console.log(Colors.gray("  No target views specified, skipping view processing"));
    return;
  }
  
  const views = await fetchProjectViews(apiKey, domain, config.projectKey);
  const targetViews = views.filter(v => config.viewKeys!.includes(v.key));
  
  if (targetViews.length === 0) {
    console.log(Colors.gray("  Target views not found in project"));
    return;
  }
  
  console.log(Colors.gray(`  Found ${targetViews.length} view(s) to process`));

  // The view-link endpoints are unreliable, so a merged destination's view is kept while flags from
  // its other sources still exist in the project. Only a sibling's sync manifest names its destination
  // keys; its extracted list does not (a conflict prefix may have renamed them), so without a manifest
  // the sibling's flags cannot be checked and the view stays.
  let otherSourceFlags: Flag[] = [];
  const unverifiableSiblings: string[] = [];
  if (config.deleteViews && config.siblingSourceKeys?.length) {
    const siblingKeys: string[] = [];
    for (const sibling of config.siblingSourceKeys) {
      const inventory = await loadMigratedFlagKeys(sibling, config.projectKey);
      if (inventory.source !== "manifest") {
        unverifiableSiblings.push(sibling);
        continue;
      }
      siblingKeys.push(...inventory.keys);
    }
    const remaining = findRemainingSiblingFlagKeys(
      siblingKeys,
      new Set(migrationFlags.map(f => f.key))
    );
    otherSourceFlags = await fetchFlagsByKeys(apiKey, domain, config.projectKey, remaining);
  }
  
  for (const view of targetViews) {
    console.log(Colors.cyan(`\n  Processing view: ${view.key}`));
    
    // NOTE: LaunchDarkly's beta Views API has issues:
    // - GET /projects/{proj}/views/{view}/linked/flags returns 500
    // - GET /projects/{proj}/flags/{flag}/views returns 404
    // So we'll attempt to unlink ALL migration flags from this view
    // The API will ignore unlink requests for flags that aren't actually linked
    
    const migrationFlagKeys = migrationFlags.map(f => f.key);
    console.log(Colors.gray(`    Attempting to unlink ${migrationFlagKeys.length} migration flag(s)...`));
    console.log(Colors.gray(`    (Note: API will ignore flags that aren't actually linked)`));
    
    const unlinked = await unlinkFlagsFromView(
      apiKey,
      domain,
      config.projectKey,
      view.key,
      migrationFlagKeys,
      config.dryRun || false
    );
    stats.viewLinksRemoved += unlinked;
    
    if (unlinked > 0) {
      console.log(Colors.green(`    ✓ Unlinked ${unlinked} flag(s) from view`));
    } else {
      console.log(Colors.gray(`    No flags were unlinked (they may not have been linked)`));
    }
    
    // Delete view if requested
    if (config.deleteViews && unverifiableSiblings.length > 0) {
      // Without an inventory the sibling's flags cannot be checked, so the view has to stay
      console.log(Colors.yellow(
        `    ⚠ Keeping view: no sync manifest for ${unverifiableSiblings.join(", ")}, so their flags in this ` +
        `destination cannot be checked (extracted keys are not destination keys)`
      ));
    } else if (config.deleteViews && otherSourceFlags.length > 0) {
      console.log(Colors.yellow(
        `    ⚠ Keeping view: ${otherSourceFlags.length} flag(s) migrated from other source project(s) remain ` +
        `(e.g. ${otherSourceFlags.slice(0, 3).map(f => f.key).join(", ")})`
      ));
    } else if (config.deleteViews) {
      const deleted = await deleteView(
        apiKey,
        domain,
        config.projectKey,
        view.key,
        config.dryRun || false
      );
      
      if (deleted) {
        stats.viewsDeleted++;
        console.log(Colors.green(`    ✓ Deleted view`));
      } else {
        console.log(Colors.yellow(`    ⚠ Could not delete view`));
      }
    }
  }
};

/**
 * Prints revert summary
 */
const printRevertSummary = (config: RevertConfig, stats: RevertStats): void => {
  const divider = "=".repeat(70);
  
  console.log(Colors.blue(`\n\n${divider}`));
  console.log(Colors.blue("📊 REVERT SUMMARY"));
  console.log(Colors.blue(divider));
  
  if (config.dryRun) {
    console.log(Colors.yellow("\n⚠️  DRY RUN MODE - No actual changes were made\n"));
  }
  
  console.log(Colors.cyan("\nStatistics:"));
  console.log(Colors.gray(`  Flags checked: ${stats.flagsChecked}`));
  console.log(Colors.cyan(`  Migration flags identified: ${stats.flagsIdentified}`));
  console.log(Colors.green(`  Approval requests deleted: ${stats.approvalsDeleted}`));
  console.log(Colors.green(`  View links removed: ${stats.viewLinksRemoved}`));
  console.log(Colors.green(`  Flags archived: ${stats.flagsArchived}`));
  console.log(Colors.green(`  Flags deleted: ${stats.flagsDeleted}`));
  console.log(Colors.green(`  Views deleted: ${stats.viewsDeleted}`));
  
  if (stats.errors.length > 0) {
    console.log(Colors.red(`\n❌ Errors encountered: ${stats.errors.length}`));
    stats.errors.forEach(err => {
      console.log(Colors.red(`  • ${err}`));
    });
  }
  
  console.log(Colors.blue(`\n${divider}`));
  
  if (config.dryRun) {
    console.log(Colors.cyan("ℹ️  Run without --dry-run to execute the revert"));
  } else if (stats.errors.length === 0) {
    console.log(Colors.green("✓ Revert completed successfully"));
  } else {
    console.log(Colors.yellow("⚠ Revert completed with errors"));
  }
  
  console.log(Colors.blue(`${divider}\n`));
};

// ==================== Main Entry Point ====================

const printProjectBanner = (index: number, total: number, projectKey: string): void => {
  const divider = "=".repeat(60);
  console.log(Colors.magenta(`\n${divider}`));
  console.log(Colors.magenta(`Project ${index + 1}/${total}: ${projectKey}`));
  console.log(Colors.magenta(`${divider}\n`));
};

/**
 * Reverts a single destination project
 */
const revertProject = async (apiKey: string, config: RevertConfig): Promise<void> => {
  console.log(Colors.cyan("Configuration:"));
  console.log(Colors.gray(`  Project: ${config.projectKey}`));
  if (config.sourceProjectKey) {
    console.log(Colors.gray(`  Source Project: ${config.sourceProjectKey}`));
  }
  if (config.configFile) {
    console.log(Colors.gray(`  Config File: ${config.configFile}`));
  }
  console.log(Colors.gray(`  Domain: ${config.domain}`));
  console.log(Colors.gray(`  Smart Mode: ${config.useSourceData ? "enabled" : "disabled"}`));
  console.log(Colors.gray(`  Dry Run: ${config.dryRun}`));
  console.log(Colors.gray(`  Delete Views: ${config.deleteViews}`));
  if (config.viewKeys) {
    console.log(Colors.gray(`  Target Views: ${config.viewKeys.join(", ")}`));
  }
  
  if (config.dryRun) {
    console.log(Colors.yellow("\n⚠️  DRY RUN MODE - No changes will be made\n"));
  }
  
  if (config.useSourceData) {
    console.log(Colors.cyan("\n💡 Smart Mode enabled - using source data for faster execution"));
  }
  
  const stats: RevertStats = {
    flagsChecked: 0,
    flagsIdentified: 0,
    approvalsDeleted: 0,
    viewLinksRemoved: 0,
    flagsArchived: 0,
    flagsDeleted: 0,
    viewsDeleted: 0,
    errors: []
  };
  
  try {
    const domain = config.domain || "app.launchdarkly.com";
    
    // 1. Discover migration flags (smart or full scan)
    console.log(Colors.cyan("\n🚩 Step 1: Identifying migration flags"));
    const { flags: migrationFlags, stats: discoveryStats } = await discoverMigrationFlags(
      apiKey,
      domain,
      config
    );
    
    stats.flagsChecked = discoveryStats.checked;
    stats.flagsIdentified = discoveryStats.identified;
    
    console.log(Colors.cyan(`  Identified ${migrationFlags.length} migration flag(s) to revert`));
    
    if (migrationFlags.length === 0) {
      console.log(Colors.yellow("\nNo migration flags found. Nothing to revert."));
      return;
    }
    
    // 3. Fetch environments
    console.log(Colors.cyan("\n🌍 Step 2: Fetching environments"));
    const environments = await fetchProjectEnvironments(apiKey, domain, config.projectKey);
    console.log(Colors.gray(`  Found ${environments.length} environment(s)`));
    
    // 4. Process views first (remove flag links)
    console.log(Colors.cyan("\n👁️  Step 3: Processing views"));
    await revertViews(apiKey, domain, config, migrationFlags, stats);
    
    // 5. Process each flag
    console.log(Colors.cyan("\n🗑️  Step 4: Reverting flags"));
    for (const flag of migrationFlags) {
      await revertFlag(apiKey, domain, config, flag, environments, stats);
    }
    
    // 6. Print summary
    printRevertSummary(config, stats);
    
  } catch (error) {
    console.log(Colors.red(`\n❌ Fatal error: ${error instanceof Error ? error.message : String(error)}`));
    Deno.exit(1);
  }
};

/**
 * Main revert orchestration
 */
const main = async (): Promise<void> => {
  const configs = await parseArguments();
  const apiKey = await getDestinationApiKey();

  console.log(Colors.blue("\n🔄 LaunchDarkly Migration Revert Tool"));
  console.log(Colors.blue("=".repeat(70) + "\n"));

  for (let i = 0; i < configs.length; i++) {
    if (configs.length > 1) {
      printProjectBanner(i, configs.length, configs[i].projectKey);
    }
    await revertProject(apiKey, configs[i]);
  }
};

if (import.meta.main) {
  main();
}

