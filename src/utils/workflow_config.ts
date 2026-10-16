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
    includeArchived?: boolean;
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
    tags?: string[] | null;
    migrateBigSegments?: boolean;
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
    /** false: views are neither extracted nor recreated/linked (targetView still applies) */
    migrateViews?: boolean;
    /** Record the resources an incomplete sync manifest lists as untracked as this migration's copies */
    adoptUnresolved?: boolean;
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
      destination: Object.hasOwn(mapping, key) ? mapping[key] : key,
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
  /** Destination environment key -> overlapping segment keys */
  segments: Record<string, string[]>;
}

/** Which of a source's extracted resources the migrate step actually writes. */
export interface MergeSelection {
  includeFlags?: string[];
  excludeFlags?: string[];
  /** false: segments are not migrated, so they cannot collide */
  migrateSegments?: boolean;
  /** Source environment keys to migrate (unset: all) */
  environments?: string[];
  /** Source env key -> destination env key; when set, only mapped source environments migrate */
  environmentMapping?: Record<string, string>;
}

/** The migrate step's resource selection; the workflow passes the same one to every project. */
export function mergeSelectionFromConfig(
  config: WorkflowConfig,
): MergeSelection {
  const m = config.migration ?? {};
  // Same normalization as the migrate step applies to the comma-joined CLI values: trimmed, blanks dropped
  const list = (values?: unknown[]): string[] | undefined => {
    const out = (values ?? []).map((v) => String(v).trim()).filter(Boolean);
    return out.length > 0 ? out : undefined;
  };
  const mapping = Object.fromEntries(
    Object.entries(m.environmentMapping ?? {})
      .map(([k, v]) => [k.trim(), String(v).trim()])
      .filter(([k, v]) => k && v),
  );
  return {
    includeFlags: list(m.includeFlags),
    excludeFlags: list(m.excludeFlags),
    migrateSegments: m.migrateSegments,
    environments: list(m.environments),
    environmentMapping: Object.keys(mapping).length > 0 ? mapping : undefined,
  };
}

export type ConflictPolicy =
  | "prompt"
  | "skip"
  | "overwrite"
  | "prefix"
  | "abort";

/**
 * The conflict policy the migrate step will apply for this config: migration.onConflict,
 * else `prefix` when migration.conflictPrefix is set, else `overwrite` (mirrors migrate's default).
 */
export function effectiveConflictPolicy(
  config: WorkflowConfig,
): { policy: ConflictPolicy; prefix?: string } {
  const prefix = coerceProjectKey(config.migration?.conflictPrefix);
  const policy = (config.migration?.onConflict as ConflictPolicy | undefined) ??
    (prefix ? "prefix" : "overwrite");
  return { policy, prefix };
}

