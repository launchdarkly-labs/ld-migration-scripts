import * as Colors from "https://deno.land/std/fmt/colors.ts";
import type { ImportFlag, LaunchDarklyFlag, ImportResult, ImportReport } from "../types/deno.d.ts";

const apiVersion = "20240415";

export async function getJson(filePath: string) {
  try {
    return JSON.parse(await Deno.readTextFile(filePath));
  } catch (e: unknown) {
    if (e instanceof Error) {
      console.log(filePath + ": " + e.message);
    }
  }
}

export async function delay(ms: number) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== Smart Rate Limiter ====================

interface RateLimitState {
  globalRemaining: number;
  routeRemaining: number;
  resetTime: number;  // epoch ms when limit resets
  lastUpdated: number;
}

// Track rate limits per route category
const rateLimitState: Map<string, RateLimitState> = new Map();

// Threshold: when remaining requests fall below this, start waiting proactively
const PROACTIVE_THRESHOLD = 3;

// Minimum delay between requests even when not rate limited (ms)
const MIN_REQUEST_SPACING = 50;

/**
 * Extracts rate limit information from response headers
 */
function extractRateLimitHeaders(response: Response): Partial<RateLimitState> {
  const headers = response.headers;
  const state: Partial<RateLimitState> = {};
  
  // Check for various rate limit header formats LaunchDarkly uses
  const globalRemaining = headers.get('x-ratelimit-global-remaining');
  const routeRemaining = headers.get('x-ratelimit-route-remaining') || headers.get('x-ratelimit-remaining');
  const resetTime = headers.get('x-ratelimit-reset');
  const retryAfter = headers.get('retry-after');
  
  if (globalRemaining) {
    state.globalRemaining = parseInt(globalRemaining, 10);
  }
  
  if (routeRemaining) {
    state.routeRemaining = parseInt(routeRemaining, 10);
  }
  
  if (resetTime) {
    state.resetTime = parseInt(resetTime, 10);
  } else if (retryAfter) {
    // retry-after is in seconds, convert to epoch ms
    state.resetTime = Date.now() + (parseInt(retryAfter, 10) * 1000);
  }
  
  state.lastUpdated = Date.now();
  
  return state;
}

/**
 * Updates the rate limit state for a route category
 */
function updateRateLimitState(routeCategory: string, response: Response): void {
  const extracted = extractRateLimitHeaders(response);
  const existing = rateLimitState.get(routeCategory) || {
    globalRemaining: 100,
    routeRemaining: 100,
    resetTime: 0,
    lastUpdated: 0
  };
  
  rateLimitState.set(routeCategory, {
    ...existing,
    ...extracted
  });
}

/**
 * Calculates how long to wait based on current rate limit state
 */
function calculateProactiveDelay(routeCategory: string): number {
  const state = rateLimitState.get(routeCategory);
  
  if (!state) {
    return MIN_REQUEST_SPACING;
  }
  
  const now = Date.now();
  const remaining = Math.min(state.globalRemaining, state.routeRemaining);
  
  // If we have plenty of requests remaining, just use minimum spacing
  if (remaining > PROACTIVE_THRESHOLD) {
    return MIN_REQUEST_SPACING;
  }
  
  // If we're low on requests, calculate time until reset
  if (state.resetTime > now) {
    const timeUntilReset = state.resetTime - now;
    // Spread remaining requests across the time until reset
    const delayPerRequest = remaining > 0 ? Math.ceil(timeUntilReset / remaining) : timeUntilReset;
    // Add jitter to avoid thundering herd
    const jitter = Math.floor(Math.random() * 100);
    return Math.max(delayPerRequest + jitter, MIN_REQUEST_SPACING);
  }
  
  return MIN_REQUEST_SPACING;
}

/**
 * Calculates delay when we've been rate limited (429 response)
 */
