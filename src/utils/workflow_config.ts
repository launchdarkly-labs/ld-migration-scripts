/**
 * Workflow YAML normalization and multi-project helpers.
 */

export interface WorkflowConfig {
  workflow?: {
    steps?: string[];
  };
  source: {
    projectKey?: string;
    projectKeys?: string[];
    domain?: string;
  };
  destination?: {
    projectKey?: string;
    /** Used only when the migrate step creates the destination project */
    projectName?: string;
    domain?: string;
    /** With source.projectKeys: source key -> destination key (unlisted keys keep the same key) */
    projectKeyMapping?: Record<string, string>;
    /** With source.projectKeys: destination key -> name used only when the project is created */
    projectNames?: Record<string, string>;
  };
  extraction?: {
    includeSegments?: boolean;
  };
  memberMapping?: {
    outputFile?: string;
  };
  splitExtract?: {
    /** Split workspace (project) ID or name */
    workspace: string;
    /** Only extract Split flags/segments with this tag */
    tag?: string;
    /** Split environment names to extract (default: all) */
    environments?: string[];
    /** Split env name → LD env key */
    environmentMapping?: Record<string, string>;
    /** Split API host override */
    baseUrl?: string;
    /** Tag applied to imported resources (default: imported-from-split) */
    ldTag?: string;
  };
  migration?: {
    assignMaintainerIds?: boolean;
    migrateSegments?: boolean;
    conflictPrefix?: string;
    onConflict?: string;
    targetView?: string;
    environments?: string[];
    environmentMapping?: Record<string, string>;
    dryRun?: boolean;
    incremental?: boolean;
    since?: string;
    includeFlags?: string[];
    excludeFlags?: string[];
    concurrency?: number;
    createProject?: boolean;
    createEnvironments?: boolean;
  };
  thirdPartyImport?: {
    inputFile: string;
    targetProject: string;
    dryRun?: boolean;
    upsert?: boolean;
    reportOutput?: string;
  };
  revert?: {
    dryRun?: boolean;
    deleteViews?: boolean;
    viewKeys?: string[];
  };
}

export type WorkflowStepName =
  | "extract-source"
  | "split-extract"
  | "map-members"
  | "migrate"
  | "third-party-import"
  | "revert";

export const ACCOUNT_LEVEL_STEPS = new Set<string>([
  "map-members",
  "third-party-import",
  "split-extract",
]);

export const PROJECT_LEVEL_STEPS = new Set<string>([
  "extract-source",
  "migrate",
  "revert",
]);

/**
 * Coerce YAML project key values to a trimmed string.
 * Only strings and numbers are accepted; booleans and other types are treated as missing.
 */
