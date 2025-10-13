import yargs from "https://deno.land/x/yargs@v17.7.2-deno/deno.ts";
import * as Colors from "https://deno.land/std@0.149.0/fmt/colors.ts";
import { getDestinationApiKey } from "../../utils/api_keys.ts";
import {
  parseFlagImportFile,
  validateFlagData,
  convertToLaunchDarklyFlag,
  createFlagViaAPI,
  generateImportReport,
  delay
} from "../../utils/utils.ts";
import type { ImportFlag, ImportResult } from "../../types/deno.d.ts";

interface Arguments {
  file: string;
  project: string;
  dryRun: boolean;
  output?: string;
  domain?: string;
}

const inputArgs: Arguments = yargs(Deno.args)
  .alias("f", "file")
  .alias("p", "project")
  .alias("d", "dry-run")
  .alias("o", "output")
  .alias("domain", "domain")
  .boolean("d")
  .demandOption(["f", "p"])
  .describe("domain", "LaunchDarkly domain (default: app.launchdarkly.com)")
  .parse() as Arguments;

async function main() {
  try {
    console.log(Colors.blue("🚀 LaunchDarkly Flag Import Tool"));
    console.log("=====================================\n");

    // Check if file exists in the import-files directory
    const importFilesDir = "./data/third-party-migrations/import-files/";
    const filePath = inputArgs.file.startsWith("/") || inputArgs.file.startsWith("./") 
      ? inputArgs.file 
      : `${importFilesDir}${inputArgs.file}`;
    
    try {
      await Deno.stat(filePath);
    } catch {
      console.error(Colors.red(`❌ File not found: ${filePath}`));
      console.error(Colors.yellow(`💡 Place your import files in: ${importFilesDir}`));
      console.error(Colors.yellow(`   Or provide the full path to your file`));
      Deno.exit(1);
    }

    // Parse input file
    console.log(`📁 Parsing file: ${filePath}`);
    const flags = await parseFlagImportFile(filePath);
    console.log(`✅ Found ${flags.length} flags to import\n`);

    // Validate flag data
    console.log("🔍 Validating flag data...");
    const validation = validateFlagData(flags);
    
    if (!validation.valid) {
      console.error(Colors.red("❌ Validation failed:"));
      validation.errors.forEach(error => console.error(Colors.red(`   ${error}`)));
      Deno.exit(1);
    }
    console.log("✅ All flags validated successfully\n");

    if (inputArgs.dryRun) {
      console.log(Colors.yellow("🔍 DRY RUN MODE - No flags will be created\n"));
      console.log("📋 Flags that would be created:");
      
      for (const flag of flags) {
        const ldFlag = convertToLaunchDarklyFlag(flag);
        console.log(`\n   ${Colors.cyan(flag.key)}:`);
        console.log(`     Name: ${flag.name || 'N/A'}`);
        console.log(`     Kind: ${flag.kind}`);
        console.log(`     Variations: ${JSON.stringify(ldFlag.variations.map(v => v.value))}`);
        console.log(`     Defaults: on=${ldFlag.defaults.onVariation}, off=${ldFlag.defaults.offVariation}`);
        if (flag.tags && flag.tags.length > 0) {
          console.log(`     Tags: ${flag.tags.join(', ')}`);
        }
      }
      
      console.log(`\n✅ Dry run completed. ${flags.length} flags would be created.`);
      return;
    }

    // Get destination API key from config
    const apiKey = await getDestinationApiKey();
    const domain = inputArgs.domain || "app.launchdarkly.com";
    
    // Import flags
    console.log("🚀 Starting flag import...\n");
    const results: ImportResult[] = [];
    
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      console.log(`[${i + 1}/${flags.length}] Creating flag: ${Colors.cyan(flag.key)}`);
      
      try {
        const ldFlag = convertToLaunchDarklyFlag(flag);
        const result = await createFlagViaAPI(apiKey, domain, inputArgs.project, ldFlag);
        results.push(result);
        
        if (result.success) {
          console.log(`   ✅ Created successfully (${result.timing}ms)`);
        } else {
          console.log(`   ❌ Failed: ${result.error}`);
        }
        
        // Rate limiting delay between requests
        if (i < flags.length - 1) {
          await delay(200);
        }
        
      } catch (error) {
        const result: ImportResult = {
          key: flag.key,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        };
        results.push(result);
        console.log(`   ❌ Error: ${result.error}`);
      }
    }

    // Generate and display report
    console.log("\n" + "=".repeat(50));
    const report = generateImportReport(results);
    
    console.log(Colors.blue("📊 Import Report"));
    console.log("================");
    console.log(`Total Flags: ${report.totalFlags}`);
    console.log(`✅ Successful: ${Colors.green(report.successful.toString())}`);
    console.log(`❌ Failed: ${Colors.red(report.failed.toString())}`);
    console.log(`📅 Timestamp: ${report.timestamp}`);
    console.log(`📝 Summary: ${report.summary}`);

    // Save detailed report if requested
    if (inputArgs.output) {
      try {
        await Deno.writeTextFile(inputArgs.output, JSON.stringify(report, null, 2));
        console.log(`\n📄 Detailed report saved to: ${inputArgs.output}`);
      } catch (error) {
        console.error(Colors.red(`\n❌ Failed to save report: ${error}`));
      }
    }

    // Exit with error code if any flags failed
    if (report.failed > 0) {
      Deno.exit(1);
    }

  } catch (error) {
    console.error(Colors.red("❌ Fatal error:"), error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
