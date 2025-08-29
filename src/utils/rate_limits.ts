import { ldAPIRequest, rateLimitRequest, getJson, ldAPIPostRequest, ldAPIPatchRequest } from "./utils.ts";
import { getDestinationApiKey } from "./api_keys.ts";

interface RateLimitInfo {
  globalRemaining: number;
  routeRemaining: number;
  resetTime: number;
}

interface ResourceCounts {
  flags: number;
  segments: number;
  environments: number;
  flagEnvironments: number; // Total number of flag * environment combinations
}

interface TimeEstimate {
  totalTime: number;
  breakdown: {
    flags: number;
    segments: number;
    environments: number;
  };
  resourceCounts: ResourceCounts;
}

/**
 * Tests rate limits for a specific API path
 * @param path The API path to test (e.g., 'flags', 'segments')
 * @param projectKey The project key to use in the test
 * @param debug Whether to log all response headers
 * @returns Rate limit information
 */
export async function testRateLimits(path: string, projectKey: string, debug = false): Promise<RateLimitInfo> {
  const apiKey = await getDestinationApiKey();
  const domain = "app.launchdarkly.com";
  
  // Test GET request
  console.log(`\nTesting GET request for ${path}...`);
  const getReq = ldAPIRequest(apiKey, domain, `projects/${projectKey}/${path}`);
  const getResponse = await rateLimitRequest(getReq, path);
  
  if (debug) {
    console.log(`\nGET response headers for ${path}:`);
    console.log("========================");
    for (const [key, value] of getResponse.headers.entries()) {
      console.log(`${key}: ${value}`);
    }
    console.log("========================");
  }

  // Test POST request (create)
  console.log(`\nTesting POST request for ${path}...`);
  const testData = path === "flags" 
    ? { key: "test-flag", name: "Test Flag", variations: [{ value: true }] }
    : { key: "test-segment", name: "Test Segment" };
  
  const postReq = ldAPIPostRequest(apiKey, domain, `${path}/${projectKey}`, testData);
  const postResponse = await rateLimitRequest(postReq, path);
  
  if (debug) {
    console.log(`\nPOST response headers for ${path}:`);
    console.log("========================");
    for (const [key, value] of postResponse.headers.entries()) {
      console.log(`${key}: ${value}`);
    }
    console.log("========================");
  }

  // Test PATCH request
  console.log(`\nTesting PATCH request for ${path}...`);
  const patchReq = ldAPIPatchRequest(
    apiKey, 
    domain, 
    `${path}/${projectKey}/${testData.key}`, 
    [{ op: "replace", path: "/name", value: "Updated Test" }]
  );
  const patchResponse = await rateLimitRequest(patchReq, path);
  
  if (debug) {
    console.log(`\nPATCH response headers for ${path}:`);
    console.log("========================");
    for (const [key, value] of patchResponse.headers.entries()) {
      console.log(`${key}: ${value}`);
    }
    console.log("========================");
  }
  
  // Check for rate limit headers in any of the responses
  const responses = [getResponse, postResponse, patchResponse];
  let globalRemaining = 0;
  let routeRemaining = 0;
  let resetTime = 0;

  for (const response of responses) {
    const headers = response.headers;
    if (headers.has("x-ratelimit-global-remaining")) {
      globalRemaining = parseInt(headers.get("x-ratelimit-global-remaining") || "0", 10);
    }
    if (headers.has("x-ratelimit-route-remaining")) {
      routeRemaining = parseInt(headers.get("x-ratelimit-route-remaining") || "0", 10);
    }
    if (headers.has("x-ratelimit-reset")) {
      // Convert from milliseconds to seconds
      resetTime = Math.floor(parseInt(headers.get("x-ratelimit-reset") || "0", 10) / 1000);
    }
  }
  
  console.log(`\nFound rate limits for ${path}:`);
  console.log(`- Global remaining: ${globalRemaining}`);
  console.log(`- Route remaining: ${routeRemaining}`);
  console.log(`- Reset time: ${new Date(resetTime * 1000).toLocaleString()}`);
  
  return {
    globalRemaining,
    routeRemaining,
    resetTime
  };
}

/**
 * Analyzes source project data to count resources
 * @param sourceProjectKey The source project key
 * @returns Counts of different resource types
 */
export async function analyzeSourceProject(sourceProjectKey: string): Promise<ResourceCounts> {
  const projectJson = await getJson(`./data/launchdarkly-migrations/source/project/${sourceProjectKey}/project.json`);
  const flagList = await getJson(`./data/launchdarkly-migrations/source/project/${sourceProjectKey}/flags.json`);
  
  const environments = projectJson.environments.items.length;
  const flags = flagList.length;
  
  // Count segments across all environments
  let segments = 0;
  for (const env of projectJson.environments.items) {
    try {
      const segmentData = await getJson(`./data/launchdarkly-migrations/source/project/${sourceProjectKey}/segment-${env.key}.json`);
      if (segmentData && segmentData.items) {
        segments += segmentData.items.length;
      }
    } catch (_error) {
      console.log(`Warning: Could not read segments for environment ${env.key}`);
    }
  }
  
  // Calculate total flag * environment combinations
  const flagEnvironments = flags * environments;
  
  return {
    flags,
    segments,
    environments,
    flagEnvironments
  };
}

/**
 * Estimates the time needed to migrate a project
 * @param sourceProjectKey The source project key
 * @param customRateLimit Optional custom rate limit (requests per 10 seconds)
 * @returns Time estimate in seconds
 */
export async function estimateMigrationTime(
  sourceProjectKey: string,
  customRateLimit?: number
): Promise<TimeEstimate> {
  // Get resource counts
  const counts = await analyzeSourceProject(sourceProjectKey);
  
  // Calculate requests needed for each resource type
  // Flags: 1 create + 1 patch per environment
  const flagRequests = counts.flags * (1 + counts.environments);
  
  // Segments: 1 create + 1 patch per segment
  const segmentRequests = counts.segments * 2;
  
  // Apply specific rate limits
  // Flag POST/PATCH: 5 requests per 10s (default) or custom rate limit
  // Segments: No rate limit
  
  // Calculate time in seconds (10 second window)
  const flagRequestsPerWindow = customRateLimit || 5; // Flag POST/PATCH limit
  const flagTime = Math.ceil(flagRequests / flagRequestsPerWindow) * 10;
  const segmentTime = 0; // No rate limit for segments
  
  // Add some buffer time for potential retries and other operations
  const totalTime = Math.ceil((flagTime + segmentTime) * 1.2);
  
  console.log("\nRequest calculations:");
  console.log(`Flag requests: ${flagRequests} (${counts.flags} creates + ${counts.flagEnvironments} patches)`);
  console.log(`Segment requests: ${segmentRequests} (${counts.segments} creates + ${counts.segments} patches)`);
  console.log(`Flag requests per window: ${flagRequestsPerWindow}`);
  
  return {
    totalTime,
    breakdown: {
      flags: flagTime,
      segments: segmentTime,
      environments: 0 // Environments are created as part of project creation
    },
    resourceCounts: counts
  };
}

/**
 * Formats a time estimate into a human-readable string
 * @param estimate The time estimate in seconds
 * @returns Formatted string
 */
export function formatTimeEstimate(estimate: TimeEstimate): string {
  const hours = Math.floor(estimate.totalTime / 3600);
  const minutes = Math.floor((estimate.totalTime % 3600) / 60);
  const seconds = estimate.totalTime % 60;
  
  const parts = [];
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
  if (seconds > 0) parts.push(`${seconds} second${seconds !== 1 ? 's' : ''}`);
  
  return parts.join(', ');
} 
