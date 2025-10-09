import yargs from "https://deno.land/x/yargs@v17.7.2-deno/deno.ts";
import {
  // ensureDir,
  ensureDirSync,
} from "https://deno.land/std@0.149.0/fs/mod.ts";
import {
  consoleLogger,
  delay,
  ldAPIRequest,
  rateLimitRequest,
  writeSourceData,
} from "../../utils/utils.ts";
import { getSourceApiKey } from "../../utils/api_keys.ts";

interface Arguments {
  projKey: string;
  domain?: string;
}

const inputArgs: Arguments = yargs(Deno.args)
  .alias("p", "projKey")
  .alias("domain", "domain")
  .describe("domain", "LaunchDarkly domain (default: app.launchdarkly.com)")
  .parse() as Arguments;

// ensure output directory exists
const projPath = `./data/launchdarkly-migrations/source/project/${inputArgs.projKey}`;
ensureDirSync(projPath);

// Get API key
const apiKey = await getSourceApiKey();
const domain = inputArgs.domain || "app.launchdarkly.com";

// Project Data //
const projResp = await rateLimitRequest(
  ldAPIRequest(
    apiKey,
    domain,
    `projects/${inputArgs.projKey}?expand=environments`
  ),
  "project"
);
if (projResp == null) {
  console.log("Failed getting project");
  Deno.exit(1);
}
const projData = await projResp.json();

console.log(projData);
// Handle pagination for environments if needed
const allEnvironments = projData.environments.items;
const totalEnvironments = projData.environments.totalCount || allEnvironments.length;

if (totalEnvironments > allEnvironments.length) {
  console.log(`Project has ${totalEnvironments} environments, fetching all...`);
  
  const envPageSize: number = 20;
  let envOffset: number = allEnvironments.length;
  let moreEnvironments: boolean = true;
  let envPath = `projects/${inputArgs.projKey}/environments?limit=${envPageSize}&offset=${envOffset}`;

  while (moreEnvironments) {
    console.log(`Getting additional environments: ${envOffset} to ${envOffset + envPageSize}`);

    const envResp = await rateLimitRequest(
      ldAPIRequest(apiKey, domain, envPath),
      "environments"
    );

    if (envResp.status > 201) {
      consoleLogger(envResp.status, `Error getting environments: ${envResp.status}`);
      consoleLogger(envResp.status, await envResp.text());
    }
    if (envResp == null) {
      console.log("Failed getting environments");
      Deno.exit(1);
    }

    const envData = await envResp.json();

    allEnvironments.push(...envData.items);

    if (envData._links.next) {
      envOffset += envPageSize;
      envPath = `projects/${inputArgs.projKey}/environments?limit=${envPageSize}&offset=${envOffset}`;
    } else {
      moreEnvironments = false;
    }
  }
}

// Update the project data with all environments
projData.environments.items = allEnvironments;

await writeSourceData(projPath, "project", projData);

console.log(`Found ${allEnvironments.length} environments`);

// Segment Data //
if (allEnvironments.length > 0) {
  for (const env of allEnvironments) {
    console.log(`Getting Segments for environment: ${env.key}`);

    const segmentResp = await fetch(
      ldAPIRequest(
        apiKey,
        domain,
        `segments/${inputArgs.projKey}/${env.key}?limit=50`
      )
    );
    if (segmentResp == null) {
      console.log("Failed getting Segments");
      Deno.exit(1);
    }
    const segmentData = await segmentResp.json();

    await writeSourceData(projPath, `segment-${env.key}`, segmentData);
    const end = Date.now() + 2_000;
    while (Date.now() < end);
  }
}

// Get List of all Flags
const pageSize: number = 5;
let offset: number = 0;
let moreFlags: boolean = true;
const flags: string[] = [];
let path = `flags/${inputArgs.projKey}?summary=true&limit=${pageSize}&offset=${offset}`;

while (moreFlags) {
  console.log(`Building flag list: ${offset} to ${offset + pageSize}`);

  const flagsResp = await rateLimitRequest(
    ldAPIRequest(apiKey, domain, path),
    "flags"
  );

  if (flagsResp.status > 201) {
    consoleLogger(flagsResp.status, `Error getting flags: ${flagsResp.status}`);
    consoleLogger(flagsResp.status, await flagsResp.text());
  }
  if (flagsResp == null) {
    console.log("Failed getting Flags");
    Deno.exit(1);
  }

  const flagsData = await flagsResp.json();

  flags.push(...flagsData.items.map((flag: any) => flag.key));

  if (flagsData._links.next) {
    offset += pageSize;
    path = `flags/${inputArgs.projKey}?summary=true&limit=${pageSize}&offset=${offset}`;
  } else {
    moreFlags = false;
  }
}

console.log(`Found ${flags.length} flags`);

await writeSourceData(projPath, "flags", flags);

// Get Individual Flag Data //
ensureDirSync(`${projPath}/flags`);

for (const [index, flagKey] of flags.entries()) {
  console.log(`Getting flag ${index + 1} of ${flags.length}: ${flagKey}`);

  await delay(200);

  const flagResp = await fetch(
    ldAPIRequest(
      apiKey,
      domain,
      `flags/${inputArgs.projKey}/${flagKey}`
    )
  );
  if (flagResp.status > 201) {
    consoleLogger(
      flagResp.status,
      `Error getting flag '${flagKey}': ${flagResp.status}`
    );
    consoleLogger(flagResp.status, await flagResp.text());
  }
  if (flagResp == null) {
    console.log("Failed getting flag '${flagKey}'");
    Deno.exit(1);
  }

  const flagData = await flagResp.json();

  await writeSourceData(`${projPath}/flags`, flagKey, flagData);
}