/** Keys one source contributes to a merged destination: flags, and segments per destination environment. */
export interface MergeKeys {
  flags: string[];
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

/**
 * Source environment keys that have extracted segments, in the order migrate processes them
 * (project.json order, which decides which duplicate write gets the prefix); sorted when project.json is absent.
 */
const listSegmentEnvs = async (
  baseDir: string,
  projectKey: string,
): Promise<string[]> => {
  const envs: string[] = [];
  try {
    for await (
      const entry of Deno.readDir(`${baseDir}/${projectKey}/segments`)
    ) {
      if (entry.isFile && entry.name.endsWith(".json")) {
        envs.push(entry.name.slice(0, -".json".length));
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  const project = await readJsonFile(`${baseDir}/${projectKey}/project.json`) as
    | { environments?: { items?: Array<{ key?: unknown }> } }
    | undefined;
  const order = new Map(
    (project?.environments?.items ?? [])
      .map((e) => e.key)
      .filter((k): k is string => typeof k === "string")
      .map((k, i) => [k, i] as const),
  );
  const rank = (env: string) => order.get(env) ?? order.size;
  return envs.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
};

/** Own-property lookup: an environment key such as "constructor" must not resolve to an inherited member. */
const ownList = (record: Record<string, string[]>, key: string): string[] =>
  Object.hasOwn(record, key) ? record[key] : [];

/** Own-property write: an environment key such as "__proto__" must become a data property, not set the prototype. */
const setOwn = (
  record: Record<string, string[]>,
  key: string,
  value: string[],
): void => {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
};

const selectFlagKeys = (
  keys: string[],
  selection: MergeSelection,
): string[] => {
  const include = selection.includeFlags
    ? new Set(selection.includeFlags)
    : undefined;
  const exclude = new Set(selection.excludeFlags ?? []);
  return keys.filter((k) => (!include || include.has(k)) && !exclude.has(k));
};

/** Destination environment a source environment migrates to, or undefined when it is not migrated. */
const destinationEnv = (
  env: string,
  selection: MergeSelection,
): string | undefined => {
  if (selection.environments && !selection.environments.includes(env)) {
    return undefined;
  }
  if (selection.environmentMapping) {
    return Object.hasOwn(selection.environmentMapping, env)
      ? selection.environmentMapping[env]
      : undefined;
  }
  return env;
};

/**
 * Loads the flag and segment keys of one extracted source that the migrate step would write
 * under `selection`. Segments are grouped by destination environment; a missing segment
 * file counts as no segments.
 * @throws Error if the source's flags.json has not been extracted
 */
export async function loadMergeKeys(
  source: string,
  baseDir: string = SOURCE_DATA_DIR,
  selection: MergeSelection = {},
): Promise<MergeKeys> {
  const flags = selectFlagKeys(await loadFlagKeys(baseDir, source), selection);
  const segments: Record<string, string[]> = {};
  if (selection.migrateSegments !== false) {
    for (const env of await listSegmentEnvs(baseDir, source)) {
      const destEnv = destinationEnv(env, selection);
      if (!destEnv) continue;
      const keys = extractKeys(
        await readJsonFile(`${baseDir}/${source}/segments/${env}.json`),
      );
      // Keep duplicates: a segment in two source environments mapped to one destination environment is
      // written twice, and the second write collides with the first
      setOwn(segments, destEnv, [...ownList(segments, destEnv), ...keys]);
    }
  }
  return { flags, segments };
}

const perEnvironment = (
  current: MergeKeys,
  earlier: MergeKeys[],
  pick: (keys: string[], others: string[][]) => string[],
): MergeCollisions => {
  const segments: Record<string, string[]> = {};
  for (const [env, keys] of Object.entries(current.segments)) {
    const found = pick(keys, earlier.map((e) => ownList(e.segments, env)));
    if (found.length > 0) setOwn(segments, env, found);
  }
  return { flags: pick(current.flags, earlier.map((e) => e.flags)), segments };
};

/**
 * Keys of `current` that at least one of `earlier` also has: what the migrate step 409s on under
 * overwrite, skip, prompt and abort, where earlier sources hold their raw keys.
 */
export function computeMergeCollisions(
  current: MergeKeys,
  earlier: MergeKeys[],
): MergeCollisions {
  return perEnvironment(current, earlier, (keys, others) => {
    const own = new Set(keys);
    return [...new Set(others.flat().filter((k) => own.has(k)))].sort();
  });
}

export interface PrefixedMerge {
  /** Keys of `current` whose first create would 409 and be retried with the prefix */
  collisions: MergeCollisions;
  /** Collisions whose prefixed retry would 409 as well, so the migrate step would overwrite that resource */
  unresolvable: MergeCollisions;
}

/**
 * Replays the earlier sources' writes under `onConflict: prefix` to find the keys they actually hold
 * in the destination (a key already taken is written as prefix + key, so prefixed copies count), then
 * checks every write of `current`, in order, against them. Duplicate writes matter: a segment present
 * in two source environments that map to one destination environment is written twice, the second
 * time with the prefix. A `current` key whose prefixed form is also one of its own keys is reported as
 * unresolvable, since which of the two is written first depends on migration order.
 */
export function simulatePrefixedMerge(
  current: MergeKeys,
  earlier: MergeKeys[],
  prefix: string,
): PrefixedMerge {
  const replay = (keys: string[], others: string[][]) => {
    const taken = new Set<string>();
    for (const list of others) {
      for (const k of list) taken.add(taken.has(k) ? prefix + k : k);
    }
    const own = new Set(keys);
    const collisions = new Set<string>();
    const unresolvable = new Set<string>();
    for (const k of keys) {
      if (!taken.has(k)) {
        taken.add(k);
        continue;
      }
      collisions.add(k);
      if (taken.has(prefix + k) || own.has(prefix + k)) {
        unresolvable.add(k);
      } else {
        taken.add(prefix + k);
      }
    }
    return {
      collisions: [...collisions].sort(),
      unresolvable: [...unresolvable].sort(),
    };
  };
  return {
    collisions: perEnvironment(
      current,
      earlier,
      (k, o) => replay(k, o).collisions,
    ),
    unresolvable: perEnvironment(
      current,
      earlier,
      (k, o) => replay(k, o).unresolvable,
    ),
  };
}

/** The unresolvable part of simulatePrefixedMerge. */
export function computePrefixedMergeCollisions(
  current: MergeKeys,
  earlier: MergeKeys[],
  prefix: string,
): MergeCollisions {
  return simulatePrefixedMerge(current, earlier, prefix).unresolvable;
}

/**
 * Finds flag and segment keys in a source's extracted data that also appear in
 * earlier sources merged into the same destination, among the resources `selection` migrates.
 * @throws Error if any source's flags.json has not been extracted
 */
export async function findMergeCollisions(
  currentSource: string,
  earlierSources: string[],
  baseDir: string = SOURCE_DATA_DIR,
  selection: MergeSelection = {},
): Promise<MergeCollisions> {
  const current = await loadMergeKeys(currentSource, baseDir, selection);
  const earlier: MergeKeys[] = [];
  for (const source of earlierSources) {
    earlier.push(await loadMergeKeys(source, baseDir, selection));
  }
  return computeMergeCollisions(current, earlier);
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
