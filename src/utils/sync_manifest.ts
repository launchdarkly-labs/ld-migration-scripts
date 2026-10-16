/**
 * The sync manifest `migrate` writes after every real run:
 *   data/launchdarkly-migrations/sync-manifest-<sourceProject>-<destProject>.json
 *
 * It records the source versions of the migrated flags and segments (used by --incremental) and,
 * for every resource whose destination key differs from its source key (conflict prefix), that
 * destination key. Later runs and the revert tool use those keys to find the migrated copies.
 *
 * The manifest is cumulative: a run rewrites the entries of the resources it attempted and keeps
 * the entries of resources outside its scope (include/exclude filters, --since, unselected
 * environments, migrateSegments: false). A resource whose write failed gets no entry, so the
 * next --incremental run retries it. A dry run never writes a manifest.
 */

export const MIGRATION_DATA_DIR = "./data/launchdarkly-migrations";

export interface SyncManifestEnv {
  version: number;
  lastModified?: string;
}

export interface SyncManifestFlag {
  version: number;
  lastModified?: string;
  environments: Record<string, SyncManifestEnv>;
  /** Destination key, if it differs from the source key (e.g. conflict prefix) */
  destKey?: string;
}

export interface SyncManifestSegment {
  version: number;
  lastModified?: number;
  /** Destination key in this environment, if it differs from the source key (e.g. conflict prefix) */
  destKey?: string;
}

export interface SyncManifest {
  lastSyncTimestamp: string;
  sourceProject: string;
  destProject: string;
  flags: Record<string, SyncManifestFlag>;
  /** segments[sourceEnvKey][segmentKey] */
  segments?: Record<string, Record<string, SyncManifestSegment>>;
  /**
   * Set when the writing run stopped early (--on-conflict abort): writes that were still in flight
   * have no entry, so the inventory is not exhaustive. Cleared by a later run that completes without
   * flag-scope filters (includeFlags, excludeFlags, --since), without failed writes, and without
   * skipping or prefix-renaming an existing resource that has no entry (it may be the aborted run's
   * unrecorded write); see retainIncompleteMarker.
   */
  incomplete?: IncompleteMarker;
}

export interface IncompleteMarker {
  reason: string;
  at: string;
  /**
   * Destination resources that exist but that no entry maps to, found by later runs as conflicts on
   * keys without an entry (skipped or prefix-renamed): each may be the aborted run's unrecorded write.
   * Flags by destination key; segments as "<sourceEnv>/<destinationKey>". The marker is cleared only
   * once an entry maps to every one of them (for example after a run that overwrites them).
   */
  unresolved?: { flags: string[]; segments: string[] };
}

export function syncManifestPath(
  sourceProject: string,
  destProject: string,
  baseDir: string = MIGRATION_DATA_DIR,
): string {
  return `${baseDir}/sync-manifest-${sourceProject}-${destProject}.json`;
}

/**
 * Reads the manifest for a source/destination pair, or returns null when none exists.
 * @throws Error when the file exists but cannot be read or parsed, or records a different project
 *   pair (keys containing "-" can share a file name: a-b -> c and a -> b-c both map to a-b-c)
 */
