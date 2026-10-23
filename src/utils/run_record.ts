/**
 * The run record `migrate` writes after every run, dry runs included:
 *   data/launchdarkly-migrations/runs/<startedAt>-<sourceProject>-<destProject>.json
 *   data/launchdarkly-migrations/runs/latest-<sourceProject>-<destProject>.json (a copy of the newest)
 *
 * Unlike the sync manifest (the cumulative inventory of what the migration owns), a run record
 * describes one run: when it ran, in which mode and scope, what it wrote, which destination edits it
 * left alone, and how it ended. Other tools (the project sync check) read it to show the last sync and
 * to tell expected differences from drift; the format is versioned by `schemaVersion`.
 */

import { MIGRATION_DATA_DIR } from "./sync_manifest.ts";

export const RUN_RECORD_SCHEMA_VERSION = 1;

export type RunMode =
  | "full"
  | "incremental"
  | "targeted"
  | "since"
  | "dry-run";

/** A destination resource the run did not write because it was edited or deleted there after the migration. */
export interface ProtectedResource {
  kind: "flag" | "segment";
  /** Source key */
  key: string;
  /** Destination key */
  destKey: string;
  /** "flag": flag-level fields; "environment": one environment's targeting; "deleted": the copy is gone */
  scope: "flag" | "environment" | "deleted";
  /** Destination environment (environment scope, segments) */
  env?: string;
  /** The source changed too: the run would have written it (a conflict to resolve in the destination) */
  sourceChanged: boolean;
}

export interface RunRecord {
  schemaVersion: number;
  startedAt: string;
  finishedAt: string;
  toolVersion: string;
  configFile: string | null;
  mode: RunMode;
  dryRun: boolean;
  /** The run stopped early (abort or phase failure); the reason */
  incomplete?: string;
  source: { projectKey: string };
  destination: { projectKey: string; domain: string };
  /** Source environment -> destination environment, for the environments this run migrated */
  envMap: Record<string, string>;
  filters: {
    includeFlags?: string[];
    excludeFlags?: string[];
    since?: string;
    migrateSegments: boolean;
  };
  counts: {
    flagsInScope: number;
    flagsSkippedUnchanged: number;
    environmentsSkippedUnchanged: number;
    segmentsSkippedUnchanged: number;
    flagsArchivedInSource: number;
    protected: number;
    conflicts: number;
    flagErrors: number;
    segmentErrors: number;
    approvalRequests: number;
  };
  /** Destination edits left alone; `conflicts` is the subset where the source changed too */
  protected: ProtectedResource[];
  conflicts: ProtectedResource[];
  errors: {
    flags: Array<{ key: string; detail?: string }>;
    segments: string[];
    reconciliation: string[];
  };
  /** Keys compared after the run; null for dry runs or when it did not run */
  reconciliation: {
    flags: {
      expected: number;
      destination: number;
      missing: string[];
      extra: string[];
    } | null;
    segments: Array<
      {
        sourceEnv: string;
        destEnv: string;
        expected: number;
        destination: number;
        missing: string[];
      }
    >;
  };
  exitCode: number;
  manifestPath: string;
  manifestWritten: boolean;
}

export function runMode(args: {
  dryRun?: boolean;
  incremental?: boolean;
  since?: string;
  includeFlags?: string;
  excludeFlags?: string;
}): RunMode {
  if (args.dryRun) return "dry-run";
  if (args.includeFlags || args.excludeFlags) return "targeted";
  if (args.since) return "since";
  return args.incremental ? "incremental" : "full";
}

/** A timestamp usable in a file name on every platform (no colons). */
const fileStamp = (iso: string): string => iso.replace(/[:.]/g, "-");

export function runRecordPaths(
  startedAt: string,
  sourceProject: string,
  destProject: string,
  baseDir: string = MIGRATION_DATA_DIR,
): { path: string; latestPath: string } {
  const dir = `${baseDir}/runs`;
  return {
    path: `${dir}/${fileStamp(startedAt)}-${sourceProject}-${destProject}.json`,
    latestPath: `${dir}/latest-${sourceProject}-${destProject}.json`,
  };
}

/** Writes the record and the latest copy; returns the record's path. */
export async function writeRunRecord(
  record: RunRecord,
  baseDir: string = MIGRATION_DATA_DIR,
): Promise<string> {
  const { path, latestPath } = runRecordPaths(
    record.startedAt,
    record.source.projectKey,
    record.destination.projectKey,
    baseDir,
  );
  await Deno.mkdir(`${baseDir}/runs`, { recursive: true });
  const text = JSON.stringify(record, null, 2);
  await Deno.writeTextFile(path, text);
  await Deno.writeTextFile(latestPath, text);
  return path;
}
