// deno-lint-ignore-file no-explicit-any
/**
 * LaunchDarkly Migration Workflow Orchestrator
 * 
 * Supports running complete migration workflows from a single YAML config file.
 * Default behavior: Runs full workflow (extract → map → migrate)
 */

import yargs from "https://deno.land/x/yargs@v17.7.2-deno/deno.ts";
import { parse as parseYaml } from "https://deno.land/std@0.224.0/yaml/parse.ts";
import * as Colors from "https://deno.land/std@0.149.0/fmt/colors.ts";
import {
  coerceProjectKey,
  findMergeCollisions,
  findMergedDestinations,
  hasMergeCollisions,
  normalizeWorkflowConfig,
  partitionWorkflowSteps,
  type ProjectPair,
  resolveProjectPairs,
  usesProjectKeyMapping,
  usesProjectKeysList,
  withProjectPair,
  type WorkflowConfig,
  type WorkflowStepName,
} from "../../utils/workflow_config.ts";
import { assertNotSelfMigration } from "../../utils/account_guard.ts";

interface Arguments {
  config?: string;
}

type StepName = WorkflowStepName;
type CommandOptions = { args: string[]; stdout: "inherit"; stderr: "inherit" };

// ==================== Configuration ====================

const DEFAULT_WORKFLOW_STEPS: StepName[] = ["extract-source", "map-members", "migrate"];

const inputArgs: Arguments = yargs(Deno.args)
  .alias("f", "config")
  .option("config", { type: "string", description: "Path to workflow configuration YAML file" })
  .describe("f", "Path to workflow configuration YAML file")
  .parse() as Arguments;

// Allow positional YAML path: deno task workflow examples/workflow-full.yaml
const configPath = inputArgs.config ?? (Deno.args.length > 0 && !Deno.args[0].startsWith("-") && /\.(yaml|yml)$/i.test(Deno.args[0]) ? Deno.args[0] : undefined);
if (!configPath) {
  console.log(Colors.red("Error: No workflow config specified. Use -f <file> or pass the YAML file path."));
  console.log(Colors.gray("  deno task workflow -f examples/workflow-full.yaml"));
  console.log(Colors.gray("  deno task workflow examples/workflow-full.yaml"));
  Deno.exit(1);
}

// ==================== Config Loading ====================

/**
 * Loads and parses a YAML configuration file
 */
const loadConfig = async (configPath: string): Promise<WorkflowConfig> => {
  try {
    const configContent = await Deno.readTextFile(configPath);
    return normalizeWorkflowConfig(parseYaml(configContent) as WorkflowConfig);
  } catch (error) {
    console.log(Colors.red(
      `Error loading config file: ${error instanceof Error ? error.message : String(error)}`
    ));
    Deno.exit(1);
  }
};

// ==================== Command Execution ====================

/**
 * Creates command options for Deno subprocess
 */
const createCommandOptions = (args: string[]): CommandOptions => ({
  args,
  stdout: "inherit",
  stderr: "inherit"
});

/**
 * Executes a Deno command and handles errors
 */
const executeCommand = async (args: string[], stepName: string): Promise<void> => {
  console.log(Colors.gray(`Executing: deno ${args.join(' ')}\n`));

  const command = new Deno.Command("deno", createCommandOptions(args));
  const { code } = await command.output();

  if (code !== 0) {
    console.error(Colors.red(`\n❌ ${stepName} failed`));
    Deno.exit(1);
  }
};

/**
 * Prints step header
 */
const printStepHeader = (stepNumber: string, title: string): void => {
  const divider = "=".repeat(60);
  console.log(Colors.cyan(`\n${divider}`));
  console.log(Colors.cyan(`${stepNumber}: ${title}`));
  console.log(Colors.cyan(`${divider}\n`));
};

/**
 * Prints step completion
 */
const printStepCompletion = (message: string): void => {
  console.log(Colors.green(`\n✓ ${message}\n`));
};

// ==================== Step Builders ====================

/**
 * Builds base Deno run command args
 */
const buildBaseRunArgs = (scriptPath: string, permissions: string[]): string[] => [
  "run",
  ...permissions,
  scriptPath
];

