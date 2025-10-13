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
  };
}

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
  .boolean("m")
  .boolean("s")
  .default("m", false)
  .default("s", true)
  .describe("c", "Prefix to use when resolving key conflicts (e.g., 'imported-')")
  .describe("v", "View key to link all migrated flags to")
  .describe("e", "Comma-separated list of environment keys to migrate (e.g., 'production,staging')")
  .describe("env-map", "Environment mapping in format 'source1:dest1,source2:dest2' (e.g., 'prod:production,dev:development')")
  .describe("domain", "Destination LaunchDarkly domain (default: app.launchdarkly.com)")
  .describe("f", "Path to YAML config file. CLI arguments override config file values.")
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
  console.log(Colors.gray(`  Found existing environments: ${existingEnvs.join(', ')}`))
  
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

  const projResp = await rateLimitRequest(
    ldAPIPostRequest(apiKey, domain, `projects`, projPost),
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
          `./data/launchdarkly-migrations/source/project/${inputArgs.projKeySource}/segment-${env.key}.json`,
        );

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

      const post = ldAPIPostRequest(
        apiKey,
        domain,
          `segments/${inputArgs.projKeyDest}/${destEnvKey}`,
        newSegment,
      )

      const segmentResp = await rateLimitRequest(
        post,
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

      const patchRules = await rateLimitRequest(
        ldAPIPatchRequest(
          apiKey,
          domain,
            `segments/${inputArgs.projKeyDest}/${destEnvKey}/${segmentKey}`,
          sgmtPatches,
        ),
        'segments'
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

console.log(Colors.blue("\n🚩 Starting flag migration..."));
const flagsDoubleCheck: string[] = [];
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

    // Collect view associations (but don't add to newFlag yet)
    // We'll add them after creation due to a bug in LD's beta API
    const viewKeys: string[] = [];
    
    // Add source flag's view associations
    if (flag.viewKeys && Array.isArray(flag.viewKeys)) {
      viewKeys.push(...flag.viewKeys);
    }
    
    // Add target view if specified (and not already present)
    if (inputArgs.targetView && !viewKeys.includes(inputArgs.targetView)) {
      viewKeys.push(inputArgs.targetView);
    }

    // DON'T add viewKeys to newFlag - LD's beta API has a bug where including
    // viewKeys in flag creation causes the key field to be lost during parsing
    // We'll add views via PATCH after creation
    
  const flagResp = await rateLimitRequest(
    ldAPIPostRequest(
      apiKey,
      domain,
      `flags/${inputArgs.projKeyDest}`,
      newFlag,
        false // Never use beta version for flag creation
    ),
    'flags'
  );

  if (flagResp.status == 200 || flagResp.status == 201) {
      flagCreated = true;
      createdFlagKey = flagKey;
      console.log(Colors.green(`\t✓ Created`));
      
      // Now add flag to views via PATCH (if needed)
      if (viewKeys.length > 0) {
        console.log(Colors.cyan(`\t  Adding flag to view(s): ${viewKeys.join(', ')}`));
        try {
          const viewPatch = [{
            op: "add",
            path: "/viewKeys",
            value: viewKeys
          }];
          
          const viewPatchResp = await rateLimitRequest(
            ldAPIPatchRequest(
              apiKey,
              domain,
              `flags/${inputArgs.projKeyDest}/${flagKey}`,
              viewPatch
            ),
            'flags'
          );
          
          if (viewPatchResp.status >= 200 && viewPatchResp.status < 300) {
            console.log(Colors.green(`\t  ✓ Added to view(s)`));
          } else {
            console.log(Colors.yellow(`\t  ⚠ Failed to add to views (status: ${viewPatchResp.status})`));
          }
        } catch (error) {
          console.log(Colors.yellow(`\t  ⚠ Error adding to views: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    } else if (flagResp.status === 409) {
      // Flag already exists
      if (inputArgs.conflictPrefix && attemptCount === 1) {
        // Conflict detected with prefix enabled, retry with prefix
        console.log(Colors.yellow(`\t⚠ Exists, retrying with prefix "${inputArgs.conflictPrefix}"`));
        flagKey = applyConflictPrefix(flag.key, inputArgs.conflictPrefix);
        flagName = `${inputArgs.conflictPrefix}${flag.name}`;
        
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
        console.log(Colors.yellow(`\t⚠ Exists, updating environments...`));
        
        // Also add flag to views if needed (since it already exists)
        if (viewKeys.length > 0) {
          try {
            const viewPatch = [{
              op: "add",
              path: "/viewKeys",
              value: viewKeys
            }];
            
            const viewPatchResp = await rateLimitRequest(
              ldAPIPatchRequest(
                apiKey,
                domain,
                `flags/${inputArgs.projKeyDest}/${flagKey}`,
                viewPatch
              ),
              'flags'
            );
            
            if (viewPatchResp.status >= 200 && viewPatchResp.status < 300) {
              console.log(Colors.green(`\t  ✓ Added to view(s): ${viewKeys.join(', ')}`));
            }
          } catch (error) {
            // Silently continue if view linking fails
          }
        }
        
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

  // Add flag env settings - use the potentially updated flag key
  if (flagCreated) {
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
      await makePatchCall(createdFlagKey, patchReq, destEnvKey, flagMaintainerId, currentMemberId, flag.variations);
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


/**
 * Convert JSON Patch format to Semantic Patch format for approval requests
 * LaunchDarkly approval requests require semantic patches with "kind" field
 * @param variations - Array of flag variations with _id fields to map indices to UUIDs
 * @returns Object with semantic patches and array of skipped field names
 */
function convertToSemanticPatch(jsonPatches: any[], envKey: string, variations: any[]): { instructions: any[], skippedFields: string[] } {
  const semanticPatches: any[] = [];
  const skippedFields = new Set<string>();
  
  // Helper to convert variation index to UUID
  const getVariationId = (index: number): string | undefined => {
    return variations[index]?._id;
  };
  
  for (const patch of jsonPatches) {
    // Extract the field being modified (after environments/{envKey}/)
    const pathParts = patch.path.split('/');
    const envIndex = pathParts.indexOf('environments');
    if (envIndex === -1) continue;
    
    const field = pathParts[envIndex + 2]; // Skip 'environments' and envKey
    
    // Convert based on field type - only handle fields we know work
    if (field === 'on') {
      // Convert to turnFlagOn or turnFlagOff
      semanticPatches.push({
        kind: patch.value === true ? 'turnFlagOn' : 'turnFlagOff'
      });
    } else if (field === 'offVariation') {
      // Update off variation - convert index to UUID
      const variationId = getVariationId(patch.value);
      if (variationId) {
        semanticPatches.push({
          kind: 'updateOffVariation',
          variationId
        });
      }
    } else if (field === 'fallthrough') {
      // Update fallthrough - can be either a simple variation or a rollout
      const instruction: any = {
        kind: 'updateFallthroughVariationOrRollout'
      };
      
      if (patch.value.variation !== undefined) {
        // Simple variation - convert index to UUID
        const variationId = getVariationId(patch.value.variation);
        if (variationId) {
          instruction.variationId = variationId;
        }
      } else if (patch.value.rollout) {
        // Rollout with bucketBy and variations - need to convert variation indices in rollout
        instruction.rollout = {
          ...patch.value.rollout,
          variations: patch.value.rollout.variations?.map((v: any) => ({
            ...v,
            variation: getVariationId(v.variation) || v.variation
          }))
        };
      }
      
      // Only add if we have either variationId or rollout
      if (instruction.variationId || instruction.rollout) {
        semanticPatches.push(instruction);
      }
    } else if (field === 'rules') {
      // For rules, check if it's an add operation
      if (patch.op === 'add' && patch.path.includes('rules/-')) {
        const ruleInstruction: any = {
          kind: 'addRule',
          clauses: patch.value.clauses || [],
          ...(patch.value.description && { description: patch.value.description })
        };
        
        // Rules can have either a variation or a rollout
        if (patch.value.variation !== undefined) {
          const variationId = getVariationId(patch.value.variation);
          if (variationId) {
            ruleInstruction.variationId = variationId;
          }
        } else if (patch.value.rollout) {
          // Convert variation indices in rollout
          ruleInstruction.rollout = {
            ...patch.value.rollout,
            variations: patch.value.rollout.variations?.map((v: any) => ({
              ...v,
              variation: getVariationId(v.variation) || v.variation
            }))
          };
        }
        
        semanticPatches.push(ruleInstruction);
      }
    } else if (field === 'trackEvents') {
      // Skip trackEvents - not supported in approval requests
      skippedFields.add(field);
    } else {
      // Skip fields we can't convert (targets, contextTargets, prerequisites, etc.)
      // These will need to be set manually after approval
      skippedFields.add(field);
    }
  }
  
  if (skippedFields.size > 0) {
    console.log(Colors.gray(`\t    ⓘ Skipped fields (set manually after approval): ${Array.from(skippedFields).join(', ')}`));
  }
  
  return {
    instructions: semanticPatches,
    skippedFields: Array.from(skippedFields)
  };
}

async function makePatchCall(flagKey: string, patchReq: any[], env: string, maintainerId: string | null, fallbackMemberId: string | null, variations: any[]) {
  const patchFlagReq = await rateLimitRequest(
    ldAPIPatchRequest(
      apiKey,
      domain,
      `flags/${inputArgs.projKeyDest}/${flagKey}`,
      patchReq,
    ),
    'flags'
  );
  const flagPatchStatus = await patchFlagReq.status;
  
  // 405 means environment requires approval workflow
  if (flagPatchStatus === 405) {
    console.log(Colors.cyan(`\t  → ${env}: Requires approval, checking for existing requests...`));
    
    try {
      // First, check if there are existing pending approval requests
      const listApprovalsReq = ldAPIRequest(
        apiKey,
        domain,
        `projects/${inputArgs.projKeyDest}/flags/${flagKey}/environments/${env}/approval-requests`
      );
      const listApprovalsResp = await rateLimitRequest(listApprovalsReq, 'approval-requests');
      
      if (listApprovalsResp.status === 200) {
        const approvalsData = await listApprovalsResp.json();
        // Check if there are any active approval requests (pending, scheduled, or failed/declined)
        // We check these to avoid creating duplicates if a previous migration created one
        const activeApprovals = approvalsData.items?.filter((req: any) => 
          req.status === 'pending' || req.status === 'scheduled' || req.status === 'failed'
        ) || [];
        
        if (activeApprovals.length > 0) {
          const approval = activeApprovals[0];
          console.log(Colors.yellow(`\t  ⚠ ${env}: Existing approval request found (ID: ${approval._id}, status: ${approval.status})`));
          console.log(Colors.gray(`\t    Skipping creation to avoid duplicates`));
          
          // Still track this as needing approval, but note it already exists
          approvalRequestsCreated.push({
            flag: flagKey,
            env: env,
            skippedFields: [] // We don't know what fields the existing request covers
          });
          
          return flagsDoubleCheck;
        }
      }
      
      // No existing request, proceed to create one
      console.log(Colors.gray(`\t    No existing requests, creating new approval request...`));
      
      // Convert JSON Patch format to Semantic Patch format for approval requests
      const conversionResult = convertToSemanticPatch(patchReq, env, variations);
      
      console.log(Colors.gray(`\t    Converting ${patchReq.length} JSON patches → ${conversionResult.instructions.length} semantic instructions`));
      
      if (conversionResult.instructions.length === 0) {
        console.log(Colors.yellow(`\t  ⚠ ${env}: No valid instructions to approve, skipping`));
        return flagsDoubleCheck;
      }
      
      const approvalRequestBody: any = {
        description: `Migration of flag "${flagKey}" environment "${env}" from project "${inputArgs.projKeySource}"`,
        instructions: conversionResult.instructions,
      };
      
      // Determine who to notify about the approval request
      // Priority: 1. Flag maintainer, 2. Current authenticated member, 3. No one (but warn)
      if (maintainerId) {
        approvalRequestBody.notifyMemberIds = [maintainerId];
      } else if (fallbackMemberId) {
        approvalRequestBody.notifyMemberIds = [fallbackMemberId];
        console.log(Colors.gray(`\t    No maintainer mapped, notifying creating member`));
      } else {
        console.log(Colors.yellow(`\t    ⚠ No one to notify (service token used and no maintainer)`));
      }
      
      // Correct endpoint format: /projects/{projectKey}/flags/{flagKey}/environments/{envKey}/approval-requests
      const approvalResp = await rateLimitRequest(
        ldAPIPostRequest(
          apiKey,
          domain,
          `projects/${inputArgs.projKeyDest}/flags/${flagKey}/environments/${env}/approval-requests`,
          approvalRequestBody
        ),
        'approval-requests'
      );
      
      if (approvalResp.status >= 200 && approvalResp.status < 300) {
        console.log(Colors.green(`\t  ✓ ${env}: Approval request created`));
        
        // Track this approval request
        approvalRequestsCreated.push({
          flag: flagKey,
          env: env,
          skippedFields: conversionResult.skippedFields
        });
        
        // Track skipped fields for this flag
        if (conversionResult.skippedFields.length > 0) {
          if (!skippedFieldsByFlag.has(flagKey)) {
            skippedFieldsByFlag.set(flagKey, new Set());
          }
          const flagSkipped = skippedFieldsByFlag.get(flagKey)!;
          conversionResult.skippedFields.forEach(f => flagSkipped.add(f));
        }
      } else {
        const errorBody = await approvalResp.text();
        console.log(Colors.yellow(`\t  ⚠ ${env}: Failed to create approval request (status: ${approvalResp.status})`));
        console.log(Colors.gray(`\t    API response: ${errorBody}`));
        flagsDoubleCheck.push(flagKey);
      }
    } catch (error) {
      console.log(Colors.red(`\t  ✗ ${env}: Error creating approval request`));
      flagsDoubleCheck.push(flagKey);
    }
  } else if (flagPatchStatus >= 400) {
    // Other errors (400, 403, 404, etc.)
    flagsDoubleCheck.push(flagKey);
    console.log(Colors.red(`\t  ✗ ${env}: Error ${flagPatchStatus}`));
    if (flagPatchStatus == 400) {
      const errorBody = await patchFlagReq.text();
      console.log(Colors.red(`\t    ${errorBody}`));
    }
  } else if (flagPatchStatus > 201) {
    console.log(Colors.yellow(`\t  ⚠ ${env}: Status ${flagPatchStatus}`));
  }
  // Success (200-201) - no logging needed for each env

  return flagsDoubleCheck;
}

// Print final summary report
console.log(Colors.blue("\n\n" + "=".repeat(70)));
console.log(Colors.blue("📊 MIGRATION SUMMARY"));
console.log(Colors.blue("=".repeat(70)));

// 1. Approval Requests
if (approvalRequestsCreated.length > 0) {
  console.log(Colors.yellow("\n⏳ APPROVAL REQUESTS CREATED"));
  console.log(Colors.yellow("The following flags require approval before changes take effect:\n"));
  
  // Group by flag
  const approvalsByFlag = new Map<string, string[]>();
  approvalRequestsCreated.forEach(req => {
    if (!approvalsByFlag.has(req.flag)) {
      approvalsByFlag.set(req.flag, []);
    }
    approvalsByFlag.get(req.flag)!.push(req.env);
  });
  
  approvalsByFlag.forEach((envs, flag) => {
    console.log(Colors.cyan(`  📋 ${flag}`));
    console.log(Colors.gray(`     Environments: ${envs.join(', ')}`));
  });
  
  console.log(Colors.yellow(`\n  Total: ${approvalRequestsCreated.length} approval request(s) across ${approvalsByFlag.size} flag(s)`));
  console.log(Colors.gray(`  → Review and approve these in the LaunchDarkly UI`));
}

// 2. Non-migrated settings
if (skippedFieldsByFlag.size > 0) {
  console.log(Colors.yellow("\n⚠️  NON-MIGRATED SETTINGS"));
  console.log(Colors.yellow("The following fields could not be migrated via approval requests:"));
  console.log(Colors.gray("These will need to be set manually after approvals are applied.\n"));
  
  skippedFieldsByFlag.forEach((fields, flag) => {
    console.log(Colors.cyan(`  📋 ${flag}`));
    console.log(Colors.gray(`     Fields: ${Array.from(fields).join(', ')}`));
  });
  
  console.log(Colors.yellow(`\n  Total: ${skippedFieldsByFlag.size} flag(s) with non-migrated settings`));
}

// 3. Errors/Warnings
if (flagsDoubleCheck.length > 0) {
  console.log(Colors.red("\n❌ FLAGS WITH ERRORS"));
  console.log(Colors.red("The following flags encountered errors during migration:\n"));
  
  flagsDoubleCheck.forEach((flag) => {
    console.log(Colors.red(`  ✗ ${flag}`));
  });
  
  console.log(Colors.red(`\n  Total: ${flagsDoubleCheck.length} flag(s) with errors`));
  console.log(Colors.gray(`  → Review these flags manually`));
}

// 4. Conflict resolution report
console.log(conflictTracker.getReport());

// Final summary line
console.log(Colors.blue("\n" + "=".repeat(70)));
if (approvalRequestsCreated.length > 0) {
  console.log(Colors.cyan(`✓ Migration complete with ${approvalRequestsCreated.length} pending approval(s)`));
} else if (flagsDoubleCheck.length > 0) {
  console.log(Colors.yellow(`⚠ Migration complete with ${flagsDoubleCheck.length} error(s)`));
} else {
  console.log(Colors.green("✓ Migration complete successfully"));
}
console.log(Colors.blue("=".repeat(70) + "\n"));
