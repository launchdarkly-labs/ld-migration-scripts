import { parse } from "https://deno.land/std@0.177.0/flags/mod.ts";
import { ldAPIRequest, rateLimitRequest } from "../utils/utils.ts";
import { getUsApiKey, getEuApiKey } from "../utils/api_keys.ts";

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
  const usApiKey = await getUsApiKey();
  const euApiKey = await getEuApiKey();

  console.log("Fetching members from US instance...");
  const usMembers = await fetchMembers(usApiKey, "app.launchdarkly.com");
  console.log(`Found ${usMembers.length} members in US instance`);

  console.log("Fetching members from EU instance...");
  const euMembers = await fetchMembers(euApiKey, "app.launchdarkly.com");
  console.log(`Found ${euMembers.length} members in EU instance`);

  const mapping: MemberMapping = {};
  const euEmailToId = new Map(euMembers.map(m => [m.email, m._id]));

  for (const usMember of usMembers) {
    const euId = euEmailToId.get(usMember.email);
    mapping[usMember._id] = euId || null;
    
    if (!euId) {
      console.log(`Warning: No matching EU member found for ${usMember.email}`);
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
    console.log(`- Total US members: ${Object.keys(mapping).length}`);
    console.log(`- Mapped to EU members: ${Object.values(mapping).filter(id => id !== null).length}`);
    console.log(`- Unmapped members: ${Object.values(mapping).filter(id => id === null).length}`);
  } catch (error: unknown) {
    console.error("Error:", error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
} 
