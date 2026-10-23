/**
 * Protection of changes made in the destination after the migration wrote a resource.
 *
 * During a migration the source project is usually read-only for whoever runs it and goes stale once
 * teams start working in the destination. A rerun must then never revert a destination edit to the
 * older source state. After every run the manifest records, per destination copy, the state the
 * migration left it in (`dest`: version, lastModified and a fingerprint of the fields migrate writes).
 * A later run compares the copy with that record before writing:
 *
 * - a flag environment whose fingerprint changed was edited in the destination: its environment patch
 *   is skipped;
 * - a flag whose flag-level fingerprint changed, or with any environment edited, keeps its flag-level
 *   fields (name, description, tags, variations, lifecycle) as they are;
 * - a segment whose fingerprint changed is left as it is;
 * - a recorded copy that no longer exists was deleted in the destination and is not recreated.
 *
 * Once found, the resource is marked `targetOwned` in the manifest, so later runs leave it alone even
 * if the destination edit is undone. Fingerprints ignore version bumps that change nothing the
 * migration writes (view links, approvals metadata). Entries written before this version have no
 * `dest` record; for those an environment or segment counts as edited when its lastModified is after
 * the previous run's lastSyncTimestamp, and flag-level edits cannot be detected until the first run
 * on this version records a fingerprint.
 */

export interface DestEnvState {
  version?: number;
  lastModified?: number;
  fingerprint?: string;
}

/** The destination state of a flag copy as the migration left it (flag level and per destination environment). */
export interface DestFlagState {
  version?: number;
  fingerprint?: string;
  environments?: Record<string, DestEnvState>;
}

export interface DestSegmentState {
  version?: number;
  lastModified?: number;
  fingerprint?: string;
}

export interface FlagTargetOwnership {
  /** Flag-level fields were edited in the destination */
  flag?: boolean;
  /** Destination environments whose targeting was edited in the destination */
  environments?: string[];
  /** The recorded copy was deleted in the destination */
  deleted?: boolean;
}

/** The protection fields of a manifest flag entry. */
export interface FlagTargetRecord {
  dest?: DestFlagState;
  targetOwned?: FlagTargetOwnership;
  /** Destination environments with a pending approval request from the migration: re-baselined next run */
  awaitingApproval?: string[];
}

/** The protection fields of a manifest segment entry. */
export interface SegmentTargetRecord {
  dest?: DestSegmentState;
  /** Edited ("edited") or deleted ("deleted") in the destination after the migration wrote it */
  targetOwned?: "edited" | "deleted";
}

export interface FlagTargetEdits {
  flagLevel: boolean;
  /** Destination environment keys */
  environments: string[];
  deleted: boolean;
}

export const NO_FLAG_EDITS: FlagTargetEdits = {
  flagLevel: false,
  environments: [],
  deleted: false,
};

const FLAG_LEVEL_FIELDS = [
  "name",
  "description",
  "tags",
  "temporary",
  "variations",
  "defaults",
  "clientSideAvailability",
  "customProperties",
  "archived",
  "deprecated",
] as const;

const FLAG_ENV_FIELDS = [
  "on",
  "offVariation",
  "fallthrough",
  "rules",
  "targets",
  "contextTargets",
  "prerequisites",
  "trackEvents",
  "trackEventsFallthrough",
] as const;

const SEGMENT_FIELDS = [
  "name",
  "description",
  "tags",
  "included",
  "excluded",
  "includedContexts",
  "excludedContexts",
  "rules",
  "unbounded",
  "unboundedContextKind",
] as const;

/** JSON with object keys sorted and `_id` keys dropped (generated IDs are not content), so equal content gives equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k, v]) => k !== "_id" && v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${
      entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")
    }}`;
  }
  return JSON.stringify(value ?? null);
}

async function fingerprint(
  source: Record<string, unknown> | undefined,
  fields: readonly string[],
): Promise<string> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    let value = source?.[field];
    // Tag order carries no meaning
    if (field === "tags" && Array.isArray(value)) value = [...value].sort();
    picked[field] = value ?? null;
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(picked)),
  );
  return Array.from(
    new Uint8Array(digest).slice(0, 16),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

const asNumber = (v: unknown): number | undefined =>
  typeof v === "number"
    ? v
    : typeof v === "string" && v !== "" && !isNaN(Number(v))
    ? Number(v)
    : undefined;

/** The current state of a destination flag (as returned by GET flags/{project}/{key}) in the given destination environments. */
export async function observeFlag(
  destFlag: any,
  destEnvKeys: Iterable<string>,
): Promise<DestFlagState> {
  const environments: Record<string, DestEnvState> = Object.create(null);
  for (const env of new Set(destEnvKeys)) {
    const config = destFlag?.environments?.[env];
    if (!config) continue;
    environments[env] = {
      version: asNumber(config.version ?? config._version),
      lastModified: asNumber(config.lastModified),
      fingerprint: await fingerprint(config, FLAG_ENV_FIELDS),
    };
  }
  return {
    version: asNumber(destFlag?._version),
    fingerprint: await fingerprint(destFlag, FLAG_LEVEL_FIELDS),
    environments,
  };
}

/** The current state of a destination segment (as returned by GET segments/{project}/{env}/{key}). */
export async function observeSegment(
  destSegment: any,
): Promise<DestSegmentState> {
  return {
    version: asNumber(destSegment?.version ?? destSegment?._version),
    lastModified: asNumber(destSegment?.lastModifiedDate),
    fingerprint: await fingerprint(destSegment, SEGMENT_FIELDS),
  };
}