function calculateRateLimitDelay(response: Response): number {
  const now = Date.now();
  const retryAfterHeader = response.headers.get('retry-after');
  const rateLimitResetHeader = response.headers.get('x-ratelimit-reset');

  let retryAfter = 0;
  let rateLimitReset = 0;

  if (retryAfterHeader) {
    retryAfter = parseInt(retryAfterHeader, 10) * 1000; // Convert to ms
  }

  if (rateLimitResetHeader) {
    const resetTime = parseInt(rateLimitResetHeader, 10);
    rateLimitReset = resetTime - now;
  }
                          
  const delayMs = Math.max(retryAfter, rateLimitReset, 1000); // At least 1 second

  // Add random jitter
  const jitter = Math.floor(Math.random() * 100);
  return delayMs + jitter;
}

/**
 * Gets the current rate limit state for debugging/logging
 */
export function getRateLimitState(routeCategory: string): RateLimitState | undefined {
  return rateLimitState.get(routeCategory);
}

/**
 * Logs rate limit status for a route category
 */
export function logRateLimitStatus(routeCategory: string): void {
  const state = rateLimitState.get(routeCategory);
  if (state) {
    const remaining = Math.min(state.globalRemaining, state.routeRemaining);
    const resetIn = state.resetTime > Date.now() 
      ? Math.ceil((state.resetTime - Date.now()) / 1000) 
      : 0;
    console.log(Colors.gray(`  [Rate Limit] ${routeCategory}: ${remaining} remaining, resets in ${resetIn}s`));
  }
}

/**
 * Smart rate-limited request handler
 * - Tracks rate limit headers from responses
 * - Proactively waits when running low on requests
 * - Handles 429 responses with proper backoff
 */
export async function rateLimitRequest(req: Request, routeCategory: string): Promise<Response> {
  // Proactively wait based on current rate limit state
  const proactiveDelay = calculateProactiveDelay(routeCategory);
  if (proactiveDelay > MIN_REQUEST_SPACING) {
    console.log(Colors.gray(`  Proactive rate limit wait: ${proactiveDelay}ms for ${routeCategory}`));
  }
  await delay(proactiveDelay);
  
  const rateLimitReq = req.clone();
  const res = await fetch(req);
  
  // Update rate limit state from response headers
  updateRateLimitState(routeCategory, res);
  
  // Handle special cases
  if (res.status === 409 && routeCategory === 'projects') {
    console.warn(Colors.yellow(`It looks like this project has already been created in the destination`));
    console.warn(Colors.yellow(`To avoid errors and possible overwrite, please either:`));
    console.warn(Colors.yellow(`Update your name to a new one, or delete the existing project in the destination instance`));
    Deno.exit(1);
  }
  
  // Handle rate limiting (429)
  if (res.status === 429) {
    const waitTime = calculateRateLimitDelay(res);
    console.log(Colors.yellow(`Rate Limited for ${req.url} - waiting ${waitTime}ms`));
    await delay(waitTime);
    console.log(`Retrying request for ${req.url}`);
    return rateLimitRequest(rateLimitReq, routeCategory);
  }

  return res;
}

export function ldAPIPostRequest(
  apiKey: string,
  domain: string,
  path: string,
  body: any,
  useBetaVersion = false,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    'User-Agent': 'Project-Migrator-Script',
    "Authorization": apiKey,
  };
  
  // Only add LD-API-Version header when using beta
  if (useBetaVersion) {
    headers["LD-API-Version"] = "beta";
  }
  
  const req = new Request(
    `https://${domain}/api/v2/${path}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
  return req;
}

export function ldAPIPatchRequest(
  apiKey: string,
  domain: string,
  path: string,
  body: any,
) {
  const req = new Request(
    `https://${domain}/api/v2/${path}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": apiKey,
        "LD-API-Version": apiVersion,
      },
      body: JSON.stringify(body),
    },
  );

  return req;
}

export function buildPatch(key: string, op: string, value: any) {
  return {
    path: "/" + key,
    op,
    value,
  };
}

