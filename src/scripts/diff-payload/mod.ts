import { create } from "npm:jsondiffpatch@0.7.6";
import { format as jsonpatchFormat } from "npm:jsondiffpatch@0.7.6/formatters/jsonpatch";
import { format as consoleFormat } from "npm:jsondiffpatch@0.7.6/formatters/console";

// --- Noise field configuration ---
const RECURSIVE_NOISE = new Set(["_id", "id"]);

const FLAG_NOISE = new Set([
  "version",
  "flagVersion",
  "debugEventsUntilDate",
  "salt",
  "sel",
]);

const SEGMENT_NOISE = new Set([
  "version",
  "generation",
  "salt",
]);

// --- Types ---

export type DiffFormat = "console" | "jsonpatch" | "delta";

export interface DiffOptions {
  includeSegments?: boolean;
  format?: DiffFormat;
}

export interface DiffSummary {
  changed: number;
  onlyLeft: number;
  onlyRight: number;
  identical: number;
}

export interface DiffResult {
  /** Raw jsondiffpatch delta. Undefined when payloads are identical. */
  delta: Record<string, unknown> | undefined;
  /** Formatted output string based on the chosen format. */
  formatted: string;
  /** Summary counts for flags. */
  flags: DiffSummary;
  /** Summary counts for segments (only present when includeSegments is true). */
  segments?: DiffSummary;
}

// --- Cleaning helpers ---

function deepClean(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((item) => deepClean(item));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (
      const [key, val] of Object.entries(
        value as Record<string, unknown>,
      )
    ) {
      if (!RECURSIVE_NOISE.has(key)) {
        result[key] = deepClean(val);
      }
    }
    return result;
  }

  return value;
}

function cleanEntries(
  entries: Record<string, unknown>,
  noiseFields: Set<string>,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(entries)) {
    const entry = entryValue as Record<string, unknown>;
    const cleanedEntry: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (!noiseFields.has(key) && !RECURSIVE_NOISE.has(key)) {
        cleanedEntry[key] = deepClean(value);
      }
    }
    cleaned[entryKey] = cleanedEntry;
  }
  return cleaned;
}

// --- Formatting ---

function formatDelta(
  delta: Record<string, unknown> | undefined,
  format: DiffFormat,
): string {
  if (format === "console") {
    if (delta) {
      return consoleFormat(delta as never) || "";
    }
    return "";
  } else if (format === "jsonpatch") {
    return JSON.stringify(delta ? jsonpatchFormat(delta as never) : []);
  } else {
    return JSON.stringify(delta ?? {});
  }
}

// --- Summary ---

function countEntries(
  subDelta: Record<string, unknown> | undefined,
  total: number,
): DiffSummary {
  let changed = 0, onlyLeft = 0, onlyRight = 0;
  for (const value of Object.values(subDelta ?? {})) {
    if (Array.isArray(value)) {
      if (value.length === 1) onlyRight++;
      else if (
        value.length === 3 && value[1] === 0 && value[2] === 0
      ) {
        onlyLeft++;
      } else changed++;
    } else {
      changed++;
    }
  }
  return {
    changed,
    onlyLeft,
    onlyRight,
    identical: total - changed - onlyLeft - onlyRight,
  };
}

// --- Public API ---

/**
 * Fetch an SDK polling payload from LaunchDarkly.
 */
export async function fetchSDKPayload(
  sdkKey: string,
  baseUrl = "https://sdk.launchdarkly.com",
): Promise<Record<string, unknown>> {
  const url = `${baseUrl}/sdk/latest-all`;
  const response = await fetch(url, {
    headers: { "Authorization": sdkKey },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `SDK poll failed: ${response.status} ${response.statusText}\nURL: ${url}\nResponse: ${body}`,
    );
  }

  return await response.json();
}

/**
 * Diff two SDK polling payloads, returning a structured result
 * with the delta, formatted output, and summary statistics.
 */
export function diffPayloads(
  payloadA: Record<string, unknown>,
  payloadB: Record<string, unknown>,
  options: DiffOptions = {},
): DiffResult {
  const { includeSegments = true, format = "console" } = options;

  const flagsA = (payloadA.flags ?? {}) as Record<string, unknown>;
  const flagsB = (payloadB.flags ?? {}) as Record<string, unknown>;

  const objectA: Record<string, unknown> = {
    flags: cleanEntries(flagsA, FLAG_NOISE),
  };
  const objectB: Record<string, unknown> = {
    flags: cleanEntries(flagsB, FLAG_NOISE),
  };

  if (includeSegments) {
    const segsA = (payloadA.segments ?? {}) as Record<string, unknown>;
    const segsB = (payloadB.segments ?? {}) as Record<string, unknown>;
    objectA.segments = cleanEntries(segsA, SEGMENT_NOISE);
    objectB.segments = cleanEntries(segsB, SEGMENT_NOISE);
  }

  const differ = create();
  const delta = differ.diff(objectA, objectB) as
    | Record<string, Record<string, unknown>>
    | undefined;

  const formatted = formatDelta(delta, format);

  const allFlagKeys = new Set([
    ...Object.keys(flagsA),
    ...Object.keys(flagsB),
  ]);
  const flagsSummary = countEntries(delta?.flags, allFlagKeys.size);

  const result: DiffResult = {
    delta,
    formatted,
    flags: flagsSummary,
  };

  if (includeSegments) {
    const segsA = (payloadA.segments ?? {}) as Record<string, unknown>;
    const segsB = (payloadB.segments ?? {}) as Record<string, unknown>;
    const allSegKeys = new Set([
      ...Object.keys(segsA),
      ...Object.keys(segsB),
    ]);
    result.segments = countEntries(delta?.segments, allSegKeys.size);
  }

  return result;
}