/**
 * Conditionally adds arguments if value exists
 */
const addOptionalArg = (args: string[], flag: string, value?: string): string[] =>
  value ? [...args, flag, value] : args;

/**
 * Conditionally adds a boolean flag if true
 */
const addBooleanFlag = (args: string[], flag: string, condition?: boolean): string[] =>
  condition ? [...args, flag] : args;

// ==================== Extract Source Step ====================

/**
 * Builds arguments for extract source command
 */
const buildExtractSourceArgs = (config: WorkflowConfig): string[] => {
  const baseArgs = buildBaseRunArgs(
    "src/scripts/launchdarkly-migrations/source_from_ld.ts",
    ["--allow-net", "--allow-read", "--allow-write"]
  );

  let args = [...baseArgs, "-p", coerceProjectKey(config.source.projectKey)!];
  args = addOptionalArg(args, "--domain", config.source.domain);
  
  // Only extract segments if explicitly enabled AND migration will use them
  const shouldExtractSegments = 
    config.extraction?.includeSegments === true || 
    config.migration?.migrateSegments === true;
  
  if (shouldExtractSegments) {
    args = [...args, "--extract-segments=true"];
  }
  if (config.extraction?.includeArchived) {
    args = [...args, "--include-archived=true"];
  }
  if (config.migration?.migrateBigSegments === true) {
    args = [...args, "--extract-segments=true", "--extract-big-segments=true"];
  }
  if (config.migration?.migrateViews === false) {
    args = [...args, "--extract-views=false"];
  }
  
  return args;
};

/**
 * Runs the extract source data step
 */
const runExtractSource = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP 1", "Extract Source Project Data");
  if (!coerceProjectKey(config.source.projectKey)) {
    console.log(Colors.red("Error: Source project key is required for extract-source step (source.projectKey or source.projectKeys)"));
    Deno.exit(1);
  }
  const args = buildExtractSourceArgs(config);
  await executeCommand(args, "Extract source step");
  printStepCompletion("Source data extraction completed");
};

// ==================== Split Extract Step ====================

/**
 * Validates Split extract configuration
 */
const validateSplitExtractConfig = (config: WorkflowConfig): void => {
  if (!config.splitExtract?.workspace) {
    console.log(Colors.red("Error: splitExtract.workspace is required for the split-extract step"));
    Deno.exit(1);
  }
};

/**
 * Builds arguments for the Split extract command
 */
const buildSplitExtractArgs = (config: WorkflowConfig): string[] => {
  const split = config.splitExtract!;
  const projectKey = coerceProjectKey(config.source.projectKey);
  if (!projectKey) {
    console.log(Colors.red("Error: Source project key is required for the split-extract step"));
    Deno.exit(1);
  }
  const baseArgs = buildBaseRunArgs(
    "src/scripts/third-party-migrations/source_from_split.ts",
    ["--allow-net", "--allow-read", "--allow-write", "--allow-env"]
  );

  let args = [...baseArgs, "-w", split.workspace, "-p", projectKey];
  args = addOptionalArg(args, "-t", split.tag);
  args = addOptionalArg(args, "-e", split.environments?.join(","));
  args = addOptionalArg(args, "--split-base-url", split.baseUrl);
  args = addOptionalArg(args, "--ld-tag", split.ldTag);

  if (split.environmentMapping) {
    args = addOptionalArg(args, "--env-map", formatEnvMapping(split.environmentMapping));
  }

  return args;
};

/**
 * Runs the Split workspace extract step
 */
const runSplitExtract = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP", "Extract Split Workspace");
  validateSplitExtractConfig(config);
  const args = buildSplitExtractArgs(config);
  await executeCommand(args, "Split extract step");
  printStepCompletion("Split extraction completed");
};

// ==================== Map Members Step ====================

/**
 * Builds arguments for map members command
 */
