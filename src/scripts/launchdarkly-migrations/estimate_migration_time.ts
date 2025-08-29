import yargs from "https://deno.land/x/yargs@v17.7.2-deno/deno.ts";
import { estimateMigrationTime, formatTimeEstimate } from "../../utils/rate_limits.ts";
import * as Colors from "https://deno.land/std@0.149.0/fmt/colors.ts";

interface Arguments {
  projKeySource: string;
  rateLimit?: number;
}

const inputArgs: Arguments = (yargs(Deno.args)
  .alias("p", "projKeySource")
  .alias("r", "rateLimit")
  .number("r")
  .demandOption(["p"])
  .parse() as unknown) as Arguments;

async function main() {
  try {
    console.log("Analyzing project and calculating migration time...");
    
    // Get the estimate with optional custom rate limit
    const estimate = await estimateMigrationTime(inputArgs.projKeySource, inputArgs.rateLimit);
    
    console.log("\nMigration Time Estimate:");
    console.log("=======================");
    console.log(`Total estimated time: ${Colors.green(formatTimeEstimate(estimate))}`);
    
    console.log("\nResource Breakdown:");
    console.log("==================");
    console.log(`Flags: ${estimate.resourceCounts.flags}`);
    console.log(`Segments: ${estimate.resourceCounts.segments}`);
    console.log(`Environments: ${estimate.resourceCounts.environments}`);
    console.log(`Flag-Environment combinations: ${estimate.resourceCounts.flagEnvironments}`);
    
    console.log("\nTime Breakdown:");
    console.log("==============");
    console.log(`Flags: ${formatTimeEstimate({ totalTime: estimate.breakdown.flags, breakdown: estimate.breakdown, resourceCounts: estimate.resourceCounts })}`);
    console.log(`Segments: ${formatTimeEstimate({ totalTime: estimate.breakdown.segments, breakdown: estimate.breakdown, resourceCounts: estimate.resourceCounts })}`);
    
    if (inputArgs.rateLimit) {
      console.log(`\nUsing custom rate limit: ${inputArgs.rateLimit} requests per 10 seconds`);
    } else {
      console.log(`\nUsing default rate limit: 5 requests per 10 seconds`);
    }
    
    console.log("\nNote: This is an estimate based on current rate limits and project size.");
    console.log("Actual time may vary due to network conditions and API response times.");
  } catch (error) {
    console.error(Colors.red("Error:"), error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
} 