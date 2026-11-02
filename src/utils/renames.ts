/**
 * Rename map: gives migrated flags new destination keys and names. Segments are not renamed.
 *
 * The map is a CSV people review (often proposed by `propose-renames`). Only these columns are read:
 *   type,key,new_key,new_name
 * `type` is flag, `key` the source flag key. An empty new_key / new_name keeps the source value.
 * Other columns (name, description, note, ...) are context for reviewers and ignored here.
 */

import { parse as parseCsv } from "https://deno.land/std@0.224.0/csv/mod.ts";
import { isValidResourceKey } from "./keys.ts";

export type RenameType = "flag";

export interface RenameRow {
  type: RenameType;
  key: string;
  newKey?: string;
  newName?: string;
  /** 1-based line in the file (header = 1) */
  line: number;
}

export interface Rename {
  key?: string;
  name?: string;
  line: number;
}

export interface RenameMap {
  path: string;
  flags: Map<string, Rename>;
}

export type RenameIssueCode =
  | "BAD_HEADER"
  | "BAD_TYPE"
  | "EMPTY_KEY"
  | "INVALID_KEY"
  | "DUPLICATE_ROW"
  | "DUPLICATE_NEW_KEY"
  | "NEW_KEY_IS_SOURCE_KEY"
  | "UNKNOWN_SOURCE_KEY"
  | "MANIFEST_MISMATCH"
  | "DEST_EXISTS_FOREIGN"
  | "DEST_OWNED_BY_OTHER"
  | "DEST_UNRESOLVED"
  | "CHAIN_OR_SWAP"
  | "PREFIX_COMBINATION";

export interface RenameIssue {
  severity: "error" | "warning";
  code: RenameIssueCode;
  type?: RenameType;
  key?: string;
  line?: number;
  message: string;
}

const REQUIRED_COLUMNS = ["type", "key"] as const;

const issue = (
  severity: RenameIssue["severity"],
  code: RenameIssueCode,
  message: string,
  extra: Partial<RenameIssue> = {},
): RenameIssue => ({ severity, code, message, ...extra });

export const hasErrors = (issues: RenameIssue[]): boolean =>
  issues.some((i) => i.severity === "error");

/** Parses the CSV text into rows; a row with neither new_key nor new_name (or new_key = key) only renames what it sets. */
export function parseRenameCsv(
  text: string,
): { rows: RenameRow[]; issues: RenameIssue[] } {
  const issues: RenameIssue[] = [];
  const records = parseCsv(text.replace(/^﻿/, "")) as string[][];
  if (records.length === 0) {
    return {
      rows: [],
      issues: [
        issue("error", "BAD_HEADER", "The rename map is empty (no header row)"),
      ],
    };
  }
  const header = records[0].map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return {
      rows: [],
      issues: [
        issue(
          "error",
          "BAD_HEADER",
          `The header row is missing column(s): ${missing.join(", ")}`,
        ),
      ],
    };
  }
  const col = (name: string) => header.indexOf(name);
  const get = (record: string[], name: string) => {
    const i = col(name);
    const value = i >= 0 ? (record[i] ?? "").trim() : "";
    return value === "" ? undefined : value;
  };

  const rows: RenameRow[] = [];
  records.slice(1).forEach((record, index) => {
    const line = index + 2;
    if (record.every((cell) => cell.trim() === "")) return;
    const type = get(record, "type")?.toLowerCase();
    const key = get(record, "key");
    if (type !== "flag") {
      issues.push(
        issue(
          "error",
          "BAD_TYPE",
          type === "segment"
            ? `segments are not renamed; remove this row (only "flag" rows are allowed)`
            : `type must be "flag", got "${type ?? ""}"`,
          { line },
        ),
      );
      return;
    }
    if (!key) {
      issues.push(issue("error", "EMPTY_KEY", "key is empty", { type, line }));
      return;
    }
    const newKey = get(record, "new_key");
    rows.push({
      type,
      key,
      newKey: newKey === key ? undefined : newKey,
      newName: get(record, "new_name"),
      line,
    });
  });
  return { rows, issues };
}