const buildMapMembersArgs = (config: WorkflowConfig): string[] => {
  const baseArgs = buildBaseRunArgs(
    "src/scripts/launchdarkly-migrations/map_members_between_ld_instances.ts",
    ["--allow-net", "--allow-read", "--allow-write"]
  );

  const withOutput = addOptionalArg(baseArgs, "-o", config.memberMapping?.outputFile);
  const withSourceDomain = addOptionalArg(withOutput, "--source-domain", config.source.domain);
  return addOptionalArg(withSourceDomain, "--dest-domain", config.destination?.domain);
};

/**
 * Runs the member mapping step
 */
const runMapMembers = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP 2", "Map Members Between Instances");
  const args = buildMapMembersArgs(config);
  await executeCommand(args, "Member mapping step");
  printStepCompletion("Member mapping completed");
};

// ==================== Migrate Step ====================

/**
 * Validates migration prerequisites
 */
const validateMigrationConfig = (config: WorkflowConfig): void => {
  if (!coerceProjectKey(config.source.projectKey)) {
    console.log(Colors.red("Error: Source project key is required for migration step"));
    Deno.exit(1);
  }
  if (!coerceProjectKey(config.destination?.projectKey)) {
    console.log(Colors.red("Error: Destination project key is required for migration step"));
    Deno.exit(1);
  }
};

/**
 * Formats environment mapping as command argument
 */
const formatEnvMapping = (mapping: Record<string, string>): string =>
  Object.entries(mapping)
    .map(([k, v]) => `${k}:${v}`)
    .join(",");

/**
 * Builds migration-specific arguments
 */
const buildMigrationArgs = (config: WorkflowConfig): string[] => {
  const migration = config.migration || {};
  let args: string[] = [];

  args = addBooleanFlag(args, "-m", migration.assignMaintainerIds);
  args = addBooleanFlag(args, "-s=false", migration.migrateSegments === false);
  args = addBooleanFlag(args, "--migrate-big-segments", migration.migrateBigSegments);
  args = addBooleanFlag(args, "--migrate-views=false", migration.migrateViews === false);
  args = addBooleanFlag(args, "--dry-run", migration.dryRun);
  args = addBooleanFlag(args, "--incremental", migration.incremental);
  args = addBooleanFlag(args, "--create-project", migration.createProject);
  args = addBooleanFlag(args, "--create-environments", migration.createEnvironments);
  args = addOptionalArg(args, "--tags", migration.tags?.length ? migration.tags.join(",") : undefined);
  args = addOptionalArg(args, "-c", migration.conflictPrefix);
  args = addOptionalArg(args, "--on-conflict", migration.onConflict);
  args = addOptionalArg(args, "-v", migration.targetView);
  args = addOptionalArg(args, "-e", migration.environments?.join(","));
  args = addOptionalArg(args, "--since", migration.since);
  args = addOptionalArg(args, "--include-flags", migration.includeFlags?.length ? migration.includeFlags.join(",") : undefined);
  args = addOptionalArg(args, "--exclude-flags", migration.excludeFlags?.length ? migration.excludeFlags.join(",") : undefined);
  args = addOptionalArg(args, "--concurrency", migration.concurrency != null ? String(migration.concurrency) : undefined);

  if (migration.environmentMapping) {
    args = addOptionalArg(args, "--env-map", formatEnvMapping(migration.environmentMapping));
  }

  return args;
};

/**
 * Builds complete migration command arguments
 */
const buildMigrateArgs = (config: WorkflowConfig): string[] => {
  const baseArgs = buildBaseRunArgs(
    "src/scripts/launchdarkly-migrations/migrate_between_ld_instances.ts",
    ["--allow-net", "--allow-read", "--allow-write"]
  );

  const withProjects = [
    ...baseArgs,
    "-p", coerceProjectKey(config.source.projectKey)!,
    "-d", coerceProjectKey(config.destination!.projectKey)!
  ];

  const withMigrationOpts = [...withProjects, ...buildMigrationArgs(config)];
  const withName = addOptionalArg(
    withMigrationOpts,
    "--dest-project-name",
    coerceProjectKey(config.destination?.projectName),
  );
  return addOptionalArg(withName, "--domain", config.destination?.domain);
};

/**
 * Runs the migration step
 */
const runMigrate = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP 3", "Migrate Project");
  validateMigrationConfig(config);
  const args = buildMigrateArgs(config);
  await executeCommand(args, "Migration step");
  printStepCompletion("Migration completed");
};

