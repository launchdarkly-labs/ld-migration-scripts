import { parse } from "https://deno.land/std@0.177.0/flags/mod.ts";
import { ldAPIRequest, rateLimitRequest } from "../utils/utils.ts";
import { getSourceApiKey, getDestinationApiKey } from "../utils/api_keys.ts";

interface Member {
  _id: string;
  email: string;
}

interface ApiResponse {
  items: Array<{
    _id: string;
    email: string;
  }>;
  _links: {
    next?: {
      href: string;
    };
  };
}

interface MemberMapping {
  [key: string]: string | null;
}

async function fetchMembers(apiKey: string, domain: string): Promise<Member[]> {
  const allMembers: Member[] = [];
  let nextUrl = `members?limit=100`;

  while (nextUrl) {
    const req = ldAPIRequest(apiKey, domain, nextUrl);
    const response = await rateLimitRequest(req, "members");

    if (!response.ok) {
      throw new Error(`Failed to fetch members: ${response.statusText}`);
    }

    const data = await response.json() as ApiResponse;
    allMembers.push(...data.items.map(member => ({
      _id: member._id,
      email: member.email.toLowerCase(), // Normalize email to lowercase
    })));

    nextUrl = data._links.next?.href.split("/api/v2/")[1] || "";
  }

  return allMembers;
}

async function createMemberMapping(): Promise<MemberMapping> {
  const sourceApiKey = await getSourceApiKey();
  const destinationApiKey = await getDestinationApiKey();

  console.log("Fetching members from source instance...");
  const sourceMembers = await fetchMembers(sourceApiKey, "app.launchdarkly.com");
  console.log(`Found ${sourceMembers.length} members in source instance`);

  console.log("Fetching members from destination instance...");
  const destinationMembers = await fetchMembers(destinationApiKey, "app.launchdarkly.com");
  console.log(`Found ${destinationMembers.length} members in destination instance`);

  const mapping: MemberMapping = {};
  const destinationEmailToId = new Map(destinationMembers.map(m => [m.email, m._id]));

  for (const sourceMember of sourceMembers) {
    const destinationId = destinationEmailToId.get(sourceMember.email);
    mapping[sourceMember._id] = destinationId || null;
    
    if (!destinationId) {
      console.log(`Warning: No matching destination member found for ${sourceMember.email}`);
    }
  }

  return mapping;
}

async function main() {
  const flags = parse(Deno.args, {
    string: ["output"],
    alias: {
      "output": "o",
    },
  });

  const outputFile = flags.output || "data/mappings/maintainer_mapping.json";

  try {
    const mapping = await createMemberMapping();
    
    // Ensure the output directory exists
    await Deno.mkdir("data/mappings", { recursive: true });
    
    // Write the mapping to file
    await Deno.writeTextFile(
      outputFile,
      JSON.stringify(mapping, null, 2),
    );

    console.log(`\nMember mapping created successfully at ${outputFile}`);
    console.log("Summary:");
    console.log(`- Total source account members: ${Object.keys(mapping).length}`);
    console.log(`- Mapped to destination account members: ${Object.values(mapping).filter(id => id !== null).length}`);
    console.log(`- Unmapped members: ${Object.values(mapping).filter(id => id === null).length}`);
  } catch (error: unknown) {
    console.error("Error:", error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
} 