/** Groups rows by source key; a repeated key is an error. */
export function buildRenameMap(
  rows: RenameRow[],
  path: string,
): { map: RenameMap; issues: RenameIssue[] } {
  const map: RenameMap = { path, flags: new Map() };
  const issues: RenameIssue[] = [];
  for (const row of rows) {
    const rename: Rename = {
      key: row.newKey,
      name: row.newName,
      line: row.line,
    };
    if (!rename.key && !rename.name) continue;
    const prev = map.flags.get(row.key);
    if (prev) {
      issues.push(
        issue(
          "error",
          "DUPLICATE_ROW",
          `flag ${row.key} is listed again (first on line ${prev.line})`,
          { type: "flag", key: row.key, line: row.line },
        ),
      );
      continue;
    }
    map.flags.set(row.key, rename);
  }
  return { map, issues };
}

export async function loadRenameMap(
  path: string,
): Promise<{ map: RenameMap; issues: RenameIssue[] }> {
  const { rows, issues } = parseRenameCsv(await Deno.readTextFile(path));
  const built = buildRenameMap(rows, path);
  return { map: built.map, issues: [...issues, ...built.issues] };
}

export interface SourceInventory {
  /** Every extracted flag key (unfiltered), so filtered runs validate the same as full runs */
  flagKeys: string[];
}

/** Checks the map against the extracted source alone: key format, duplicates, collisions with other source keys, chains. */
export function validateRenameMapStatic(
  map: RenameMap,
  inv: SourceInventory,
): RenameIssue[] {
  const issues: RenameIssue[] = [];
  const flagSet = new Set(inv.flagKeys);

  // Flags
  const flagDest = new Map<string, string>(); // destination key -> source key
  for (const key of inv.flagKeys) {
    flagDest.set(map.flags.get(key)?.key ?? key, key);
  }
  for (const [key, rename] of map.flags) {
    if (!flagSet.has(key)) {
      issues.push(
        issue(
          "warning",
          "UNKNOWN_SOURCE_KEY",
          `flag ${key} is not in the extracted source data`,
          {
            type: "flag",
            key,
            line: rename.line,
          },
        ),
      );
    }
    if (!rename.key) continue;
    if (!isValidResourceKey(rename.key)) {
      issues.push(
        issue(
          "error",
          "INVALID_KEY",
          `flag ${key}: new key "${rename.key}" is not a valid key`,
          {
            type: "flag",
            key,
            line: rename.line,
          },
        ),
      );
    }
  }
  const flagTargets = new Map<string, string[]>();
  for (const key of inv.flagKeys) {
    const dest = map.flags.get(key)?.key ?? key;
    flagTargets.set(dest, [...(flagTargets.get(dest) ?? []), key]);
  }
  for (const [dest, sources] of flagTargets) {
    if (sources.length < 2) continue;
    const renamed = sources.filter((s) => map.flags.get(s)?.key === dest);
    const kept = sources.filter((s) => s === dest && !map.flags.get(s)?.key);
    const code = kept.length > 0
      ? "NEW_KEY_IS_SOURCE_KEY"
      : "DUPLICATE_NEW_KEY";
    issues.push(issue(
      "error",
      code,
      code === "NEW_KEY_IS_SOURCE_KEY"
        ? `flag key "${dest}" is wanted by ${
          renamed.join(", ")
        } but source flag ${dest} keeps it; rename ${dest} too or pick another key`
        : `flags ${sources.join(", ")} all map to "${dest}"`,
      {
        type: "flag",
        key: dest,
        line: renamed.map((s) => map.flags.get(s)?.line).find((l) =>
          l !== undefined
        ),
      },
    ));
  }
  for (const [key, rename] of map.flags) {
    if (
      rename.key && flagSet.has(rename.key) && map.flags.get(rename.key)?.key
    ) {
      issues.push(issue(
        "warning",
        "CHAIN_OR_SWAP",
        `flag ${key} takes key "${rename.key}", which source flag ${rename.key} gives up: SDK calls for "${rename.key}" will get a different flag`,
        { type: "flag", key, line: rename.line },
      ));
    }
  }

  return issues;
}

type ManifestFlagEntry = { destKey?: string };

export interface ManifestView {
  flags?: Record<string, ManifestFlagEntry>;
}

/**
 * A copy already migrated keeps its recorded key. A map that now says otherwise (or drops the row of an
 * item it renamed earlier) would orphan that copy, so it is an error.
 */