export function coerceProjectKey(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

/** Shallow clone of workflow config (extension point for future normalization). */
export function normalizeWorkflowConfig(raw: WorkflowConfig): WorkflowConfig {
  return { ...raw };
}

/**
 * Resolves the list of source project keys from config.
 * @throws Error if neither projectKey nor projectKeys is set
 */
export function resolveProjectKeys(config: WorkflowConfig): string[] {
  const fromList = config.source.projectKeys
    ?.map((k) => coerceProjectKey(k))
    .filter((k): k is string => k !== undefined);
  if (fromList && fromList.length > 0) {
    return [...new Set(fromList)];
  }
  const single = coerceProjectKey(config.source.projectKey);
  if (single) {
    return [single];
  }
  throw new Error(
    "Workflow config must specify source.projectKey (single project) or source.projectKeys (list of projects).",
  );
}

/** True when config uses a multi-project keys list. */
export function usesProjectKeysList(config: WorkflowConfig): boolean {
  return (
    (config.source.projectKeys?.map((k) => coerceProjectKey(k)).filter(Boolean)
      .length ?? 0) > 0
  );
}

export interface ProjectPair {
  source: string;
  destination: string;
}

/** True when destination.projectKeyMapping has at least one entry. */
export function usesProjectKeyMapping(config: WorkflowConfig): boolean {
  const mapping = config.destination?.projectKeyMapping;
  return !!mapping && typeof mapping === "object" &&
    Object.keys(mapping).length > 0;
}

/**
 * Resolves destination.projectKeyMapping (source key -> destination key).
 * Only applies with source.projectKeys; returns {} otherwise.
 * @throws Error if a mapping key is not in source.projectKeys or a value is not a valid key
 */
export function resolveProjectKeyMapping(
  config: WorkflowConfig,
): Record<string, string> {
  if (!usesProjectKeysList(config) || !usesProjectKeyMapping(config)) {
    return {};
  }
  const keys = new Set(resolveProjectKeys(config));
  const resolved: Record<string, string> = {};
  for (
    const [rawSource, rawDest] of Object.entries(
      config.destination!.projectKeyMapping!,
    )
  ) {
    const source = coerceProjectKey(rawSource);
    if (!source || !keys.has(source)) {
      throw new Error(
        `destination.projectKeyMapping key "${rawSource}" is not listed in source.projectKeys`,
      );
    }
    const dest = coerceProjectKey(rawDest);
    if (!dest) {
      throw new Error(
        `destination.projectKeyMapping value for "${source}" must be a non-empty project key`,
      );
    }
    resolved[source] = dest;
  }
  return resolved;
}

/**
 * Groups pairs by destination, keeping only destinations that receive more than one source.
 * Sources are listed in pair order.
 */
export function findMergedDestinations(
  pairs: ProjectPair[],
): Map<string, string[]> {
  const byDest = new Map<string, string[]>();
  for (const { source, destination } of pairs) {
    byDest.set(destination, [...(byDest.get(destination) ?? []), source]);
  }
  return new Map([...byDest].filter(([, sources]) => sources.length > 1));
}

/**
 * Resolves source/destination project pairs from config.
 * projectKeys entries map to destination.projectKeyMapping[key], else the same key;
 * a single projectKey uses destination.projectKey, falling back to the source key.
 * @throws Error if neither projectKey nor projectKeys is set, or the mapping is invalid
 */
export function resolveProjectPairs(
  config: WorkflowConfig,
): ProjectPair[] {
  if (usesProjectKeysList(config)) {
    const mapping = resolveProjectKeyMapping(config);
    return resolveProjectKeys(config).map((key) => ({
      source: key,
      destination: mapping[key] ?? key,
    }));
  }
  const [source] = resolveProjectKeys(config);
  const destination = coerceProjectKey(config.destination?.projectKey) ??
    source;
  return [{ source, destination }];
}

/**
 * Name for a newly created destination project.
 * An explicit name wins; otherwise the destination key when it differs from the
 * source key (avoids two same-named projects in one account), else the source name.
 */
export function resolveDestinationProjectName(opts: {
  explicit?: unknown;
  sourceName?: string;
  sourceKey: string;
  destKey: string;
}): string {
  const explicit = coerceProjectKey(opts.explicit);
  if (explicit) {
    return explicit;
  }
  if (opts.destKey !== opts.sourceKey) {
    return opts.destKey;
  }
  return opts.sourceName?.trim() || opts.destKey;
}

/**
 * Clone config for one source/destination pair of a projectKeys workflow.
 * destination.projectName comes from destination.projectNames[destination] (a single
 * projectName can't label every project in the list); the mapping maps are dropped.
 */
export function withProjectPair(
  config: WorkflowConfig,
  pair: ProjectPair,
): WorkflowConfig {
  const {
    projectName: _projectName,
    projectKeyMapping: _projectKeyMapping,
    projectNames,
    ...destination
  } = config.destination ?? {};
  const projectName = coerceProjectKey(projectNames?.[pair.destination]);
  return {
    ...config,
    workflow: config.workflow ? { ...config.workflow } : undefined,
    source: {
      ...config.source,
      projectKey: pair.source,
    },
    destination: {
      ...destination,
      projectKey: pair.destination,
      ...(projectName ? { projectName } : {}),
    },
  };
}

/** Clone config with source and destination projectKey set to the same key. */
export function withProjectKey(
  config: WorkflowConfig,
  projectKey: string,
): WorkflowConfig {
  return withProjectPair(config, {
    source: projectKey,
    destination: projectKey,
  });
}

export const SOURCE_DATA_DIR = "./data/launchdarkly-migrations/source/project";

export interface MergeCollisions {
  flags: string[];
  /** Environment key -> overlapping segment keys */
  segments: Record<string, string[]>;
}

const readJsonFile = async (path: string): Promise<unknown | undefined> => {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw error;
  }
};