// ==================== Third-Party Import Step ====================

/**
 * Validates third-party import configuration
 */
const validateThirdPartyConfig = (config: WorkflowConfig): void => {
  if (!config.thirdPartyImport) {
    console.log(Colors.red("Error: thirdPartyImport configuration is required"));
    Deno.exit(1);
  }
};

/**
 * Builds arguments for third-party import command
 */
const buildThirdPartyImportArgs = (config: WorkflowConfig): string[] => {
  const importConfig = config.thirdPartyImport!;
  
  const baseArgs = buildBaseRunArgs(
    "src/scripts/third-party-migrations/import_flags_from_external.ts",
    ["--allow-net", "--allow-read", "--allow-write", "--allow-env"]
  );

  const withRequiredArgs = [
    ...baseArgs,
    "-f", importConfig.inputFile,
    "-p", importConfig.targetProject
  ];

  const withDryRun = addBooleanFlag(withRequiredArgs, "-d", importConfig.dryRun);
  const withUpsert = addBooleanFlag(withDryRun, "-u", importConfig.upsert);
  const withOutput = addOptionalArg(withUpsert, "-o", importConfig.reportOutput);
  return addOptionalArg(withOutput, "--domain", config.destination?.domain);
};

/**
 * Runs the third-party import step
 */
const runThirdPartyImport = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP", "Third-Party Flag Import");
  validateThirdPartyConfig(config);
  const args = buildThirdPartyImportArgs(config);
  await executeCommand(args, "Third-party import");
  printStepCompletion("Third-party import completed");
};

// ==================== Revert Step ====================

/**
 * Validates revert configuration
 */
const validateRevertConfig = (config: WorkflowConfig): void => {
  if (!coerceProjectKey(config.destination?.projectKey)) {
    console.log(Colors.red("Error: Destination project key is required for revert step"));
    Deno.exit(1);
  }
};

/**
 * Builds arguments for revert command
 */
const buildRevertArgs = (config: WorkflowConfig): string[] => {
  const revertConfig = config.revert || {};
  
  const baseArgs = buildBaseRunArgs(
    "src/scripts/launchdarkly-migrations/revert_migration.ts",
    ["--allow-net", "--allow-read", "--allow-write"]
  );

  // Use the config file itself as the -f parameter (revert reads from it).
  // Pin the current project so revert doesn't loop over source.projectKeys itself.
  const withConfigFile = [...baseArgs, "-f", configPath];
  let args = addOptionalArg(withConfigFile, "-p", coerceProjectKey(config.destination?.projectKey));
  args = addOptionalArg(args, "-s", coerceProjectKey(config.source.projectKey));

  // Add optional flags
  args = addBooleanFlag(args, "--dry-run", revertConfig.dryRun);
  args = addBooleanFlag(args, "--delete-views", revertConfig.deleteViews);
  
  // Add view keys if specified
  if (revertConfig.viewKeys && revertConfig.viewKeys.length > 0) {
    args = addOptionalArg(args, "-v", revertConfig.viewKeys.join(","));
  }
  
  return args;
};

/**
 * Runs the revert step
 */
const runRevert = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP", "Revert Migration");
  validateRevertConfig(config);
  const args = buildRevertArgs(config);
  await executeCommand(args, "Revert step");
  printStepCompletion("Revert completed");
};

// ==================== Step Execution ====================

type StepExecutor = (config: WorkflowConfig) => Promise<void>;

/**
 * Maps step names to their executor functions
 */
const STEP_EXECUTORS: Record<StepName, StepExecutor> = {
  'extract-source': runExtractSource,
  'split-extract': runSplitExtract,
  'map-members': runMapMembers,
  'migrate': runMigrate,
  'third-party-import': runThirdPartyImport,
  'revert': runRevert
};

/**
 * Executes a single workflow step
 */
const executeStep = async (step: string, config: WorkflowConfig): Promise<void> => {
  const executor = STEP_EXECUTORS[step as StepName];
  
  if (executor) {
    await executor(config);
  } else {
    console.log(Colors.yellow(`Warning: Unknown step "${step}", skipping...`));
  }
};