export function validateRenameMapAgainstManifest(
  map: RenameMap,
  manifest: ManifestView | undefined,
  inv: SourceInventory,
): RenameIssue[] {
  if (!manifest) return [];
  const issues: RenameIssue[] = [];
  for (const key of inv.flagKeys) {
    const entry = manifest.flags?.[key];
    if (!entry) continue;
    const recorded = entry.destKey ?? key;
    const row = map.flags.get(key);
    const wanted = row?.key ?? key;
    if (recorded !== wanted) {
      issues.push(issue(
        "error",
        "MANIFEST_MISMATCH",
        row?.key
          ? `flag ${key} was migrated as "${recorded}" but the map now says "${wanted}"; restore the map row or revert that copy first`
          // No new key in the map, e.g. a copy an earlier run renamed or gave a conflict prefix
          : `flag ${key} was migrated as "${recorded}" but the map has no new key for it; set new_key to "${recorded}" to keep that copy, or revert it first`,
        { type: "flag", key, line: row?.line },
      ));
    }
  }
  return issues;
}

export interface DestinationKeys {
  flags: Set<string>;
}

/**
 * A renamed key that already exists in the destination is only allowed when it is this item's own recorded
 * copy (a rerun), or a key an aborted run left unrecorded that the user adopts (`adopt`, --adopt-unresolved).
 * Anything else stops the run, whatever --on-conflict says.
 */
export function destinationCollisions(
  map: RenameMap,
  inv: SourceInventory,
  existing: DestinationKeys,
  manifest: ManifestView | undefined,
  unresolved: Set<string> = new Set(),
  adopt = false,
): RenameIssue[] {
  const issues: RenameIssue[] = [];
  const flagOwner = new Map<string, string>();
  for (const [key, entry] of Object.entries(manifest?.flags ?? {})) {
    flagOwner.set(entry.destKey ?? key, key);
  }
  for (const [key, rename] of map.flags) {
    if (!rename.key || !inv.flagKeys.includes(key)) continue;
    const owner = flagOwner.get(rename.key);
    if (owner === key) continue; // rerun: our own copy
    if (unresolved.has(rename.key) && owner === undefined) {
      if (adopt) continue; // --adopt-unresolved: the aborted run's copy is taken over
      issues.push(
        issue(
          "error",
          "DEST_UNRESOLVED",
          `flag ${key}: "${rename.key}" may have been created by an aborted run; rerun with --adopt-unresolved if it is ours`,
          {
            type: "flag",
            key,
            line: rename.line,
          },
        ),
      );
    } else if (owner !== undefined) {
      issues.push(
        issue(
          "error",
          "DEST_OWNED_BY_OTHER",
          `flag ${key}: "${rename.key}" is already the destination copy of source flag ${owner}`,
          {
            type: "flag",
            key,
            line: rename.line,
          },
        ),
      );
    } else if (existing.flags.has(rename.key)) {
      issues.push(
        issue(
          "error",
          "DEST_EXISTS_FOREIGN",
          `flag ${key}: "${rename.key}" already exists in the destination and was not created by this migration`,
          {
            type: "flag",
            key,
            line: rename.line,
          },
        ),
      );
    }
  }
  return issues;
}

/**
 * Source → destination flag keys and names for this run. The recorded manifest key wins (validation has already
 * checked it agrees with the map); otherwise the map; otherwise the source key.
 */
export class KeyResolver {
  private readonly flagSourceByDest = new Map<string, string>();

  constructor(
    private readonly map: RenameMap | undefined,
    private readonly manifest: ManifestView | undefined,
    flagKeys: string[] = [],
  ) {
    for (const key of flagKeys) {
      this.flagSourceByDest.set(this.flagKey(key), key);
    }
  }

  flagKey(key: string): string {
    return this.manifest?.flags?.[key]?.destKey ??
      this.map?.flags.get(key)?.key ?? key;
  }

  /** Map name, else the given fallback (the recorded or source name) */
  flagName(key: string, fallback: string): string {
    return this.map?.flags.get(key)?.name ?? fallback;
  }

  isFlagRenamed(key: string): boolean {
    return this.flagKey(key) !== key;
  }

  /** Destination flag key → source key (undefined when unknown) */
  flagSource(destKey: string): string | undefined {
    return this.flagSourceByDest.get(destKey);
  }
}

/** The manifest fields a rename map leaves on a flag entry */
export interface RenamedFlagEntry {
  destKey?: string;
  destName?: string;
  /** destKey came from a rename map (not a conflict prefix) */
  renamedByMap?: boolean;
}

/**
 * The flags a rename map renamed, from the manifest alone: lets a run without --rename-map keep
 * translating references to them. Keys from a conflict prefix are left out. Entries written before
 * `renamedByMap` existed count when they carry a destName.
 */