/** Keys from extracted data: either a plain key list or `{ items: [{ key }] }`. */
const extractKeys = (data: unknown): string[] => {
  const items = Array.isArray(data)
    ? data
    : (data as { items?: unknown[] } | undefined)?.items ?? [];
  return items
    .map((item) =>
      typeof item === "string" ? item : (item as { key?: string })?.key
    )
    .filter((key): key is string => typeof key === "string");
};

const loadFlagKeys = async (
  baseDir: string,
  projectKey: string,
): Promise<string[]> => {
  const path = `${baseDir}/${projectKey}/flags.json`;
  const data = await readJsonFile(path);
  if (data === undefined) {
    throw new Error(
      `Missing extracted source data at ${path}; run the extract-source step for "${projectKey}" first`,
    );
  }
  return extractKeys(data);
};

const listSegmentEnvs = async (
  baseDir: string,
  projectKey: string,
): Promise<string[]> => {
  const envs: string[] = [];
  try {
    for await (const entry of Deno.readDir(`${baseDir}/${projectKey}/segments`)) {
      if (entry.isFile && entry.name.endsWith(".json")) {
        envs.push(entry.name.slice(0, -".json".length));
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  return envs.sort();
};

/**
 * Finds flag and segment keys in a source's extracted data that also appear in
 * earlier sources merged into the same destination.
 * Segments are compared per environment; a missing segment file counts as no segments.
 * @throws Error if any source's flags.json has not been extracted
 */
export async function findMergeCollisions(
  currentSource: string,
  earlierSources: string[],
  baseDir: string = SOURCE_DATA_DIR,
): Promise<MergeCollisions> {
  const currentFlags = new Set(await loadFlagKeys(baseDir, currentSource));
  const flagOverlap = new Set<string>();
  for (const earlier of earlierSources) {
    for (const key of await loadFlagKeys(baseDir, earlier)) {
      if (currentFlags.has(key)) flagOverlap.add(key);
    }
  }

  const segments: Record<string, string[]> = {};
  for (const env of await listSegmentEnvs(baseDir, currentSource)) {
    const current = new Set(
      extractKeys(
        await readJsonFile(`${baseDir}/${currentSource}/segments/${env}.json`),
      ),
    );
    const overlap = new Set<string>();
    for (const earlier of earlierSources) {
      const keys = extractKeys(
        await readJsonFile(`${baseDir}/${earlier}/segments/${env}.json`),
      );
      for (const key of keys) {
        if (current.has(key)) overlap.add(key);
      }
    }
    if (overlap.size > 0) {
      segments[env] = [...overlap].sort();
    }
  }

  return { flags: [...flagOverlap].sort(), segments };
}

/** True when findMergeCollisions found any overlapping key. */
export function hasMergeCollisions(collisions: MergeCollisions): boolean {
  return collisions.flags.length > 0 ||
    Object.keys(collisions.segments).length > 0;
}

export function isAccountLevelStep(step: string): boolean {
  return ACCOUNT_LEVEL_STEPS.has(step);
}

export function isProjectLevelStep(step: string): boolean {
  return PROJECT_LEVEL_STEPS.has(step);
}

/** Split workflow steps into account-level and project-level lists (preserves order within each). */
export function partitionWorkflowSteps(steps: string[]): {
  accountSteps: string[];
  projectSteps: string[];
  unknownSteps: string[];
} {
  const accountSteps: string[] = [];
  const projectSteps: string[] = [];
  const unknownSteps: string[] = [];

  for (const step of steps) {
    if (isAccountLevelStep(step)) {
      accountSteps.push(step);
    } else if (isProjectLevelStep(step)) {
      projectSteps.push(step);
    } else {
      unknownSteps.push(step);
    }
  }

  return { accountSteps, projectSteps, unknownSteps };
}
