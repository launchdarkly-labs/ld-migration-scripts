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

const inputArgs: Arguments = yargs(Deno.args)
  .alias("f", "config")
  .demandOption(["config"])
  .describe("f", "Path to workflow configuration YAML file")
  .parse() as Arguments;

async function loadConfig(configPath: string): Promise<WorkflowConfig> {
  try {
    const configContent = await Deno.readTextFile(configPath);
    return parseYaml(configContent) as WorkflowConfig;
  } catch (error) {
    console.log(Colors.red(`Error loading config file: ${error instanceof Error ? error.message : String(error)}`));
    Deno.exit(1);
  }
}

async function runExtractSource(config: WorkflowConfig) {
  console.log(Colors.cyan("\n" + "=".repeat(60)));
  console.log(Colors.cyan("STEP 1: Extract Source Project Data"));
  console.log(Colors.cyan("=".repeat(60) + "\n"));

  const args = [
    "run",
    "--allow-net",
    "--allow-read",
    "--allow-write",
    "src/scripts/launchdarkly-migrations/source_from_ld.ts",
    "-p",
    config.source.projectKey
  ];

  if (config.source.domain) {
    args.push("--domain", config.source.domain);
  }

  const command = new Deno.Command("deno", { args });
  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    console.error(Colors.red("Extract source step failed"));
    console.error(new TextDecoder().decode(stderr));
    Deno.exit(1);
  }

  console.log(new TextDecoder().decode(stdout));
  console.log(Colors.green("✓ Source data extraction completed\n"));
}

async function runMapMembers(config: WorkflowConfig) {
  console.log(Colors.cyan("\n" + "=".repeat(60)));
  console.log(Colors.cyan("STEP 2: Map Members Between Instances"));
  console.log(Colors.cyan("=".repeat(60) + "\n"));

  const args = [
    "run",
    "--allow-net",
    "--allow-read",
    "--allow-write",
    "src/scripts/launchdarkly-migrations/map_members_between_ld_instances.ts"
  ];

  if (config.memberMapping?.outputFile) {
    args.push("-o", config.memberMapping.outputFile);
  }

  if (config.source.domain) {
    args.push("--source-domain", config.source.domain);
  }

  if (config.destination?.domain) {
    args.push("--dest-domain", config.destination.domain);
  }

  const command = new Deno.Command("deno", { args });
  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    console.error(Colors.red("Member mapping step failed"));
    console.error(new TextDecoder().decode(stderr));
    Deno.exit(1);
  }

  console.log(new TextDecoder().decode(stdout));
  console.log(Colors.green("✓ Member mapping completed\n"));
}

async function runMigrate(config: WorkflowConfig) {
  console.log(Colors.cyan("\n" + "=".repeat(60)));
  console.log(Colors.cyan("STEP 3: Migrate Project"));
  console.log(Colors.cyan("=".repeat(60) + "\n"));

  if (!config.destination?.projectKey) {
    console.log(Colors.red("Error: Destination project key is required for migration step"));
    Deno.exit(1);
  }

  const args = [
    "run",
    "--allow-net",
    "--allow-read",
    "--allow-write",
    "src/scripts/launchdarkly-migrations/migrate_between_ld_instances.ts",
    "-p",
    config.source.projectKey,
    "-d",
    config.destination.projectKey
  ];

  const migration = config.migration || {};

  if (migration.assignMaintainerIds) {
    args.push("-m");
  }

  if (migration.migrateSegments === false) {
    args.push("-s=false");
  }

  if (migration.conflictPrefix) {
    args.push("-c", migration.conflictPrefix);
  }

  if (migration.targetView) {
    args.push("-v", migration.targetView);
  }

  if (migration.environments) {
    args.push("-e", migration.environments.join(","));
  }

  if (migration.environmentMapping) {
    const envMap = Object.entries(migration.environmentMapping)
      .map(([k, v]) => `${k}:${v}`)
      .join(",");
    args.push("--env-map", envMap);
  }

  if (config.destination.domain) {
    args.push("--domain", config.destination.domain);
  }

  const command = new Deno.Command("deno", { args });
  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    console.error(Colors.red("Migration step failed"));
    console.error(new TextDecoder().decode(stderr));
    Deno.exit(1);
  }

  console.log(new TextDecoder().decode(stdout));
  console.log(Colors.green("✓ Migration completed\n"));
}

async function runThirdPartyImport(config: WorkflowConfig) {
  console.log(Colors.cyan("\n" + "=".repeat(60)));
  console.log(Colors.cyan("Third-Party Flag Import"));
  console.log(Colors.cyan("=".repeat(60) + "\n"));

  if (!config.thirdPartyImport) {
    console.log(Colors.red("Error: thirdPartyImport configuration is required"));
    Deno.exit(1);
  }

  const importConfig = config.thirdPartyImport;
  const args = [
    "run",
    "--allow-net",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "src/scripts/third-party-migrations/import_flags_from_external.ts",
    "-f",
    importConfig.inputFile,
    "-p",
    importConfig.targetProject
  ];

  if (importConfig.dryRun) {
    args.push("-d");
  }

  if (importConfig.reportOutput) {
    args.push("-o", importConfig.reportOutput);
  }

  if (config.destination?.domain) {
    args.push("--domain", config.destination.domain);
  }

  const command = new Deno.Command("deno", { args });
  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    console.error(Colors.red("Third-party import failed"));
    console.error(new TextDecoder().decode(stderr));
    Deno.exit(1);
  }

  console.log(new TextDecoder().decode(stdout));
  console.log(Colors.green("✓ Third-party import completed\n"));
}

async function main() {
  console.log(Colors.blue("\n🚀 LaunchDarkly Migration Workflow"));
  console.log(Colors.blue("=" .repeat(60) + "\n"));

  const config = await loadConfig(inputArgs.config);

  // Default to full workflow if no steps specified
  const steps = config.workflow?.steps || ["extract-source", "map-members", "migrate"];

  console.log(Colors.cyan(`Configuration loaded: ${inputArgs.config}`));
  console.log(Colors.cyan(`Source Project: ${config.source.projectKey}`));
  if (config.destination?.projectKey) {
    console.log(Colors.cyan(`Destination Project: ${config.destination.projectKey}`));
  }
  console.log(Colors.cyan(`Steps to execute: ${steps.join(" → ")}\n`));

  // Execute steps in order
  for (const step of steps) {
    switch (step) {
      case "extract-source":
        await runExtractSource(config);
        break;
      
      case "map-members":
        await runMapMembers(config);
        break;
      
      case "migrate":
        await runMigrate(config);
        break;
      
      case "third-party-import":
        await runThirdPartyImport(config);
        break;
      
      default:
        console.log(Colors.yellow(`Warning: Unknown step "${step}", skipping...`));
    }
  }

  console.log(Colors.green("\n" + "=".repeat(60)));
  console.log(Colors.green("✓ Workflow completed successfully!"));
  console.log(Colors.green("=".repeat(60) + "\n"));
}

if (import.meta.main) {
  main();
}

