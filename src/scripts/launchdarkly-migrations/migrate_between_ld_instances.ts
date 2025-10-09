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
          consoleLogger(
            segmentStatus,
            `Creating segment ${newSegment.key} status: ${segmentStatus}`,
          );
        } else if (segmentStatus === 409 && inputArgs.conflictPrefix && attemptCount === 1) {
          // Conflict detected, retry with prefix
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
          consoleLogger(
            segmentStatus,
            `Creating segment ${newSegment.key} status: ${segmentStatus}`,
          );
          if (segmentStatus > 201) {
            console.log(JSON.stringify(newSegment));
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
    console.log(Colors.yellow(`\tWarning: Flag ${flagkey} has no variations, skipping...`));
    continue;
  }

  const newVariations = flag.variations.map(({ _id, ...rest }: Variation) => rest);

  let flagKey = flag.key;
  let flagName = flag.name;
  let attemptCount = 0;
  let flagCreated = false;
  let createdFlagKey = flag.key;

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
      if (flag.maintainerId) {
        const euMaintainerId = maintainerMapping[flag.maintainerId];
        if (euMaintainerId) {
          newFlag.maintainerId = euMaintainerId;
          console.log(`\tMapped maintainer: ${flag.maintainerId} -> ${euMaintainerId} for flag: ${flag.key}`);
        } else {
          newFlag.maintainerId = null;
          console.log(`\tNo EU maintainer mapping found for US maintainer: ${flag.maintainerId} for flag: ${flag.key}`);
        }
      } else {
        newFlag.maintainerId = null;
        console.log(`\tNo maintainer ID found in source flag: ${flag.key}`);
      }
    } else {
      // Ensure maintainerId is null if not requested
      newFlag.maintainerId = null;
      console.log(`\tMaintainer mapping not requested for flag: ${flag.key}`);
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

    // Add view associations
    const viewKeys: string[] = [];
    
    // Add source flag's view associations
    if (flag.viewKeys && Array.isArray(flag.viewKeys)) {
      viewKeys.push(...flag.viewKeys);
    }
    
    // Add target view if specified (and not already present)
    if (inputArgs.targetView && !viewKeys.includes(inputArgs.targetView)) {
      viewKeys.push(inputArgs.targetView);
    }
    
    // Only add viewKeys field if there are views to link
    if (viewKeys.length > 0) {
      newFlag.viewKeys = viewKeys;
      console.log(`\tLinking flag to view(s): ${viewKeys.join(', ')}`);
    }

    console.log(
      `\tCreating flag: ${flagKey} in Project: ${inputArgs.projKeyDest}`,
    );

    // Create the flag with maintainer ID
    const flagResp = await rateLimitRequest(
      ldAPIPostRequest(
        apiKey,
        domain,
        `flags/${inputArgs.projKeyDest}`,
        newFlag,
      ),
      'flags'
    );

    if (flagResp.status == 200 || flagResp.status == 201) {
      flagCreated = true;
      createdFlagKey = flagKey;
      console.log("\tFlag created");
      // If maintainer ID was set, verify it was applied correctly
      if (newFlag.maintainerId) {
        const createdFlag = await flagResp.json();
        if (createdFlag.maintainerId !== newFlag.maintainerId) {
          console.log(Colors.yellow(`\tWarning: Maintainer ID mismatch for flag ${flag.key}`));
          console.log(Colors.yellow(`\tExpected: ${newFlag.maintainerId}, Got: ${createdFlag.maintainerId}`));
        }
      }
    } else if (flagResp.status === 409 && inputArgs.conflictPrefix && attemptCount === 1) {
      // Conflict detected, retry with prefix
      console.log(Colors.yellow(`\t⚠ Flag "${flagKey}" already exists, retrying with prefix...`));
      flagKey = applyConflictPrefix(flag.key, inputArgs.conflictPrefix);
      flagName = `${inputArgs.conflictPrefix}${flag.name}`;
      
      conflictTracker.addResolution({
        originalKey: flag.key,
        resolvedKey: flagKey,
        resourceType: 'flag',
        conflictPrefix: inputArgs.conflictPrefix
      });
    } else {
      console.log(`Error for flag ${newFlag.key}: ${flagResp.status}`);
      const errorText = await flagResp.text();
      console.log(`Error details: ${errorText}`);
      console.log(`Request payload: ${JSON.stringify(newFlag, null, 2)}`);
      break; // Exit loop on non-conflict errors
    }
  }

  // Add flag env settings - use the potentially updated flag key
  if (flagCreated) {
    console.log(Colors.cyan(`\t📝 Patching flag ${createdFlagKey} for ${envkeys.length} environment(s)...`));
    for (const env of envkeys) {
      if (!flag.environments || !flag.environments[env]) {
        console.log(Colors.yellow(`\t⚠ Warning: No environment data found for ${env} in flag ${flag.key}, skipping...`));
        continue;
      }

      // Determine destination environment key (mapped or original)
      const destEnvKey = inputArgs.envMap && envMapping[env] ? envMapping[env] : env;
      console.log(Colors.gray(`\t  Source env: ${env} → Destination env: ${destEnvKey}`));

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
      await makePatchCall(createdFlagKey, patchReq, destEnvKey);

      console.log(`\tFinished patching flag ${createdFlagKey} for env ${destEnvKey}`);
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


async function makePatchCall(flagKey: string, patchReq: any[], env: string) {
  console.log(Colors.cyan(`\t→ Patching flag ${flagKey} for environment ${env}...`));
  console.log(Colors.gray(`\t  Patch operations: ${patchReq.length} items`));
  
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
  
  // Only treat 400+ as errors (200, 201 are success)
  if (flagPatchStatus >= 400) {
    flagsDoubleCheck.push(flagKey);
    console.log(Colors.red(`\t✗ ERROR patching ${flagKey} for env ${env}, Status: ${flagPatchStatus}`));
    
    if (flagPatchStatus == 400) {
      const errorBody = await patchFlagReq.text();
      console.log(Colors.red(`\t  Error details: ${errorBody}`));
    }
  } else if (flagPatchStatus > 201) {
    // 202-399 range: log as warning but don't fail
    console.log(Colors.yellow(`\t⚠ Patching ${flagKey} for env ${env}, Status: ${flagPatchStatus}`));
  } else {
    // 200-201: Success
    console.log(Colors.green(`\t✓ Successfully patched ${flagKey} for env ${env}, Status: ${flagPatchStatus}`));
  }

  return flagsDoubleCheck;
}

if (flagsDoubleCheck.length > 0) {
  console.log("There are a few flags to double check as they have had an error or warning on the patch")
  flagsDoubleCheck.forEach((flag) => {
    console.log(` - ${flag}`)
  });
}

// Print conflict resolution report
console.log(conflictTracker.getReport());
