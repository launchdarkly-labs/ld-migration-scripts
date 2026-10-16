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
   * conflict-skipping a resource that has no entry (it may be the aborted run's unrecorded write).
   */
  incomplete?: { reason: string; at: string };
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
  if (!manifest.incomplete) return;
  throw new Error(
    `Sync manifest ${path} is marked incomplete (${manifest.incomplete.reason}, at ${manifest.incomplete.at}): ` +
      `a migrate run stopped before recording all of its writes. Re-run the migration without includeFlags, ` +
      `excludeFlags or --since and let it complete cleanly (no failed writes, no conflict-skipped resources missing ` +
      `from the manifest), or revert with --no-use-source-data after checking the flags by hand.`,
  );
}

/** Destination keys of the flags a manifest records: the destKey when the flag was renamed, else the source key. */
export function manifestDestinationFlagKeys(manifest: SyncManifest): string[] {
  return Object.entries(manifest.flags).map(([key, entry]) => entry.destKey ?? key);
}
