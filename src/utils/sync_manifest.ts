/**
 * The sync manifest `migrate` writes after every real run:
 *   data/launchdarkly-migrations/sync-manifest-<sourceProject>-<destProject>.json
 *
 * It records the source versions of the migrated flags and segments (used by --incremental) and,
 * for every resource whose destination key differs from its source key (conflict prefix), that
 * destination key. Later runs and the revert tool use those keys to find the migrated copies.
 * A dry run never writes a manifest.
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
 * @throws Error when the file exists but cannot be read or parsed
 */
export async function readSyncManifest(
  sourceProject: string,
  destProject: string,
  baseDir: string = MIGRATION_DATA_DIR,
): Promise<SyncManifest | null> {
  try {
    return JSON.parse(
      await Deno.readTextFile(syncManifestPath(sourceProject, destProject, baseDir)),
    ) as SyncManifest;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

/** Destination keys of the flags a manifest records: the destKey when the flag was renamed, else the source key. */
export function manifestDestinationFlagKeys(manifest: SyncManifest): string[] {
  return Object.entries(manifest.flags).map(([key, entry]) => entry.destKey ?? key);
}
