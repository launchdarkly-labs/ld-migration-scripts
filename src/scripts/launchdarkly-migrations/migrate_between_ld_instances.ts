// deno-lint-ignore-file no-explicit-any
import yargs from "https://deno.land/x/yargs@v17.7.2-deno/deno.ts";
import {
  buildPatch,
  buildRules,
  consoleLogger,
  getJson,
  ldAPIPatchRequest,
  ldAPIPostRequest,
  ldAPIRequest,
  rateLimitRequest,
  type Rule,
  checkViewExists,
  createView,
  type View,
  ConflictTracker,
  applyConflictPrefix,
  // delay
} from "../../utils/utils.ts";
import * as Colors from "https://deno.land/std@0.149.0/fmt/colors.ts";
import { parse as parseYaml } from "https://deno.land/std@0.224.0/yaml/parse.ts";
import { getDestinationApiKey } from "../../utils/api_keys.ts";

interface Arguments {
  projKeySource: string;
  projKeyDest: string;
  assignMaintainerIds: boolean;
  migrateSegments: boolean;
  conflictPrefix?: string;
  targetView?: string;
  environments?: string;
  envMap?: string;
  domain?: string;
  config?: string;
  dryRun?: boolean;
}

interface MigrationConfig {
  source: {
    projectKey: string;
    domain?: string;
  };
  destination: {
    projectKey: string;
    domain?: string;
  };
  options?: {
    assignMaintainerIds?: boolean;
    migrateSegments?: boolean;
    conflictPrefix?: string;
    targetView?: string;
    environments?: string[];
    environmentMapping?: Record<string, string>;
    dryRun?: boolean;
  };
}

// ==================== Dry Run Helpers ====================

/**
 * Simulates an API POST request in dry-run mode
 */