export function manifestRenames(
  flags: Record<string, RenamedFlagEntry> | undefined,
): ManifestView | undefined {
  const renamed: Record<string, ManifestFlagEntry> = {};
  for (const [key, entry] of Object.entries(flags ?? {})) {
    if (entry.destKey && (entry.renamedByMap || entry.destName)) {
      renamed[key] = { destKey: entry.destKey };
    }
  }
  return Object.keys(renamed).length > 0 ? { flags: renamed } : undefined;
}

/**
 * The destination name a rename map gives a flag, or undefined when none applies. With a map: its
 * new_name (an emptied new_name goes back to the source name). Without one: the name an earlier map
 * recorded.
 */
export function flagDestinationName(
  map: RenameMap | undefined,
  sourceKey: string,
  entry: RenamedFlagEntry | undefined,
): string | undefined {
  return map ? map.flags.get(sourceKey)?.name : entry?.destName;
}

/**
 * A flag's destination for this run: the recorded destination (manifest/prefix) with the rename map's
 * key and name applied. `adopted`: with --adopt-unresolved, the renamed key is one an aborted run left
 * unrecorded, to be taken over as this flag's copy if it exists.
 */
export function flagDestination(opts: {
  sourceKey: string;
  recorded: { key: string; name: string; recorded: boolean };
  map?: RenameMap;
  resolver?: KeyResolver;
  entry?: RenamedFlagEntry;
  unresolved?: readonly string[];
  adopt?: boolean;
}): { key: string; name: string; recorded: boolean; adopted: boolean } {
  const { sourceKey, recorded } = opts;
  const name = flagDestinationName(opts.map, sourceKey, opts.entry) ??
    recorded.name;
  const key = opts.resolver ? opts.resolver.flagKey(sourceKey) : recorded.key;
  const adopted = !recorded.recorded && Boolean(opts.adopt) &&
    key !== sourceKey && (opts.unresolved ?? []).includes(key);
  return { key, name, recorded: recorded.recorded, adopted };
}

/** Rewrites prerequisite flag keys to their destination keys; returns a new array. */
export function translatePrerequisites<T extends { key: string }>(
  prerequisites: T[] | undefined,
  flagKey: (key: string) => string,
): T[] | undefined {
  return prerequisites?.map((p) => ({ ...p, key: flagKey(p.key) }));
}

export function formatIssues(issues: RenameIssue[]): string[] {
  return issues.map((i) =>
    `${i.severity === "error" ? "✗" : "⚠"} [${i.code}]${
      i.line ? ` line ${i.line}:` : ""
    } ${i.message}`
  );
}

export interface RenameCheckReport {
  outcome: "stopped" | "passed";
  checkedAt: string;
  sourceProject: string;
  destinationProject: string;
  renameMap: string;
  dryRun: boolean;
  summary: { errors: number; warnings: number; byCode: Record<string, number> };
  /** What a person should do next */
  nextStep: string;
  issues: RenameIssue[];
}

/** Explains a rename-map check: why a run stopped (or that it passed), issue by issue. */
export function renameCheckReport(
  issues: RenameIssue[],
  meta: {
    sourceProject: string;
    destinationProject: string;
    renameMap: string;
    dryRun: boolean;
    checkedAt?: string;
  },
): RenameCheckReport {
  const errors = issues.filter((i) => i.severity === "error").length;
  const byCode: Record<string, number> = {};
  for (const i of issues) byCode[i.code] = (byCode[i.code] ?? 0) + 1;
  return {
    outcome: errors > 0 ? "stopped" : "passed",
    checkedAt: meta.checkedAt ?? new Date().toISOString(),
    sourceProject: meta.sourceProject,
    destinationProject: meta.destinationProject,
    renameMap: meta.renameMap,
    dryRun: meta.dryRun,
    summary: { errors, warnings: issues.length - errors, byCode },
    nextStep: errors > 0
      ? "Nothing was written. Fix each error row in the rename map (or the destination resource it collides with) and run again."
      : "The rename map was accepted; the migration continued.",
    issues: [...issues].sort((a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) ||
      (a.line ?? 0) - (b.line ?? 0)
    ),
  };
}

/** The report's issues as CSV rows, to read next to the rename map */
export function renameCheckReportCsvRows(
  report: RenameCheckReport,
): Record<string, string>[] {
  return report.issues.map((i) => ({
    severity: i.severity,
    code: i.code,
    line: i.line?.toString() ?? "",
    type: i.type ?? "",
    key: i.key ?? "",
    message: i.message,
  }));
}