/**
 * What was edited in the destination since the migration last wrote this flag copy. `entry` is the
 * previous manifest entry (no entry: not this migration's copy, nothing to protect). `observed` is
 * undefined when the recorded copy no longer exists. `fallbackSince` (epoch ms, the previous run's end)
 * is used for environments without a recorded fingerprint.
 */
export function detectFlagEdits(
  entry: FlagTargetRecord | undefined,
  observed: DestFlagState | undefined,
  destEnvKeys: Iterable<string>,
  fallbackSince?: number,
): FlagTargetEdits {
  if (!entry) return NO_FLAG_EDITS;
  const owned = entry.targetOwned;
  if (owned?.deleted || !observed) {
    return { flagLevel: true, environments: [], deleted: true };
  }
  const environments: string[] = [];
  for (const env of new Set(destEnvKeys)) {
    const current = observed.environments?.[env];
    if (!current) continue;
    if (owned?.environments?.includes(env)) {
      environments.push(env);
      continue;
    }
    // Our own pending approval request may have been applied since: not an independent edit
    if (entry.awaitingApproval?.includes(env)) continue;
    const recorded = entry.dest?.environments?.[env];
    if (recorded?.fingerprint) {
      if (recorded.fingerprint !== current.fingerprint) environments.push(env);
    } else if (
      fallbackSince !== undefined && current.lastModified !== undefined &&
      current.lastModified > fallbackSince
    ) {
      environments.push(env);
    }
  }
  const flagLevel = Boolean(owned?.flag) ||
    (entry.dest?.fingerprint !== undefined &&
      entry.dest.fingerprint !== observed.fingerprint);
  return { flagLevel, environments: environments.sort(), deleted: false };
}

/** Flag-level fields are left alone when they, or any environment, were edited in the destination. */
export const protectsFlagLevel = (edits: FlagTargetEdits): boolean =>
  edits.deleted || edits.flagLevel || edits.environments.length > 0;

/**
 * The protection fields for a flag entry after this run. `observed` is the copy's state after this
 * run's writes (undefined: not read this run, the previous record is kept). Owned parts keep their
 * previous record; everything else takes the observed state, so the next run compares against what
 * this run left behind.
 */
export function nextFlagTargetRecord(
  entry: FlagTargetRecord | undefined,
  edits: FlagTargetEdits,
  observed: DestFlagState | undefined,
  awaitingApproval: readonly string[] = [],
): FlagTargetRecord {
  const ownedEnvs = [
    ...new Set([
      ...(entry?.targetOwned?.environments ?? []),
      ...edits.environments,
    ]),
  ].sort();
  const deleted = Boolean(entry?.targetOwned?.deleted) || edits.deleted;
  const ownedFlag = Boolean(entry?.targetOwned?.flag) || edits.flagLevel;
  const dest: DestFlagState = {
    ...(entry?.dest ?? {}),
    environments: { ...(entry?.dest?.environments ?? {}) },
  };
  if (observed && !deleted) {
    if (!ownedFlag) {
      dest.version = observed.version;
      dest.fingerprint = observed.fingerprint;
    }
    for (const [env, state] of Object.entries(observed.environments ?? {})) {
      if (!ownedEnvs.includes(env)) dest.environments![env] = state;
    }
  }
  const record: FlagTargetRecord = {};
  if (
    dest.fingerprint !== undefined ||
    Object.keys(dest.environments ?? {}).length > 0
  ) {
    record.dest = dest;
  }
  if (ownedFlag || ownedEnvs.length > 0 || deleted) {
    record.targetOwned = {
      ...(ownedFlag ? { flag: true } : {}),
      ...(ownedEnvs.length > 0 ? { environments: ownedEnvs } : {}),
      ...(deleted ? { deleted: true } : {}),
    };
  }
  if (awaitingApproval.length > 0) {
    record.awaitingApproval = [...new Set(awaitingApproval)].sort();
  }
  return record;
}

/**
 * Whether a segment copy was edited (or deleted: `observed` undefined) in the destination since the
 * migration last wrote it; "none" without a previous entry.
 */
export function detectSegmentEdit(
  entry: SegmentTargetRecord | undefined,
  observed: DestSegmentState | undefined,
  fallbackSince?: number,
): "none" | "edited" | "deleted" {
  if (!entry) return "none";
  if (entry.targetOwned) return entry.targetOwned;
  if (!observed) return "deleted";
  if (entry.dest?.fingerprint) {
    return entry.dest.fingerprint !== observed.fingerprint ? "edited" : "none";
  }
  return fallbackSince !== undefined && observed.lastModified !== undefined &&
      observed.lastModified > fallbackSince
    ? "edited"
    : "none";
}

/** The protection fields for a segment entry after this run (see nextFlagTargetRecord). */
export function nextSegmentTargetRecord(
  entry: SegmentTargetRecord | undefined,
  edit: "none" | "edited" | "deleted",
  observed: DestSegmentState | undefined,
): SegmentTargetRecord {
  const owned = entry?.targetOwned ?? (edit === "none" ? undefined : edit);
  const dest = owned || !observed ? entry?.dest : observed;
  return {
    ...(dest ? { dest } : {}),
    ...(owned ? { targetOwned: owned } : {}),
  };
}

/** Epoch ms of an ISO timestamp, or undefined when absent or invalid. */
export function epochMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? undefined : ms;
}
