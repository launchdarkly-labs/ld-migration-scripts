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

// ==================== Type Definitions ====================

interface MigrationWorkflowConfig {
  source: {
    projectKey: string;
    domain?: string;
  };
  destination: {
    projectKey: string;
    domain?: string;
  };
  migration?: {
    targetView?: string;
  };
}

interface RevertConfig {
  projectKey: string;
  sourceProjectKey?: string;
  domain?: string;
  dryRun?: boolean;
  deleteViews?: boolean;
  viewKeys?: string[];
  configFile?: string;
  useSourceData?: boolean;
}

interface Arguments {
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
const loadMigrationConfig = async (configPath: string): Promise<MigrationWorkflowConfig> => {
  try {
    const configContent = await Deno.readTextFile(configPath);
    return parseYaml(configContent) as MigrationWorkflowConfig;
  } catch (error) {
    console.log(Colors.red(
      `Error loading config file: ${error instanceof Error ? error.message : String(error)}`
    ));
    Deno.exit(1);
  }
};

/**
 * Extracts revert config from migration workflow config
 */
const extractRevertConfigFromWorkflow = async (
  configPath: string,
  cliArgs: Arguments
): Promise<RevertConfig> => {
  const workflowConfig = await loadMigrationConfig(configPath);
  
  return {
    projectKey: cliArgs.project || workflowConfig.destination.projectKey,
    sourceProjectKey: cliArgs.sourceProject || workflowConfig.source.projectKey,
    domain: cliArgs.domain || workflowConfig.destination.domain || "app.launchdarkly.com",
    dryRun: cliArgs.dryRun || false,
    deleteViews: cliArgs.deleteViews || false,
    viewKeys: cliArgs.views 
      ? cliArgs.views.split(",")
      : (workflowConfig.migration?.targetView ? [workflowConfig.migration.targetView] : undefined),
    configFile: configPath,
    useSourceData: cliArgs.useSourceData !== false // Default to true when config is provided
  };
};

// ==================== Argument Parsing ====================

const parseArguments = async (): Promise<RevertConfig> => {
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
    .describe("dry-run", "Preview actions without making changes")
    .describe("delete-views", "Delete views after unlinking flags")
    .describe("v", "Comma-separated list of view keys to process")
    .describe("use-source-data", "Use extracted source data for faster flag list (default: true with --config)")
    .parse() as Arguments;

  // If config file provided, extract settings from it
  if (args.config) {
    return await extractRevertConfigFromWorkflow(args.config, args);
  }

  // Otherwise, require project key
  if (!args.project) {
    console.log(Colors.red("Error: Either --project or --config is required"));
    Deno.exit(1);
  }

  return {
    projectKey: args.project,
    sourceProjectKey: args.sourceProject,
    domain: args.domain || "app.launchdarkly.com",
    dryRun: args.dryRun || false,
    deleteViews: args.deleteViews || false,
    viewKeys: args.views ? args.views.split(",") : undefined,
    useSourceData: false
  };
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
const loadFlagListFromSourceData = async (sourceProjectKey: string): Promise<string[]> => {
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
    return [];
  } catch (error) {
    console.log(Colors.yellow(
      `Warning: Could not load source data from ${flagsPath}: ${error}`
    ));
    console.log(Colors.gray("Falling back to fetching all flags from destination"));
    return [];
  }
};

/**
 * Fetches a single flag by key
 */
const fetchFlagByKey = async (
  apiKey: string,
  domain: string,
  projectKey: string,
  flagKey: string
): Promise<Flag | null> => {
  try {
    const req = ldAPIRequest(apiKey, domain, `flags/${projectKey}/${flagKey}`);
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
  // Strategy 1: Use source data for precise flag list (much faster!)
  if (config.useSourceData && config.sourceProjectKey) {
    console.log(Colors.cyan("  Using extracted source data for flag list (smart mode)"));
    const sourceFlags = await loadFlagListFromSourceData(config.sourceProjectKey);
    
    if (sourceFlags.length > 0) {
      console.log(Colors.gray(`  Found ${sourceFlags.length} flag(s) in source data`));
      console.log(Colors.gray(`  Checking which exist in destination...`));
      
      const destinationFlags = await fetchFlagsByKeys(
        apiKey,
        domain,
        config.projectKey,
        sourceFlags
      );
      
      // Filter to only those with migration marker (in case some existed before)
      const migrationFlags = identifyMigrationFlags(
        destinationFlags,
        config.sourceProjectKey
      );
      
      return {
        flags: migrationFlags,
        stats: {
          checked: sourceFlags.length,
          identified: migrationFlags.length
        }
      };
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
 * Fetches linked resources for a view
 */
const fetchViewLinks = async (
  apiKey: string,
  domain: string,
  projectKey: string,
  viewKey: string
): Promise<ViewLink[]> => {
  try {
    const req = ldAPIRequest(
      apiKey,
      domain,
      `projects/${projectKey}/views/${viewKey}/links`,
      true
    );
    const response = await rateLimitRequest(req, 'views');
    
    if (response.status === 200) {
      const data = await response.json();
      return data.items || [];
    }
  } catch (error) {
    console.log(Colors.gray(`  Warning: Could not fetch links for view ${viewKey}`));
  }
  
  return [];
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
    const req = ldAPIRequest(apiKey, domain, `projects/${projectKey}`);
    const response = await rateLimitRequest(req, 'projects');
    
    if (response.status === 200) {
      const data = await response.json();
      return (data.environments?.items || []).map((env: any) => env.key);
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
  
  const patch = [{ op: "replace", path: "/archived", value: true }];
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
  
  const views = await fetchProjectViews(apiKey, domain, config.projectKey);
  const targetViews = config.viewKeys 
    ? views.filter(v => config.viewKeys!.includes(v.key))
    : views;
  
  if (targetViews.length === 0) {
    console.log(Colors.gray("  No views to process"));
    return;
  }
  
  console.log(Colors.gray(`  Found ${targetViews.length} view(s) to process`));
  
  for (const view of targetViews) {
    console.log(Colors.cyan(`\n  Processing view: ${view.key}`));
    
    // Get all links for this view
    const links = await fetchViewLinks(apiKey, domain, config.projectKey, view.key);
    
    // Filter to only migration flags
    const migrationFlagKeys = new Set(migrationFlags.map(f => f.key));
    const flagLinksToRemove = links
      .filter(link => link.resource.type === 'flag')
      .filter(link => migrationFlagKeys.has(link.resource.key))
      .map(link => link.resource.key);
    
    if (flagLinksToRemove.length > 0) {
      console.log(Colors.gray(`    Unlinking ${flagLinksToRemove.length} flag(s)`));
      const unlinked = await unlinkFlagsFromView(
        apiKey,
        domain,
        config.projectKey,
        view.key,
        flagLinksToRemove,
        config.dryRun || false
      );
      stats.viewLinksRemoved += unlinked;
      console.log(Colors.green(`    ✓ Unlinked ${unlinked} flag(s)`));
    } else {
      console.log(Colors.gray(`    No migration flags linked to this view`));
    }
    
    // Delete view if requested and all links removed
    if (config.deleteViews && flagLinksToRemove.length > 0) {
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

/**
 * Main revert orchestration
 */
const main = async (): Promise<void> => {
  const config = await parseArguments();
  const apiKey = await getDestinationApiKey();
  
  console.log(Colors.blue("\n🔄 LaunchDarkly Migration Revert Tool"));
  console.log(Colors.blue("=".repeat(70) + "\n"));
  
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

if (import.meta.main) {
  main();
}