export interface RuleClause {
  _id: string;
  [key: string]: unknown;
}

export interface Rule {
  clauses: RuleClause[];
  _id: string;
  generation: number;
  deleted: boolean;
  version: number;
  ref: string;
  [key: string]: unknown;
}

export function buildRules(
  rules: Rule[],
  env?: string,
): { path: string; op: string; value: any }[] {
  const newRules: { path: string; op: string; value: any }[] = [];
  const path = env ? `${env}/rules/-` : "rules/-";
  rules.map(({ clauses, _id, generation, deleted, version, ref, ...rest }) => {
    const newRule = rest;
    const newClauses = { clauses: clauses.map(({ _id, ...rest }) => rest) };
    Object.assign(newRule, newClauses);
    newRules.push(buildPatch(path, "add", newRule));
  });

  return newRules;
}

export async function writeSourceData(
  projPath: string,
  dataType: string,
  data: any,
) {
  return await writeJson(`${projPath}/${dataType}.json`, data);
}

export function ldAPIRequest(apiKey: string, domain: string, path: string, useBetaVersion = false) {
  const headers: Record<string, string> = {
    "Authorization": apiKey,
    'User-Agent': 'launchdarkly-project-migrator-script',
  };
  
  // Only add LD-API-Version header when using beta
  if (useBetaVersion) {
    headers["LD-API-Version"] = "beta";
  }
  
  const req = new Request(
    `https://${domain}/api/v2/${path}`,
    {
      headers,
    },
  );

  return req;
}

async function writeJson(filePath: string, o: any) {
  try {
    await Deno.writeTextFile(filePath, JSON.stringify(o, null, 2));
  } catch (e) {
    console.log(e);
  }
}

export function consoleLogger(status: number, message: string) {
  if (status > 201 && status != 429) {
    return console.warn(Colors.yellow(message));
  }

  return console.log(message);
}

