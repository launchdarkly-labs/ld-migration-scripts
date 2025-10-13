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

// ==================== Type Definitions ====================

interface WorkflowConfig {
  workflow?: {
    steps?: string[];
  };
  source: {
    projectKey: string;
    domain?: string;
  };
  destination?: {
    projectKey: string;
    domain?: string;
  };
  memberMapping?: {
    outputFile?: string;
  };
  migration?: {
    assignMaintainerIds?: boolean;
    migrateSegments?: boolean;
    conflictPrefix?: string;
    targetView?: string;
    environments?: string[];
    environmentMapping?: Record<string, string>;
  };
  thirdPartyImport?: {
    inputFile: string;
    targetProject: string;
    dryRun?: boolean;
    reportOutput?: string;
  };
}

interface Arguments {
  config: string;
}

type StepName = 'extract-source' | 'map-members' | 'migrate' | 'third-party-import';
type CommandOptions = { args: string[]; stdout: "inherit"; stderr: "inherit" };

// ==================== Configuration ====================

const DEFAULT_WORKFLOW_STEPS: StepName[] = ["extract-source", "map-members", "migrate"];

const inputArgs: Arguments = yargs(Deno.args)
  .alias("f", "config")
  .demandOption(["config"])
  .describe("f", "Path to workflow configuration YAML file")
  .parse() as Arguments;

// ==================== Config Loading ====================

/**
 * Loads and parses a YAML configuration file
 */
const loadConfig = async (configPath: string): Promise<WorkflowConfig> => {
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

  return addOptionalArg(
    [...baseArgs, "-p", config.source.projectKey],
    "--domain",
    config.source.domain
  );
};

/**
 * Runs the extract source data step
 */
const runExtractSource = async (config: WorkflowConfig): Promise<void> => {
  printStepHeader("STEP 1", "Extract Source Project Data");
  const args = buildExtractSourceArgs(config);
  await executeCommand(args, "Extract source step");
  printStepCompletion("Source data extraction completed");
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
  if (!config.destination?.projectKey) {
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
  args = addOptionalArg(args, "-c", migration.conflictPrefix);
  args = addOptionalArg(args, "-v", migration.targetView);
  args = addOptionalArg(args, "-e", migration.environments?.join(","));
  
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
    "-p", config.source.projectKey,
    "-d", config.destination!.projectKey
  ];

  const withMigrationOpts = [...withProjects, ...buildMigrationArgs(config)];
  return addOptionalArg(withMigrationOpts, "--domain", config.destination?.domain);
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
  const withOutput = addOptionalArg(withDryRun, "-o", importConfig.reportOutput);
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

// ==================== Step Execution ====================

type StepExecutor = (config: WorkflowConfig) => Promise<void>;

/**
 * Maps step names to their executor functions
 */
const STEP_EXECUTORS: Record<StepName, StepExecutor> = {
  'extract-source': runExtractSource,
  'map-members': runMapMembers,
  'migrate': runMigrate,
  'third-party-import': runThirdPartyImport
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

/**
 * Executes all workflow steps in sequence
 */
const executeWorkflowSteps = async (steps: string[], config: WorkflowConfig): Promise<void> => {
  for (const step of steps) {
    await executeStep(step, config);
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
  console.log(Colors.cyan(`Configuration loaded: ${inputArgs.config}`));
  console.log(Colors.cyan(`Source Project: ${config.source.projectKey}`));
  
  if (config.destination?.projectKey) {
    console.log(Colors.cyan(`Destination Project: ${config.destination.projectKey}`));
  }
  
  console.log(Colors.cyan(`Steps to execute: ${steps.join(" → ")}\n`));
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
  const config = await loadConfig(inputArgs.config);
  const steps = getWorkflowSteps(config);
  
  printWorkflowHeader(config, steps);
  await executeWorkflowSteps(steps, config);
  printWorkflowCompletion();
};

if (import.meta.main) {
  main();
}