function simulatePostRequest(resource: string, data: any): Response {
  console.log(Colors.gray(`    [DRY RUN] Would POST to ${resource}`));
  return new Response(JSON.stringify({ success: true, _id: 'dry-run-id' }), { 
    status: 201,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Simulates an API PATCH request in dry-run mode
 */
function simulatePatchRequest(resource: string, patches: any[], context?: string): Response {
  if (context) {
    console.log(Colors.gray(`    [DRY RUN] Would PATCH ${resource} for ${context} with ${patches.length} operation(s)`));
  } else {
    console.log(Colors.gray(`    [DRY RUN] Would PATCH ${resource} with ${patches.length} operation(s)`));
  }
  return new Response(JSON.stringify({ success: true }), { 
    status: 200,
    headers: { 'Content-Type': 'application/json' }
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
  rateLimit: string = 'default'
): Promise<Response> {
  if (dryRun) {
    return simulatePostRequest(path, body);
  }
  return await rateLimitRequest(
    ldAPIPostRequest(apiKey, domain, path, body, useBeta),
    rateLimit
  );
}

/**
 * Wraps PATCH requests with dry-run support
 */
async function dryRunAwarePatch(
  dryRun: boolean,
  apiKey: string,
  domain: string,
  path: string,
  patches: any[],
  _useBeta = false,  // Not currently supported by ldAPIPatchRequest
  rateLimit: string = 'default',
  context?: string  // Optional context for better dry-run logging (e.g., environment name)
): Promise<Response> {
  if (dryRun) {
    return simulatePatchRequest(path, patches, context);
  }
  return await rateLimitRequest(
    ldAPIPatchRequest(apiKey, domain, path, patches),
    rateLimit
  );
}

// ==================== Project Helpers ====================

// Add function to check if project exists
async function checkProjectExists(apiKey: string, domain: string, projectKey: string): Promise<boolean> {
  const req = ldAPIRequest(apiKey, domain, `projects/${projectKey}`);
  const response = await rateLimitRequest(req, 'projects');
  return response.status === 200;
}

// Add function to get existing project environments
async function getExistingEnvironments(apiKey: string, domain: string, projectKey: string): Promise<string[]> {
  const req = ldAPIRequest(apiKey, domain, `projects/${projectKey}/environments`);
  const response = await rateLimitRequest(req, 'environments');
  if (response.status === 200) {
    const data = await response.json();
    return data.items.map((env: any) => env.key);
  }
  return [];
}

const cliArgs: Arguments = (yargs(Deno.args)
  .alias("p", "projKeySource")
  .alias("d", "projKeyDest")
  .alias("m", "assignMaintainerIds")
  .alias("s", "migrateSegments")
  .alias("c", "conflictPrefix")
  .alias("v", "targetView")
  .alias("e", "environments")
  .alias("env-map", "envMap")
  .alias("domain", "domain")
  .alias("f", "config")
  .alias("dry-run", "dryRun")
  .boolean("m")
  .boolean("s")
  .boolean("dry-run")
  .default("m", false)
  .default("s", true)
  .describe("c", "Prefix to use when resolving key conflicts (e.g., 'imported-')")
  .describe("v", "View key to link all migrated flags to")
  .describe("e", "Comma-separated list of environment keys to migrate (e.g., 'production,staging')")
  .describe("env-map", "Environment mapping in format 'source1:dest1,source2:dest2' (e.g., 'prod:production,dev:development')")
  .describe("domain", "Destination LaunchDarkly domain (default: app.launchdarkly.com)")
  .describe("f", "Path to YAML config file. CLI arguments override config file values.")
  .describe("dry-run", "Preview migration without making any changes")
  .parse() as unknown) as Arguments;

// Load and merge config file if provided
let inputArgs = cliArgs;
if (cliArgs.config) {
  console.log(Colors.cyan(`Loading configuration from: ${cliArgs.config}`));
  try {
    const configContent = await Deno.readTextFile(cliArgs.config);
    const config = parseYaml(configContent) as MigrationConfig;
    
    // Merge config file with CLI args (CLI args take precedence)
    inputArgs = {
      projKeySource: cliArgs.projKeySource || config.source.projectKey,
      projKeyDest: cliArgs.projKeyDest || config.destination.projectKey,
      assignMaintainerIds: cliArgs.assignMaintainerIds !== undefined && cliArgs.assignMaintainerIds !== false 
        ? cliArgs.assignMaintainerIds 
        : config.options?.assignMaintainerIds ?? false,
      migrateSegments: cliArgs.migrateSegments !== undefined && cliArgs.migrateSegments !== true
        ? cliArgs.migrateSegments
        : config.options?.migrateSegments ?? true,
      conflictPrefix: cliArgs.conflictPrefix || config.options?.conflictPrefix,
      targetView: cliArgs.targetView || config.options?.targetView,
      environments: cliArgs.environments || config.options?.environments?.join(','),
      envMap: cliArgs.envMap || (config.options?.environmentMapping 
        ? Object.entries(config.options.environmentMapping).map(([k, v]) => `${k}:${v}`).join(',')
        : undefined),
      domain: cliArgs.domain || config.destination?.domain,
      dryRun: cliArgs.dryRun ?? config.options?.dryRun ?? false,
      config: cliArgs.config
    };
    
    console.log(Colors.green(`✓ Configuration loaded successfully\n`));
  } catch (error) {
    console.log(Colors.red(`Error loading config file: ${error instanceof Error ? error.message : String(error)}`));
    Deno.exit(1);
  }
}

console.log(Colors.blue("\n=== Migration Script Starting ==="));
console.log(Colors.gray(`Source Project: ${cliArgs.projKeySource || '(from config)'}`));
console.log(Colors.gray(`Destination Project: ${cliArgs.projKeyDest || '(from config)'}`));

// Validate required arguments
if (!inputArgs.projKeySource || !inputArgs.projKeyDest) {
  console.log(Colors.red(`Error: Both source project (-p) and destination project (-d) are required.`));
  console.log(Colors.yellow(`Provide them via CLI arguments or config file.`));
  Deno.exit(1);
}

console.log(Colors.blue("\n📋 Configuration Summary:"));
console.log(Colors.gray(`  Source: ${inputArgs.projKeySource}`));
console.log(Colors.gray(`  Destination: ${inputArgs.projKeyDest}`));
console.log(Colors.gray(`  Assign Maintainers: ${inputArgs.assignMaintainerIds}`));
console.log(Colors.gray(`  Migrate Segments: ${inputArgs.migrateSegments}`));
console.log(Colors.gray(`  Conflict Prefix: ${inputArgs.conflictPrefix || 'none'}`));
console.log(Colors.gray(`  Target View: ${inputArgs.targetView || 'none'}`));
console.log(Colors.gray(`  Environments: ${inputArgs.environments || 'all'}`));
console.log(Colors.gray(`  Env Mapping: ${inputArgs.envMap || 'none'}`));
console.log(Colors.gray(`  Domain: ${inputArgs.domain || 'app.launchdarkly.com'}`));
console.log(Colors.gray(`  Dry Run: ${inputArgs.dryRun || false}`));

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
  const memberResp = await rateLimitRequest(memberReq, 'members');
  if (memberResp.status === 200) {
    const memberData = await memberResp.json();
    currentMemberId = memberData._id;
    console.log(Colors.gray(`Authenticated as member: ${memberData.email || currentMemberId}`));
  } else {
    console.log(Colors.gray(`Authenticated with service token (approval requests may not notify anyone)`));
  }
} catch (error) {
  console.log(Colors.gray(`Could not determine authenticated user type`));
}

// Parse environment mapping
const envMapping: Record<string, string> = {};
const reverseEnvMapping: Record<string, string> = {};
if (inputArgs.envMap) {
  const mappings = inputArgs.envMap.split(',').map(m => m.trim());
  for (const mapping of mappings) {
    const [source, dest] = mapping.split(':').map(s => s.trim());
    if (!source || !dest) {
      console.log(Colors.red(`Error: Invalid environment mapping format: "${mapping}"`));
      console.log(Colors.red(`Expected format: "source:dest" (e.g., "prod:production")`));
      Deno.exit(1);
    }
    envMapping[source] = dest;
    reverseEnvMapping[dest] = source;
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
  console.log(Colors.cyan(`Conflict prefix enabled: "${inputArgs.conflictPrefix}"`));
  console.log(Colors.cyan(`Resources with conflicting keys will be created with this prefix.`));
}

// Load maintainer mapping if needed
console.log(Colors.blue("👥 Loading maintainer mapping..."));
let maintainerMapping: Record<string, string | null> = {};
if (inputArgs.assignMaintainerIds) {
  try {
  maintainerMapping = await getJson("./data/launchdarkly-migrations/mappings/maintainer_mapping.json") || {};
    console.log(Colors.green(`✓ Loaded maintainer mapping with ${Object.keys(maintainerMapping).length} entries`));
  } catch (error) {
    console.log(Colors.yellow(`⚠ Warning: Could not load maintainer mapping file: ${error}`));
    console.log(Colors.yellow(`  Continuing without maintainer mapping...`));
  }
} else {
  console.log(Colors.gray("  Maintainer mapping disabled"));
}

// Project Data //
console.log(Colors.blue(`\n📦 Loading source project data from: ${inputArgs.projKeySource}...`));
const projectJson = await getJson(
  `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/project.json`,
);

if (!projectJson) {
  console.log(Colors.red(`❌ Error: Could not load project data from ./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/project.json`));
  console.log(Colors.yellow(`Make sure you've run the extract-source step first!`));
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
  if (env.defaultTrackEvents) newEnv.defaultTrackEvents = env.defaultTrackEvents;
  if (env.tags) newEnv.tags = env.tags;

  buildEnv.push(newEnv);
});

let envkeys: Array<string> = buildEnv.map((env: any) => env.key);

// Filter environments if specified
if (inputArgs.environments) {
  const requestedEnvs = inputArgs.environments.split(',').map(e => e.trim());
  const originalEnvCount = envkeys.length;
  envkeys = envkeys.filter(key => requestedEnvs.includes(key));
  
  console.log(Colors.cyan(`\n=== Environment Filtering ===`));
  console.log(`Requested environments: ${requestedEnvs.join(', ')}`);
  console.log(`Matched environments: ${envkeys.join(', ')}`);
  
  const notFound = requestedEnvs.filter(e => !envkeys.includes(e));
  if (notFound.length > 0) {
    console.log(Colors.yellow(`Warning: Requested environments not found in source: ${notFound.join(', ')}`));
  }
  
  if (envkeys.length === 0) {
    console.log(Colors.red(`Error: None of the requested environments exist in source project.`));
    console.log(Colors.red(`Available environments: ${buildEnv.map((e: any) => e.key).join(', ')}`));
    Deno.exit(1);
  }
  
  console.log(`Migrating ${envkeys.length} of ${originalEnvCount} environments\n`);
}

// Apply environment mapping if specified
// If mapping is provided, filter to only mapped source environments
if (inputArgs.envMap) {
  const mappedSourceEnvs = Object.keys(envMapping);
  const originalEnvCount = envkeys.length;
  envkeys = envkeys.filter(key => mappedSourceEnvs.includes(key));
  
  if (envkeys.length === 0) {
    console.log(Colors.red(`Error: None of the mapped source environments exist in the source project.`));
    console.log(Colors.red(`Mapped source environments: ${mappedSourceEnvs.join(', ')}`));
    console.log(Colors.red(`Available source environments: ${buildEnv.map((e: any) => e.key).join(', ')}`));
    Deno.exit(1);
  }
  
  console.log(Colors.cyan(`Migrating ${envkeys.length} mapped environment(s)\n`));
}

// Check if project exists
console.log(Colors.blue(`\n🔍 Checking if destination project "${inputArgs.projKeyDest}" exists...`));
const targetProjectExists = await checkProjectExists(apiKey, domain, inputArgs.projKeyDest);

if (targetProjectExists) {
  console.log(Colors.green(`✓ Project ${inputArgs.projKeyDest} already exists, skipping creation`));
  
  // Get existing environments
  console.log(Colors.blue(`  Fetching existing environments...`));
  const existingEnvs = await getExistingEnvironments(apiKey, domain, inputArgs.projKeyDest);
  console.log(Colors.gray(`  Found existing environments: ${existingEnvs.join(', ')}`));
  
  // If environment mapping is enabled, check destination environments exist
  if (inputArgs.envMap) {
    const mappedDestEnvs = envkeys.map(srcKey => envMapping[srcKey]);
    const missingDestEnvs = mappedDestEnvs.filter(destKey => !existingEnvs.includes(destKey));
    
    if (missingDestEnvs.length > 0) {
      console.log(Colors.red(`Error: The following mapped destination environments don't exist in target project:`));
      missingDestEnvs.forEach(destKey => {
        const srcKey = reverseEnvMapping[destKey];
        console.log(Colors.red(`  ${srcKey} → ${destKey} (destination "${destKey}" not found)`));
      });
      console.log(Colors.red(`Available destination environments: ${existingEnvs.join(', ')}`));
      Deno.exit(1);
    }
  } else {
    // Original behavior: filter to matching environment keys
  const missingEnvs = envkeys.filter(key => !existingEnvs.includes(key));
  if (missingEnvs.length > 0) {
    console.log(Colors.yellow(`Warning: The following environments from source project don't exist in target project: ${missingEnvs.join(', ')}`));
    console.log(Colors.yellow('Skipping these environments...'));
  }
  
  // Update envkeys to only include environments that exist in the target project
  envkeys.length = 0;
  envkeys.push(...existingEnvs);
  }
} else {
  console.log(`Creating new project ${inputArgs.projKeyDest}`);
  const projPost: any = {
    key: inputArgs.projKeyDest,
    name: inputArgs.projKeyDest,
    tags: projectJson.tags,
    environments: buildEnv,
  };

  if (projectJson.defaultClientSideAvailability) {
    projPost.defaultClientSideAvailability = projectJson.defaultClientSideAvailability;
  } else {
    projPost.includeInSnippetByDefault = projectJson.includeInSnippetByDefault;
  }

  const projResp = await dryRunAwarePost(
    inputArgs.dryRun || false,
    apiKey,
    domain,
    `projects`,
    projPost,
    false,
    'projects'
  );

  consoleLogger(
    projResp.status,
    `Creating Project: ${inputArgs.projKeyDest} Status: ${projResp.status}`,
  );
  await projResp.json();
}

// View Management //
console.log(Colors.cyan("\n=== View Management ==="));
const allViewKeys = new Set<string>();

// Extract views from flags
console.log(Colors.blue("\n📋 Loading flag list..."));
const flagList: Array<string> = await getJson(
  `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/flags.json`,
);

if (!flagList) {
  console.log(Colors.red(`❌ Error: Could not load flag list from ./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/flags.json`));
  Deno.exit(1);
}
console.log(Colors.green(`✓ Loaded ${flagList.length} flags`));

console.log("Extracting view associations from source flags...");
for (const flagkey of flagList) {
  const flag = await getJson(
    `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/flags/${flagkey}.json`,
  );
  
  if (flag && flag.viewKeys && Array.isArray(flag.viewKeys)) {
    flag.viewKeys.forEach((viewKey: string) => allViewKeys.add(viewKey));
  }
}

// Add target view if specified
if (inputArgs.targetView) {
  allViewKeys.add(inputArgs.targetView);
  console.log(Colors.cyan(`Target view specified: "${inputArgs.targetView}"`));
}

if (allViewKeys.size > 0) {
  console.log(`Found ${allViewKeys.size} unique view(s) to create/verify: ${Array.from(allViewKeys).join(', ')}`);
  
  // Create views in destination project
  for (const viewKey of allViewKeys) {
    console.log(`Checking/creating view: ${viewKey}`);
    
    const viewExists = await checkViewExists(apiKey, domain, inputArgs.projKeyDest, viewKey);
    
    if (viewExists) {
      console.log(Colors.green(`  ✓ View "${viewKey}" already exists`));
    } else {
      console.log(`  Creating view "${viewKey}"...`);
      const viewData: View = {
        key: viewKey,
        name: viewKey,
        description: `Migrated from project ${inputArgs.projKeySource}`,
      };
      
      const result = await createView(apiKey, domain, inputArgs.projKeyDest, viewData);
      
      if (result.success) {
        console.log(Colors.green(`  ✓ View "${viewKey}" created successfully`));
      } else {
        console.log(Colors.yellow(`  ⚠ Failed to create view "${viewKey}": ${result.error}`));
      }
    }
  }
} else {
  console.log("No views found in source flags.");
}

// Migrate segments if enabled
console.log(Colors.blue("\n🔷 Starting segment migration..."));
if (inputArgs.migrateSegments) {
  console.log(Colors.green("  Segment migration enabled"));
  // Filter environments to only those selected
  const envsToMigrate = projectJson.environments.items.filter((env: any) => envkeys.includes(env.key));
  console.log(Colors.gray(`  Processing ${envsToMigrate.length} environment(s) for segments`));
  for (const env of envsToMigrate) {
            const segmentData = await getJson(
          `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/segments/${env.key}.json`,
        );
    
    // Skip if no segment data exists for this environment
    if (!segmentData || !segmentData.items) {
      console.log(Colors.yellow(`  ⚠ No segment data found for environment: ${env.key}, skipping...`));
      continue;
    }

    // Determine destination environment key (mapped or original)
    const destEnvKey = inputArgs.envMap && envMapping[env.key] ? envMapping[env.key] : env.key;

    // We are ignoring big segments/synced segments for now
    for (const segment of segmentData.items) {
      if (segment.unbounded == true) {
        console.log(Colors.yellow(
          `Segment: ${segment.key} in Environment ${env.key} is unbounded, skipping`,
        ));
        continue;
      }

      let segmentKey = segment.key;
      let segmentName = segment.name;
      let attemptCount = 0;
      let segmentCreated = false;

      while (!segmentCreated && attemptCount < 2) {
        attemptCount++;

      const newSegment: any = {
          name: segmentName,
          key: segmentKey,
      };

      if (segment.tags) newSegment.tags = segment.tags;
      if (segment.description) newSegment.description = segment.description;

      const segmentResp = await dryRunAwarePost(
        inputArgs.dryRun || false,
        apiKey,
        domain,
        `segments/${inputArgs.projKeyDest}/${destEnvKey}`,
        newSegment,
        false,
        'segments'
      );

      const segmentStatus = await segmentResp.status;
        
        if (segmentStatus === 201 || segmentStatus === 200) {
          segmentCreated = true;
          console.log(Colors.green(`  ✓ Segment ${newSegment.key} created (status: ${segmentStatus})`));
        } else if (segmentStatus === 409) {
          // Segment already exists
          if (inputArgs.conflictPrefix && attemptCount === 1) {
            // Conflict detected with prefix enabled, retry with prefix
            console.log(Colors.yellow(`  ⚠ Segment "${segmentKey}" already exists, retrying with prefix...`));
            segmentKey = applyConflictPrefix(segment.key, inputArgs.conflictPrefix);
            segmentName = `${inputArgs.conflictPrefix}${segment.name}`;
            
            conflictTracker.addResolution({
              originalKey: segment.key,
              resolvedKey: segmentKey,
              resourceType: 'segment',
              conflictPrefix: inputArgs.conflictPrefix
            });
          } else {
            // No prefix or second attempt - segment exists, proceed to update it
            segmentCreated = true;
            console.log(Colors.yellow(`  ⚠ Segment "${segmentKey}" already exists, will update rules...`));
            break; // Exit retry loop and proceed to patching
          }
        } else {
          console.log(Colors.red(`  ✗ Error creating segment ${newSegment.key} (status: ${segmentStatus})`));
      if (segmentStatus > 201) {
            console.log(Colors.gray(`  Payload: ${JSON.stringify(newSegment)}`));
          }
          break; // Exit loop on non-conflict errors
        }
      }

      // Build Segment Patches - use the possibly updated segmentKey
      if (segmentCreated) {
      const sgmtPatches = [];

      if (segment.included?.length > 0) {
        sgmtPatches.push(buildPatch("included", "add", segment.included));
      }
      if (segment.excluded?.length > 0) {
        sgmtPatches.push(buildPatch("excluded", "add", segment.excluded));
      }

      if (segment.rules?.length > 0) {
          console.log(`Copying Segment: ${segmentKey} rules`);
        sgmtPatches.push(...buildRules(segment.rules));
      }

      const patchRules = await dryRunAwarePatch(
        inputArgs.dryRun || false,
          apiKey,
          domain,
        `segments/${inputArgs.projKeyDest}/${destEnvKey}/${segmentKey}`,
          sgmtPatches,
        false,
        'segments',
        `environment: ${destEnvKey}`  // Pass environment context for better dry-run logging
      );

      const segPatchStatus = patchRules.statusText;
      consoleLogger(
        patchRules.status,
          `Patching segment ${segmentKey} status: ${segPatchStatus}`,
      );
      }
    };
  };
} else {
  console.log(Colors.gray("  Segment migration disabled, skipping..."));
}

// ==================== Semantic Patch Conversion ====================
// Converts JSON Patch operations to LaunchDarkly's Semantic Patch format

type VariationIdMapper = (index: number) => string | undefined;
type SemanticInstruction = Record<string, any>;
type ConversionResult = { instructions: SemanticInstruction[], skippedFields: string[] };

/**
 * Creates a variation ID mapper from flag variations
 */
const createVariationMapper = (variations: any[]): VariationIdMapper => 
  (index: number) => variations[index]?._id;

/**
 * Extracts the environment field name from a JSON Patch path
 */
const extractFieldFromPath = (path: string): string | null => {
  const pathParts = path.split('/');
  const envIndex = pathParts.indexOf('environments');
  return envIndex !== -1 ? pathParts[envIndex + 2] : null;
};

/**
 * Converts rollout variations from indices to UUIDs
 */
const convertRolloutVariations = (rollout: any, getVariationId: VariationIdMapper) => ({
  ...rollout,
  variations: rollout.variations?.map((v: any) => ({
    ...v,
    variation: getVariationId(v.variation) || v.variation
  }))
});

/**
 * Converts a flag on/off patch to semantic instruction
 */
const convertOnOffInstruction = (value: boolean): SemanticInstruction => ({
  kind: value ? 'turnFlagOn' : 'turnFlagOff'
});

/**
 * Converts an off variation patch to semantic instruction
 */
const convertOffVariationInstruction = (
  value: number, 
  getVariationId: VariationIdMapper
): SemanticInstruction | null => {
  const variationId = getVariationId(value);
  return variationId ? { kind: 'updateOffVariation', variationId } : null;
};

/**
 * Converts a fallthrough patch to semantic instruction
 */
const convertFallthroughInstruction = (
  value: any,
  getVariationId: VariationIdMapper
): SemanticInstruction | null => {
  const instruction: SemanticInstruction = {
    kind: 'updateFallthroughVariationOrRollout'
  };

  if (value.variation !== undefined) {
    const variationId = getVariationId(value.variation);
    if (variationId) {
      instruction.variationId = variationId;
    }
  } else if (value.rollout) {
    instruction.rollout = convertRolloutVariations(value.rollout, getVariationId);
  }

  return (instruction.variationId || instruction.rollout) ? instruction : null;
};

/**
 * Converts a rule patch to semantic instruction
 */
const convertRuleInstruction = (
  patch: any,
  getVariationId: VariationIdMapper
): SemanticInstruction | null => {
  if (patch.op !== 'add' || !patch.path.includes('rules/-')) {
    return null;
  }

  const instruction: SemanticInstruction = {
    kind: 'addRule',
    clauses: patch.value.clauses || [],
    ...(patch.value.description && { description: patch.value.description })
  };

  if (patch.value.variation !== undefined) {
    const variationId = getVariationId(patch.value.variation);
    if (variationId) {
      instruction.variationId = variationId;
    }
  } else if (patch.value.rollout) {
    instruction.rollout = convertRolloutVariations(patch.value.rollout, getVariationId);
  }

  return instruction;
};

/**
 * Converts a single JSON Patch to a semantic instruction
 */
const convertPatchToSemanticInstruction = (
  patch: any,
  getVariationId: VariationIdMapper
): { instruction: SemanticInstruction | null, shouldSkip: boolean } => {
  const field = extractFieldFromPath(patch.path);
  if (!field) return { instruction: null, shouldSkip: false };

  switch (field) {
    case 'on':
      return { instruction: convertOnOffInstruction(patch.value), shouldSkip: false };
    case 'offVariation':
      return { instruction: convertOffVariationInstruction(patch.value, getVariationId), shouldSkip: false };
    case 'fallthrough':
      return { instruction: convertFallthroughInstruction(patch.value, getVariationId), shouldSkip: false };
    case 'rules':
      return { instruction: convertRuleInstruction(patch, getVariationId), shouldSkip: false };
    case 'trackEvents':
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
  envKey: string,
  variations: any[]
): ConversionResult => {
  const getVariationId = createVariationMapper(variations);
  const skippedFields = new Set<string>();
  
  const instructions = jsonPatches.reduce<SemanticInstruction[]>((acc, patch) => {
    const { instruction, shouldSkip } = convertPatchToSemanticInstruction(patch, getVariationId);
    
    if (shouldSkip) {
      const field = extractFieldFromPath(patch.path);
      if (field) skippedFields.add(field);
    }
    
    if (instruction) {
      acc.push(instruction);
    }
    
    return acc;
  }, []);

  if (skippedFields.size > 0) {
    console.log(Colors.gray(
      `\t    ⓘ Skipped fields (set manually after approval): ${Array.from(skippedFields).join(', ')}`
    ));
  }

  return {
    instructions,
    skippedFields: Array.from(skippedFields)
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
  const activeStatuses = ['pending', 'scheduled', 'failed'];
  return activeStatuses.includes(request.status);
};

/**
 * Finds active approval requests for a flag environment
 */
const findActiveApprovalRequests = async (
  flagKey: string,
  env: string
): Promise<ApprovalRequest[]> => {
  const listApprovalsReq = ldAPIRequest(
    apiKey,
    domain,
    `projects/${inputArgs.projKeyDest}/flags/${flagKey}/environments/${env}/approval-requests`
  );
  
  const response = await rateLimitRequest(listApprovalsReq, 'approval-requests');
  
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
  fallbackMemberId: string | null
): { recipients: string[], warning: string | null } => {
  if (maintainerId) {
    return { recipients: [maintainerId], warning: null };
  }
  
  if (fallbackMemberId) {
    return {
      recipients: [fallbackMemberId],
      warning: 'No maintainer mapped, notifying creating member'
    };
  }
  
  return {
    recipients: [],
    warning: 'No one to notify (service token used and no maintainer)'
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
  fallbackMemberId: string | null
): { body: ApprovalRequestBody, warning: string | null } => {
  const { recipients, warning } = determineNotificationRecipients(maintainerId, fallbackMemberId);
  
  const body: ApprovalRequestBody = {
    description: `Migration of flag "${flagKey}" environment "${env}" from project "${inputArgs.projKeySource}"`,
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
  skippedFields: string[]
): void => {
  approvalRequestsCreated.push({ flag: flagKey, env, skippedFields });
  
  if (skippedFields.length > 0) {
    if (!skippedFieldsByFlag.has(flagKey)) {
      skippedFieldsByFlag.set(flagKey, new Set());
    }
    const flagSkipped = skippedFieldsByFlag.get(flagKey)!;
    skippedFields.forEach(field => flagSkipped.add(field));
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
  variations: any[]
): Promise<void> => {
  console.log(Colors.cyan(`\t  → ${env}: Requires approval, checking for existing requests...`));
  
  try {
    // Check for existing active approval requests
    const activeApprovals = await findActiveApprovalRequests(flagKey, env);
    
    if (activeApprovals.length > 0) {
      const approval = activeApprovals[0];
      console.log(Colors.yellow(
        `\t  ⚠ ${env}: Existing approval request found (ID: ${approval._id}, status: ${approval.status})`
      ));
      console.log(Colors.gray(`\t    Skipping creation to avoid duplicates`));
      
      trackApprovalRequest(flagKey, env, []); // Don't know existing request's skipped fields
      return;
    }
    
    // Convert patches to semantic instructions
    console.log(Colors.gray(`\t    No existing requests, creating new approval request...`));
    const conversionResult = convertToSemanticPatch(patchReq, env, variations);
    
    console.log(Colors.gray(
      `\t    Converting ${patchReq.length} JSON patches → ${conversionResult.instructions.length} semantic instructions`
    ));
    
    if (conversionResult.instructions.length === 0) {
      console.log(Colors.yellow(`\t  ⚠ ${env}: No valid instructions to approve, skipping`));
      return;
    }
    
    // Create approval request body
    const { body, warning } = createApprovalRequestBody(
      flagKey,
      env,
      conversionResult.instructions,
      maintainerId,
      fallbackMemberId
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
      'approval-requests'
    );
    
    if (approvalResp.status >= 200 && approvalResp.status < 300) {
      console.log(Colors.green(`\t  ✓ ${env}: Approval request created`));
      trackApprovalRequest(flagKey, env, conversionResult.skippedFields);
    } else {
      const errorBody = await approvalResp.text();
      console.log(Colors.yellow(
        `\t  ⚠ ${env}: Failed to create approval request (status: ${approvalResp.status})`
      ));
      console.log(Colors.gray(`\t    API response: ${errorBody}`));
      flagsWithErrors.add(flagKey);
    }
  } catch (error) {
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
  env: string
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
  }
  // Success (200-201) - no logging needed for each env
};

/**
 * Checks if a patch would actually change the environment configuration
 * Returns true if changes are needed, false if environment is already in desired state
 */
const wouldPatchChangeEnvironment = (
  currentEnvConfig: any,
  patchOperations: any[],
  variations: any[]
): boolean => {
  // If no current config, changes are needed
  if (!currentEnvConfig) return true;
  
  // Check each patch operation to see if it would actually change something
  for (const patch of patchOperations) {
    const pathParts = patch.path.split('/');
    // Path format: /environments/{envKey}/{field} or /environments/{envKey}/rules/-
    
    if (pathParts.length < 4) continue;
    
    const field = pathParts[3];
    
    // Get current value from the environment config
    let currentValue = currentEnvConfig[field];
    
    switch (patch.op) {
      case 'replace':
        // For replace operations, compare values
        if (field === 'offVariation' || field === 'on') {
          // Direct value comparison
          if (currentValue !== patch.value) {
            return true;
          }
        } else if (field === 'fallthrough') {
          // Compare fallthrough configuration
          const currentFallthrough = JSON.stringify(currentValue);
          const newFallthrough = JSON.stringify(patch.value);
          if (currentFallthrough !== newFallthrough) {
            return true;
          }
        }
        break;
        
      case 'add':
        // For add operations (like adding rules), assume change is needed
        // unless the exact rule already exists at that position
        if (field === 'rules') {
          // Compare rules array
          const currentRules = JSON.stringify(currentEnvConfig.rules || []);
          const newRules = JSON.stringify(patch.value);
          if (currentRules !== newRules) {
            return true;
          }
        } else {
          // Other add operations are assumed to be changes
          return true;
        }
        break;
        
      case 'remove':
        // Remove operations are changes if the thing exists
        if (currentValue !== undefined && currentValue !== null) {
          return true;
        }
        break;
        
      default:
        // Unknown operation type, assume it's a change
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
const makePatchCall = async (
  flagKey: string,
  patchReq: any[],
  env: string,
  maintainerId: string | null,
  fallbackMemberId: string | null,
  variations: any[],
  destinationFlag: any,
  retryCount: number = 0
): Promise<Set<string>> => {
  // Check if this patch would actually change anything
  const currentEnvConfig = destinationFlag?.environments?.[env];
  const hasChanges = wouldPatchChangeEnvironment(currentEnvConfig, patchReq, variations);
  
  if (!hasChanges) {
    console.log(Colors.gray(`\t  ✓ ${env}: Already up to date, skipping`));
    return flagsWithErrors;
  }
  
  const patchFlagReq = await dryRunAwarePatch(
    inputArgs.dryRun || false,
      apiKey,
      domain,
      `flags/${inputArgs.projKeyDest}/${flagKey}`,
      patchReq,
    false,
    'flags',
    `environment: ${env}`  // Pass environment context for better dry-run logging
  );
  
  const flagPatchStatus = patchFlagReq.status;
  
  if (flagPatchStatus === 404 && retryCount < 2) {
    // Environment not ready yet, wait and retry
    console.log(Colors.gray(`\t  ⏳ ${env}: Environment not ready, retrying in 3s... (attempt ${retryCount + 1}/2)`));
    await new Promise(resolve => setTimeout(resolve, 3000));
    return await makePatchCall(flagKey, patchReq, env, maintainerId, fallbackMemberId, variations, destinationFlag, retryCount + 1);
  } else if (flagPatchStatus === 405) {
    // Environment requires approval workflow
    await handleApprovalWorkflow(
      flagKey,
      env,
      patchReq,
      maintainerId,
      fallbackMemberId,
      variations
    );
  } else {
    await handlePatchResponse(flagPatchStatus, patchFlagReq, flagKey, env);
  }

  return flagsWithErrors;
};

console.log(Colors.blue("\n🚩 Starting flag migration..."));
const flagsWithErrors: Set<string> = new Set();
const approvalRequestsCreated: Array<{flag: string, env: string, skippedFields: string[]}> = [];
const skippedFieldsByFlag: Map<string, Set<string>> = new Map();

interface Variation {
  _id: string;
  value: any;
  name?: string;
  description?: string;
}

// Creating Global Flags //
console.log(Colors.blue(`\n🏁 Creating ${flagList.length} flags in destination project...\n`));
for (const [index, flagkey] of flagList.entries()) {
  // Read flag
  console.log(Colors.cyan(`\n[${index + 1}/${flagList.length}] Processing flag: ${flagkey}`));

  const flag = await getJson(
    `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/flags/${flagkey}.json`,
  );

  if (!flag) {
    console.log(Colors.yellow(`\tWarning: Could not load flag data for ${flagkey}, skipping...`));
    continue;
  }

  if (!flag.variations) {
    console.log(Colors.yellow(`\t⚠ No variations, skipping`));
    continue;
  }
  
  if (!flag.key || flag.key.trim() === '') {
    console.log(Colors.red(`\t✗ ERROR: Flag data has empty key! Expected: "${flagkey}"`));
    continue;
  }

  const newVariations = flag.variations.map(({ _id, ...rest }: Variation) => rest);

  let flagKey = flag.key;
  let flagName = flag.name;
  let attemptCount = 0;
  let flagCreated = false;
  let createdFlagKey = flag.key;
  let flagMaintainerId: string | null = null;
  let flagAlreadyExisted = false;

  // First, check if the flag already exists in the destination
  try {
    const checkFlagReq = ldAPIRequest(
      apiKey,
      domain,
      `flags/${inputArgs.projKeyDest}/${flagKey}`
    );
    const checkFlagResp = await rateLimitRequest(checkFlagReq, 'flags');
    
    if (checkFlagResp.status === 200) {
      // Flag already exists
      if (inputArgs.conflictPrefix) {
        // Conflict prefix enabled - we'll try creating with prefix
        console.log(Colors.yellow(`\t⚠ Flag exists, will try with prefix "${inputArgs.conflictPrefix}"`));
        flagKey = applyConflictPrefix(flag.key, inputArgs.conflictPrefix);
        flagName = `${inputArgs.conflictPrefix}${flag.name}`;
        flagAlreadyExisted = false; // Will attempt creation with prefixed key
        
        conflictTracker.addResolution({
          originalKey: flag.key,
          resolvedKey: flagKey,
          resourceType: 'flag',
          conflictPrefix: inputArgs.conflictPrefix
        });
      } else {
        // No conflict prefix - update existing flag
        flagCreated = true;
        flagAlreadyExisted = true;
        createdFlagKey = flagKey;
        console.log(Colors.gray(`\t⚠ Flag already exists, will update environments...`));
      }
    } else if (checkFlagResp.status === 404) {
      // Flag doesn't exist, we'll create it
      flagAlreadyExisted = false;
    }
  } catch (error) {
    // If check fails, proceed with creation attempt
    console.log(Colors.gray(`\t  Could not check if flag exists, will attempt creation...`));
  }

  while (!flagCreated && attemptCount < 2) {
    attemptCount++;

  const newFlag: any = {
      key: flagKey,
      name: flagName,
    variations: newVariations,
    temporary: flag.temporary,
    tags: flag.tags,
    description: flag.description,
    maintainerId: null  // Set to null by default to prevent API from assigning token owner
  };

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
      if (flag.viewKeys && Array.isArray(flag.viewKeys)) {
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
    'flags'
  );

  if (flagResp.status == 200 || flagResp.status == 201) {
        flagCreated = true;
        createdFlagKey = flagKey;
        if (viewKeys.length > 0) {
          console.log(Colors.green(`\t✓ Created and linked to view(s): ${viewKeys.join(', ')}`));
        } else {
          console.log(Colors.green(`\t✓ Created`));
        }
      } else if (flagResp.status === 409) {
        // Flag already exists (shouldn't happen if our check above worked)
        if (inputArgs.conflictPrefix && attemptCount === 1) {
          // Conflict detected with prefix enabled, retry with prefix
          console.log(Colors.yellow(`\t⚠ Conflict detected, retrying with prefix "${inputArgs.conflictPrefix}"`));
          flagKey = applyConflictPrefix(flag.key, inputArgs.conflictPrefix);
          flagName = `${inputArgs.conflictPrefix}${flag.name}`;
          flagAlreadyExisted = false; // Reset to attempt creation with new key
          
          conflictTracker.addResolution({
            originalKey: flag.key,
            resolvedKey: flagKey,
            resourceType: 'flag',
            conflictPrefix: inputArgs.conflictPrefix
          });
        } else {
          // No prefix or second attempt - flag exists, proceed to update it
          flagCreated = true;
          createdFlagKey = flagKey;
          console.log(Colors.gray(`\t⚠ Flag exists (409), will update environments...`));
          break; // Exit retry loop and proceed to patching
    }
  } else {
        // Real error
        console.log(Colors.red(`\t✗ Error ${flagResp.status}`));
    const errorText = await flagResp.text();
        console.log(Colors.red(`\t  ${errorText}`));
        break; // Exit loop on non-conflict errors
      }
    }
  }

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
        `flags/${inputArgs.projKeyDest}/${createdFlagKey}?env=*`  // Request all environments
      );
      const destFlagResp = await rateLimitRequest(destFlagReq, 'flags');
      
      if (destFlagResp.status === 200) {
        destinationFlag = await destFlagResp.json();
        if (destinationFlag.variations && Array.isArray(destinationFlag.variations)) {
          destinationVariations = destinationFlag.variations;
        }
      }
    } catch (error) {
      console.log(Colors.yellow(`\t⚠ Could not fetch destination flag, using source IDs (may cause issues with approval requests and skip detection)`));
    }
    
  for (const env of envkeys) {
    if (!flag.environments || !flag.environments[env]) {
      continue;
    }

      // Determine destination environment key (mapped or original)
      const destEnvKey = inputArgs.envMap && envMapping[env] ? envMapping[env] : env;

    const patchReq: any[] = [];
    const flagEnvData = flag.environments[env];
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

    Object.keys(parsedData)
      .map((key) => {
        if (key == "rules") {
            patchReq.push(...buildRules(parsedData[key] as unknown as Rule[], "environments/" + destEnvKey));
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
      await makePatchCall(createdFlagKey, patchReq, destEnvKey, flagMaintainerId, currentMemberId, destinationVariations, destinationFlag);
    }
  }
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
  approvals: ApprovalSummary[]
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
  console.log(Colors.yellow("The following flags require approval before changes take effect:\n"));
  
  const approvalsByFlag = groupApprovalsByFlag(approvals);
  
  approvalsByFlag.forEach((envs, flag) => {
    console.log(Colors.cyan(`  📋 ${flag}`));
    console.log(Colors.gray(`     Environments: ${envs.join(', ')}`));
  });
  
  console.log(Colors.yellow(
    `\n  Total: ${approvals.length} approval request(s) across ${approvalsByFlag.size} flag(s)`
  ));
  console.log(Colors.gray(`  → Review and approve these in the LaunchDarkly UI`));
};

/**
 * Prints non-migrated settings section
 */
const printNonMigratedSettingsSection = (
  skippedFields: Map<string, Set<string>>
): void => {
  if (skippedFields.size === 0) return;
  
  console.log(Colors.yellow("\n⚠️  NON-MIGRATED SETTINGS"));
  console.log(Colors.yellow("The following fields could not be migrated via approval requests:"));
  console.log(Colors.gray("These will need to be set manually after approvals are applied.\n"));
  
  skippedFields.forEach((fields, flag) => {
    console.log(Colors.cyan(`  📋 ${flag}`));
    console.log(Colors.gray(`     Fields: ${Array.from(fields).join(', ')}`));
  });
  
  console.log(Colors.yellow(`\n  Total: ${skippedFields.size} flag(s) with non-migrated settings`));
};

/**
 * Prints flags with errors section
 */
const printErrorsSection = (flagsWithErrors: Set<string>): void => {
  if (flagsWithErrors.size === 0) return;
  
  console.log(Colors.red("\n❌ FLAGS WITH ERRORS"));
  console.log(Colors.red("The following flags encountered errors during migration:\n"));
  
  flagsWithErrors.forEach((flag) => {
    console.log(Colors.red(`  ✗ ${flag}`));
  });
  
  console.log(Colors.red(`\n  Total: ${flagsWithErrors.size} flag(s) with errors`));
  console.log(Colors.gray(`  → Review these flags manually`));
};

/**
 * Determines the final migration status message
 */
const getMigrationStatusMessage = (
  approvalsCount: number,
  errorsCount: number
): { message: string; color: (text: string) => string } => {
  if (approvalsCount > 0) {
    return {
      message: `✓ Migration complete with ${approvalsCount} pending approval(s)`,
      color: Colors.cyan
    };
  }
  
  if (errorsCount > 0) {
    return {
      message: `⚠ Migration complete with ${errorsCount} error(s)`,
      color: Colors.yellow
    };
  }
  
  return {
    message: "✓ Migration complete successfully",
    color: Colors.green
  };
};

/**
 * Prints the complete migration summary report
 */
const printMigrationSummary = (
  approvals: ApprovalSummary[],
  skippedFields: Map<string, Set<string>>,
  flagsWithErrors: Set<string>,
  conflictReport: string
): void => {
  const divider = "=".repeat(70);
  
  console.log(Colors.blue(`\n\n${divider}`));
  console.log(Colors.blue("📊 MIGRATION SUMMARY"));
  console.log(Colors.blue(divider));
  
  printApprovalRequestsSection(approvals);
  printNonMigratedSettingsSection(skippedFields);
  printErrorsSection(flagsWithErrors);
  
  console.log(conflictReport);
  
  const { message, color } = getMigrationStatusMessage(
    approvals.length,
    flagsWithErrors.size
  );
  
  console.log(Colors.blue(`\n${divider}`));
  console.log(color(message));
  console.log(Colors.blue(`${divider}\n`));
};

// Print the migration summary
printMigrationSummary(
  approvalRequestsCreated,
  skippedFieldsByFlag,
  flagsWithErrors,
  conflictTracker.getReport()
);