// Flag Import Utility Functions
export async function parseFlagImportFile(filePath: string): Promise<ImportFlag[]> {
  try {
    const fileContent = await Deno.readTextFile(filePath);
    const fileExtension = filePath.split('.').pop()?.toLowerCase();
    
    if (fileExtension === 'json') {
      return JSON.parse(fileContent) as ImportFlag[];
    } else if (fileExtension === 'csv') {
      return parseCSVFlags(fileContent);
    } else {
      throw new Error(`Unsupported file format: ${fileExtension}. Only JSON and CSV are supported.`);
    }
  } catch (error) {
    throw new Error(`Failed to parse file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseCSVFlags(csvContent: string): ImportFlag[] {
  const lines = csvContent.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  
  // Validate required headers
  const requiredHeaders = ['key', 'name', 'kind', 'variations', 'defaultOnVariation', 'defaultOffVariation'];
  for (const header of requiredHeaders) {
    if (!headers.includes(header)) {
      throw new Error(`Missing required header: ${header}`);
    }
  }
  
  const flags: ImportFlag[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const values = parseCSVLine(line);
    if (values.length !== headers.length) {
      throw new Error(`Line ${i + 1}: Expected ${headers.length} columns, got ${values.length}`);
    }
    
    const flag: any = {};
    headers.forEach((header, index) => {
      flag[header] = values[index];
    });
    
    // Parse variations
    flag.variations = parseCSVVariations(flag.variations, flag.kind);
    flag.defaultOnVariation = parseCSVValue(flag.defaultOnVariation, flag.kind);
    flag.defaultOffVariation = parseCSVValue(flag.defaultOffVariation, flag.kind);
    
    // Parse tags
    if (flag.tags) {
      flag.tags = flag.tags.split(',').map((tag: string) => tag.trim()).filter((tag: string) => tag);
    }
    
    flags.push(flag as ImportFlag);
  }
  
  return flags;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;
  
  while (i < line.length) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        // Handle escaped quotes (double quotes)
        current += '"';
        i += 2;
      } else {
        inQuotes = !inQuotes;
        i++;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
      i++;
    } else {
      current += char;
      i++;
    }
  }
  
  result.push(current.trim());
  return result;
}

function parseCSVVariations(variationsStr: string, kind: string): (boolean | string | number | any)[] {
  switch (kind) {
    case 'boolean':
    case 'number':
    case 'string':
      const variations = variationsStr.split(',').map((v: string) => v.trim());
      if (kind === 'boolean') {
        return variations.map((v: string) => v === 'true');
      } else if (kind === 'number') {
        return variations.map((v: string) => parseFloat(v));
      } else {
        return variations;
      }
    case 'json':
      // For JSON, we need to handle the case where variations contain multiple JSON objects
      // The variationsStr should be in format: {"obj1"},{"obj2"},{"obj3"}
      try {
        // First, let's try to parse it as a single JSON object
        if (variationsStr.startsWith('{') && variationsStr.endsWith('}')) {
          return [JSON.parse(variationsStr)];
        }
        
        // If that fails, try to split by "},{ and reconstruct as individual JSON objects
        const parts = variationsStr.split('},{');
        const jsonVariations = parts.map((part, index) => {
          let jsonStr = part;
          if (index === 0 && !jsonStr.startsWith('{')) {
            jsonStr = '{' + jsonStr;
          }
          if (index === parts.length - 1 && !jsonStr.endsWith('}')) {
            jsonStr = jsonStr + '}';
          }
          if (!jsonStr.startsWith('{') || !jsonStr.endsWith('}')) {
            jsonStr = '{' + jsonStr + '}';
          }
          return JSON.parse(jsonStr);
        });
        return jsonVariations;
      } catch (error) {
        throw new Error(`Failed to parse JSON variations: ${variationsStr}. Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    default:
      throw new Error(`Unsupported flag kind: ${kind}`);
  }
}

function parseCSVValue(value: string, kind: string): any {
  switch (kind) {
    case 'boolean':
      return value === 'true';
    case 'number':
      return parseFloat(value);
    case 'string':
      return value;
    case 'json':
      return JSON.parse(value);
    default:
      throw new Error(`Unsupported flag kind: ${kind}`);
  }
}

export function validateFlagData(flags: ImportFlag[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Check for duplicate keys
  const keys = new Set<string>();
  for (const flag of flags) {
    if (keys.has(flag.key)) {
      errors.push(`Duplicate flag key: ${flag.key}`);
    }
    keys.add(flag.key);
  }
  
  // Validate each flag
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    const lineNum = i + 1;
    
    // Required fields
    if (!flag.key || flag.key.trim() === '') {
      errors.push(`Line ${lineNum}: Missing or empty key`);
    }
    
    if (!flag.kind || !['boolean', 'string', 'number', 'json'].includes(flag.kind)) {
      errors.push(`Line ${lineNum}: Invalid kind '${flag.kind}'. Must be one of: boolean, string, number, json`);
    }
    
    if (!flag.variations || flag.variations.length === 0) {
      errors.push(`Line ${lineNum}: Missing or empty variations`);
    }
    
    // Validate default variations exist in variations array
    const onVariationExists = flag.variations.some(v => 
      flag.kind === 'json' ? JSON.stringify(v) === JSON.stringify(flag.defaultOnVariation) : v === flag.defaultOnVariation
    );
    const offVariationExists = flag.variations.some(v => 
      flag.kind === 'json' ? JSON.stringify(v) === JSON.stringify(flag.defaultOffVariation) : v === flag.defaultOffVariation
    );
    
    if (!onVariationExists) {
      errors.push(`Line ${lineNum}: defaultOnVariation '${JSON.stringify(flag.defaultOnVariation)}' not found in variations`);
    }
    
    if (!offVariationExists) {
      errors.push(`Line ${lineNum}: defaultOffVariation '${JSON.stringify(flag.defaultOffVariation)}' not found in variations`);
    }
    
    // Type-specific validation
    if (flag.kind === 'boolean' && flag.variations.length !== 2) {
      errors.push(`Line ${lineNum}: Boolean flags must have exactly 2 variations`);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

export function convertToLaunchDarklyFlag(importFlag: ImportFlag): LaunchDarklyFlag {
  const variations = importFlag.variations.map((v: any) => ({ value: v }));
  
  // Find indices for default variations
  const onIndex = importFlag.variations.findIndex((v: any) => 
    importFlag.kind === 'json' ? JSON.stringify(v) === JSON.stringify(importFlag.defaultOnVariation) : v === importFlag.defaultOnVariation
  );
  const offIndex = importFlag.variations.findIndex((v: any) => 
    importFlag.kind === 'json' ? JSON.stringify(v) === JSON.stringify(importFlag.defaultOffVariation) : v === importFlag.defaultOffVariation
  );
  
  if (onIndex === -1 || offIndex === -1) {
    throw new Error(`Default variations not found in variations array for flag ${importFlag.key}`);
  }
  
  return {
    key: importFlag.key,
    name: importFlag.name || importFlag.key, // Ensure name is always present
    description: importFlag.description || "",
    kind: importFlag.kind,
    variations,
    defaults: {
      onVariation: onIndex,
      offVariation: offIndex
    },
    tags: importFlag.tags || []
  };
}

export async function createFlagViaAPI(
  apiKey: string,
  domain: string,
  projectKey: string,
  flag: LaunchDarklyFlag
): Promise<ImportResult> {
  const startTime = Date.now();
  
  try {
    const request = ldAPIPostRequest(apiKey, domain, `flags/${projectKey}`, flag);
    const response = await rateLimitRequest(request, "flags");
    
    if (response.ok) {
      return {
        key: flag.key,
        success: true,
        timing: Date.now() - startTime
      };
    } else {
      const errorText = await response.text();
      return {
        key: flag.key,
        success: false,
        error: `HTTP ${response.status}: ${errorText}`
      };
    }
  } catch (error) {
    return {
      key: flag.key,
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function generateImportReport(results: ImportResult[]): ImportReport {
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const total = results.length;
  
  const summary = `Import completed: ${successful} successful, ${failed} failed out of ${total} total flags`;
  
  return {
    totalFlags: total,
    successful,
    failed,
    results,
    summary,
    timestamp: new Date().toISOString()
  };
}

// ==================== View Management ====================

export interface View {
  key: string;
  name: string;
  description?: string;
  tags?: string[];
  maintainerId?: string;
}

type ViewOperationResult = { success: boolean; error?: string };

/**
 * Checks if a view exists in a project
 */
export const checkViewExists = async (
  apiKey: string,
  domain: string,
  projectKey: string,
  viewKey: string
): Promise<boolean> => {
  try {
    const req = ldAPIRequest(apiKey, domain, `projects/${projectKey}/views/${viewKey}`, true);
    const response = await rateLimitRequest(req, 'views');
    return response.status === 200;
  } catch {
    return false;
  }
};

/**
 * Determines if a view creation response is successful
 */
const isViewCreationSuccess = (status: number): boolean => 
  status === 200 || status === 201 || status === 409;

/**
 * Creates an error result from a response
 */
const createErrorResult = async (response: Response): Promise<ViewOperationResult> => {
  const errorText = await response.text();
  return {
    success: false,
    error: `HTTP ${response.status}: ${errorText}`
  };
};

/**
 * Creates an error result from an exception
 */
const createExceptionResult = (error: unknown): ViewOperationResult => ({
  success: false,
  error: error instanceof Error ? error.message : String(error)
});

/**
 * Creates a view in a LaunchDarkly project
 */
export const createView = async (
  apiKey: string,
  domain: string,
  projectKey: string,
  view: View
): Promise<ViewOperationResult> => {
  try {
    const req = ldAPIPostRequest(apiKey, domain, `projects/${projectKey}/views`, view, true);
    const response = await rateLimitRequest(req, 'views');
    
    return isViewCreationSuccess(response.status)
      ? { success: true }
      : await createErrorResult(response);
  } catch (error) {
    return createExceptionResult(error);
  }
};

/**
 * Extracts views from API response data
 */
const extractViewsFromResponse = (data: any): View[] => 
  data.items || [];

/**
 * Fetches all views from a LaunchDarkly project
 */
export const getViewsFromProject = async (
  apiKey: string,
  domain: string,
  projectKey: string
): Promise<View[]> => {
  try {
    const req = ldAPIRequest(apiKey, domain, `projects/${projectKey}/views`, true);
    const response = await rateLimitRequest(req, 'views');
    
    if (response.status === 200) {
      const data = await response.json();
      return extractViewsFromResponse(data);
    }
    return [];
  } catch (error) {
    console.log(Colors.yellow(
      `Warning: Could not fetch views from project ${projectKey}: ${error}`
    ));
    return [];
  }
};

// ==================== Conflict Resolution ====================

export interface ConflictResolution {
  originalKey: string;
  resolvedKey: string;
  resourceType: 'flag' | 'segment' | 'project';
  conflictPrefix: string;
}

type ConflictsByType = Record<string, number>;

/**
 * Applies a prefix to a resource key
 */
export const applyConflictPrefix = (originalKey: string, prefix: string): string =>
  `${prefix}${originalKey}`;

/**
 * Groups conflicts by resource type
 */
const groupConflictsByType = (resolutions: ConflictResolution[]): ConflictsByType =>
  resolutions.reduce((acc, r) => {
    acc[r.resourceType] = (acc[r.resourceType] || 0) + 1;
    return acc;
  }, {} as ConflictsByType);

/**
 * Formats a conflict type count line
 */
const formatTypeCountLine = ([type, count]: [string, number]): string =>
  `  - ${type}: ${count}`;

/**
 * Formats a conflict resolution line
 */
const formatResolutionLine = (r: ConflictResolution): string =>
  `  - ${r.resourceType}: "${r.originalKey}" → "${r.resolvedKey}"`;

/**
 * Creates the header section of the conflict report
 */
const createReportHeader = (totalCount: number): string[] => [
  `\n${'='.repeat(60)}`,
  `CONFLICT RESOLUTION REPORT`,
  `${'='.repeat(60)}`,
  `Total conflicts resolved: ${totalCount}`,
  ``
];

/**
 * Creates the by-type section of the conflict report
 */
const createByTypeSection = (byType: ConflictsByType): string[] => [
  `Conflicts by resource type:`,
  ...Object.entries(byType).map(formatTypeCountLine),
  ``
];

/**
 * Creates the resolutions list section
 */
const createResolutionsSection = (resolutions: ConflictResolution[]): string[] => [
  `Conflict resolutions:`,
  ...resolutions.map(formatResolutionLine)
];

/**
 * Generates a conflict resolution report
 */
const generateConflictReport = (resolutions: ConflictResolution[]): string => {
  if (resolutions.length === 0) {
    return "No conflicts encountered during migration.";
  }

  const byType = groupConflictsByType(resolutions);
  
  const reportLines = [
    ...createReportHeader(resolutions.length),
    ...createByTypeSection(byType),
    ...createResolutionsSection(resolutions),
    `${'='.repeat(60)}\n`
  ];

  return reportLines.join('\n');
};

/**
 * Tracks and reports on conflict resolutions during migration
 * Uses immutable approach while maintaining interface compatibility
 */
export class ConflictTracker {
  private readonly resolutions: ConflictResolution[] = [];

  addResolution(resolution: ConflictResolution): void {
    this.resolutions.push(resolution);
  }

  getResolutions(): ConflictResolution[] {
    return [...this.resolutions];
  }

  hasConflicts(): boolean {
    return this.resolutions.length > 0;
  }

  getReport(): string {
    return generateConflictReport(this.resolutions);
  }
}