export async function readSyncManifest(
  sourceProject: string,
  destProject: string,
  baseDir: string = MIGRATION_DATA_DIR,
): Promise<SyncManifest | null> {
  const path = syncManifestPath(sourceProject, destProject, baseDir);
  let manifest: SyncManifest;
  try {
    manifest = JSON.parse(await Deno.readTextFile(path)) as SyncManifest;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw new Error(
      `Could not read sync manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifest.sourceProject !== sourceProject || manifest.destProject !== destProject) {
    throw new Error(
      `Sync manifest ${path} records ${manifest.sourceProject} -> ${manifest.destProject}, ` +
        `not ${sourceProject} -> ${destProject}; refusing to use its keys`,
    );
  }
  return manifest;
}

/**
 * Throws when the manifest is marked incomplete: revert must not treat it as the full inventory of what
 * the migration wrote, since a flag created just before the abort may have no entry.
 */
export function assertManifestComplete(manifest: SyncManifest, path: string): void {
  const marker = manifest.incomplete;
  if (!marker) return;
  const untracked = [...(marker.unresolved?.flags ?? []), ...(marker.unresolved?.segments ?? [])];
  throw new Error(
    `Sync manifest ${path} is marked incomplete (${marker.reason}, at ${marker.at}): ` +
      `a migrate run stopped before recording all of its writes` +
      (untracked.length > 0 ? `; untracked destination resources: ${untracked.join(", ")}` : "") +
      `. Re-run the migration without includeFlags, excludeFlags or --since and let it complete cleanly (no failed ` +
      `writes), overwriting or recording the untracked resources, or revert with --no-use-source-data after ` +
      `checking the flags by hand.`,
  );
}

/** What a completed run did that bears on whether an earlier abort's inventory gap can be considered closed. */
export interface RunOutcome {
  /** includeFlags, excludeFlags or --since left flags unattempted */
  flagScopeFiltered: boolean;
  /** Some flag or segment write failed */
  failedWrites: boolean;
  /** Source flag keys whose destination copy already existed and was skipped or prefix-renamed */
  conflictedFlags: Iterable<string>;
  /** "<sourceEnv>/<segmentKey>" of segments whose destination copy already existed and was skipped or prefix-renamed */
  conflictedSegments: Iterable<string>;
}

/** The flag and segment entries a run is about to write. */
export type ManifestEntries = Pick<SyncManifest, "flags" | "segments">;

const mapsTo = (entries: Record<string, { destKey?: string }> | undefined, destKey: string): boolean =>
  Object.entries(entries ?? {}).some(([key, entry]) => (entry.destKey ?? key) === destKey);

const splitSegmentId = (id: string): [string, string] => {
  const slash = id.indexOf("/");
  return [id.slice(0, slash), id.slice(slash + 1)];
};

/**
 * The `incomplete` marker a run must keep from the previous manifest, or undefined when the run may
 * clear it. The aborted run's writes that finished without an entry surface later as conflicts on
 * keys the manifest does not map to; skipping or prefix-renaming them leaves the existing copy
 * untracked, so its destination key is recorded in the marker and persists across runs. The marker
 * is cleared only by a run without flag-scope filters or failed writes, once an entry in `next` maps
 * to every recorded destination key (an overwrite records it; an unchanged incremental retry does not).
 */
export function retainIncompleteMarker(
  previous: SyncManifest | null,
  run: RunOutcome,
  next: ManifestEntries,
): IncompleteMarker | undefined {
  const marker = previous?.incomplete;
  if (!marker) return undefined;
  const prevFlags = previous!.flags ?? {};
  const prevSegments = previous!.segments ?? {};
  // A conflict on a key with no entry reveals an untracked destination copy under that key
  const flags = new Set(marker.unresolved?.flags ?? []);
  for (const key of run.conflictedFlags) {
    if (!Object.hasOwn(prevFlags, key)) flags.add(key);
  }
  const segments = new Set(marker.unresolved?.segments ?? []);
  for (const id of run.conflictedSegments) {
    const [env, key] = splitSegmentId(id);
    if (!Object.hasOwn(prevSegments, env) || !Object.hasOwn(prevSegments[env], key)) segments.add(id);
  }
  // Reconciled once some entry maps to the destination key
  const unresolvedFlags = [...flags].filter((key) => !mapsTo(next.flags, key)).sort();
  const unresolvedSegments = [...segments].filter((id) => {
    const [env, key] = splitSegmentId(id);
    return !mapsTo(next.segments?.[env], key);
  }).sort();
  const unresolved = unresolvedFlags.length > 0 || unresolvedSegments.length > 0
    ? { flags: unresolvedFlags, segments: unresolvedSegments }
    : undefined;
  if (!run.flagScopeFiltered && !run.failedWrites && !unresolved) return undefined;
  const { unresolved: _previous, ...rest } = marker;
  return unresolved ? { ...rest, unresolved } : rest;
}

/** Destination keys of the flags a manifest records: the destKey when the flag was renamed, else the source key. */
export function manifestDestinationFlagKeys(manifest: SyncManifest): string[] {
  return Object.entries(manifest.flags).map(([key, entry]) => entry.destKey ?? key);
}