const printProjectBanner = (index: number, total: number, pair: ProjectPair): void => {
  const divider = "=".repeat(60);
  const label = pair.source === pair.destination
    ? pair.source
    : `${pair.source} -> ${pair.destination}`;
  console.log(Colors.magenta(`\n${divider}`));
  console.log(Colors.magenta(`Project ${index + 1}/${total}: ${label}`));
  console.log(Colors.magenta(`${divider}\n`));
};

/**
 * Resolves source/destination pairs for project-scoped steps, exiting on a missing key
 * or an invalid destination.projectKeyMapping.
 */
const resolveProjectPairsOrExit = (config: WorkflowConfig): ProjectPair[] => {
  try {
    return resolveProjectPairs(config);
  } catch (error) {
    console.log(Colors.red(error instanceof Error ? error.message : String(error)));
    Deno.exit(1);
  }
};

/**
 * Exits before migrating when source and destination tokens are in the same account
 * and a project would migrate onto its own key.
 */
const runAccountGuard = async (steps: string[], config: WorkflowConfig): Promise<void> => {
  if (!steps.includes("migrate")) {
    return;
  }
  let pairs: ProjectPair[];
  try {
    pairs = resolveProjectPairs(config);
  } catch {
    // Missing keys are reported by the steps themselves
    return;
  }
  try {
    await assertNotSelfMigration(pairs, config.source.domain, config.destination?.domain);
  } catch (error) {
    console.log(Colors.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    Deno.exit(1);
  }
};

/**
 * Exits when this pair's source shares flag or segment keys with earlier sources
 * merged into the same destination, unless migration.conflictPrefix is set.
 */
const runMergePreflight = async (
  pair: ProjectPair,
  earlierSources: string[],
  config: WorkflowConfig,
): Promise<void> => {
  if (earlierSources.length === 0) {
    return;
  }
  let collisions;
  try {
    collisions = await findMergeCollisions(pair.source, earlierSources);
  } catch (error) {
    console.log(Colors.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    Deno.exit(1);
  }
  if (!hasMergeCollisions(collisions)) {
    console.log(Colors.gray(
      `Merge check: no flag or segment keys shared with ${earlierSources.join(", ")} in ${pair.destination}`,
    ));
    return;
  }

  const lines = [
    ...(collisions.flags.length > 0 ? [`  flags: ${collisions.flags.join(", ")}`] : []),
    ...Object.entries(collisions.segments).map(([env, keys]) => `  segments (${env}): ${keys.join(", ")}`),
  ];
  const prefix = coerceProjectKey(config.migration?.conflictPrefix);
  if (prefix) {
    console.log(Colors.yellow(
      `Warning: ${pair.source} shares keys with ${earlierSources.join(", ")} in ${pair.destination}; ` +
        `these will be created with prefix "${prefix}":`,
    ));
    lines.forEach((line) => console.log(Colors.yellow(line)));
    return;
  }
  console.log(Colors.red(
    `Error: ${pair.source} shares keys with ${earlierSources.join(", ")}, which also migrate into ${pair.destination}. ` +
      `Without migration.conflictPrefix, ${pair.source} would overwrite their targeting:`,
  ));
  lines.forEach((line) => console.log(Colors.red(line)));
  Deno.exit(1);
};

/**
 * Executes all workflow steps.
 * Single project: steps run in listed order against the config as written.
 * source.projectKeys: account-level steps run once, then project steps run per
 * source/destination pair (destination.projectKeyMapping, else the same key).
 */
const executeWorkflowSteps = async (steps: string[], config: WorkflowConfig): Promise<void> => {
  if (!usesProjectKeysList(config) && usesProjectKeyMapping(config)) {
    console.log(Colors.yellow(
      `Warning: destination.projectKeyMapping is ignored without source.projectKeys; use destination.projectKey for a single project`,
    ));
  }

  await runAccountGuard(steps, config);

  if (!usesProjectKeysList(config)) {
    for (const step of steps) {
      await executeStep(step, config);
    }
    return;
  }

  const { accountSteps, projectSteps, unknownSteps } = partitionWorkflowSteps(steps);

  for (const step of unknownSteps) {
    console.log(Colors.yellow(`Warning: Unknown step "${step}", skipping...`));
  }

  if (coerceProjectKey(config.destination?.projectName)) {
    console.log(Colors.yellow(
      `Warning: destination.projectName is ignored with source.projectKeys; use destination.projectNames ` +
        `(destination key -> name), otherwise created projects use each source project's name`,
    ));
  }

  const pairs = resolveProjectPairsOrExit(config);

  for (const step of accountSteps) {
    await executeStep(step, config);
  }

  if (projectSteps.length === 0) {
    return;
  }

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    printProjectBanner(i, pairs.length, pair);
    const projectConfig = withProjectPair(config, pair);
    const earlierSources = pairs.slice(0, i)
      .filter((p) => p.destination === pair.destination)
      .map((p) => p.source);
    for (const step of projectSteps) {
      if (step === "migrate") {
        await runMergePreflight(pair, earlierSources, config);
      }
      await executeStep(step, projectConfig);
    }
  }
};

// ==================== Workflow Summary ====================

/**
 * Prints workflow header with configuration summary
 */
const printWorkflowHeader = (config: WorkflowConfig, steps: string[]): void => {
  const divider = "=".repeat(60);

  console.log(Colors.blue(`\n🚀 LaunchDarkly Migration Workflow`));
  console.log(Colors.blue(`${divider}\n`));
  console.log(Colors.cyan(`Configuration loaded: ${configPath}`));

  if (usesProjectKeysList(config)) {
    const pairs = resolveProjectPairsOrExit(config);
    console.log(Colors.cyan(`Projects: ${pairs.length} (${pairs.map((p) => p.source).join(", ")})`));
    if (pairs.every((p) => p.source === p.destination)) {
      console.log(Colors.gray(`  Same project key used on destination for each project`));
    } else {
      for (const { source, destination } of pairs) {
        console.log(Colors.gray(`  ${source} -> ${destination}`));
      }
    }
    for (const [destination, sources] of findMergedDestinations(pairs)) {
      console.log(Colors.cyan(`  Merged destination: ${destination} <- ${sources.join(", ")}`));
    }

    const { accountSteps, projectSteps } = partitionWorkflowSteps(steps);
    if (accountSteps.length > 0) {
      console.log(Colors.cyan(`Account steps (once): ${accountSteps.join(" → ")}`));
    }
    if (projectSteps.length > 0) {
      console.log(Colors.cyan(`Project steps (per project): ${projectSteps.join(" → ")}`));
    }
  } else {
    const sourceKey = coerceProjectKey(config.source.projectKey);
    const destKey = coerceProjectKey(config.destination?.projectKey);
    if (sourceKey) {
      console.log(Colors.cyan(`Source Project: ${sourceKey}`));
    } else {
      console.log(Colors.yellow(`Source Project: not set (use source.projectKey or source.projectKeys)`));
    }
    if (destKey) {
      console.log(Colors.cyan(`Destination Project: ${destKey}`));
    }
    console.log(Colors.cyan(`Steps to execute: ${steps.join(" → ")}`));
  }
  console.log("");
};

/**
 * Prints workflow completion message
 */
const printWorkflowCompletion = (): void => {
  const divider = "=".repeat(60);
  console.log(Colors.green(`\n${divider}`));
  console.log(Colors.green("✓ Workflow completed successfully!"));
  console.log(Colors.green(`${divider}\n`));
};

/**
 * Gets workflow steps from config or uses defaults
 */
const getWorkflowSteps = (config: WorkflowConfig): string[] =>
  config.workflow?.steps || DEFAULT_WORKFLOW_STEPS;

// ==================== Main Entry Point ====================

/**
 * Main workflow orchestration function
 */
const main = async (): Promise<void> => {
  const config = await loadConfig(configPath);
  const steps = getWorkflowSteps(config);
  
  printWorkflowHeader(config, steps);
  await executeWorkflowSteps(steps, config);
  printWorkflowCompletion();
};

if (import.meta.main) {
  main();
}
