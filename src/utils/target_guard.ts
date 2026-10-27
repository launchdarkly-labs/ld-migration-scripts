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
 * migration writes (view links, approvals metadata). Environments outside a run's mapping are checked
 * too, since flag-level fields are shared by every environment. Entries written before this version
 * have no `dest` record; for those an environment or segment counts as edited when its lastModified
 * is after the end of the last run on an older version (the manifest's `legacyEditCutoff`), and
 * flag-level edits cannot be detected until the first run on this version records a fingerprint.
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
  /** Edited destination environments this run maps to */
  environments: string[];
  /** Edited destination environments outside this run's mapping: they only keep the flag-level fields as they are */
  otherEnvironments: string[];
  deleted: boolean;
}

export const NO_FLAG_EDITS: FlagTargetEdits = {
  flagLevel: false,
  environments: [],
  otherEnvironments: [],
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

/** JSON with object keys sorted, so equal content gives equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${
      entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")
    }}`;
  }
  return JSON.stringify(value ?? null);
}

const withoutId = (item: unknown): unknown => {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return item;
  }
  const { _id: _, ...rest } = item as Record<string, unknown>;
  return rest;
};

/**
 * Drops the IDs LaunchDarkly generates for variations, rules and clauses (they are not content), and
 * nothing else: an `_id` inside a JSON variation value or a custom property is user data.
 */
function withoutGeneratedIds(field: string, value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (field === "variations") return value.map(withoutId);
  if (field === "rules") {
    return value.map((rule) => {
      const r = withoutId(rule) as Record<string, unknown>;
      return r && Array.isArray(r.clauses)
        ? { ...r, clauses: r.clauses.map(withoutId) }
        : r;
    });
  }
  return value;
}

async function fingerprint(
  source: Record<string, unknown> | undefined,
  fields: readonly string[],
): Promise<string> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    let value = withoutGeneratedIds(field, source?.[field]);
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

/**
 * The destination environments to check for edits: this run's (`runEnvKeys`) plus every environment
 * the entry recorded or marks as owned, since an edit there also protects the shared flag-level fields.
 */
export function guardEnvKeys(
  entry: FlagTargetRecord | undefined,
  runEnvKeys: Iterable<string>,
): string[] {
  return [
    ...new Set([
      ...runEnvKeys,
      ...Object.keys(entry?.dest?.environments ?? {}),
      ...(entry?.targetOwned?.environments ?? []),
    ]),
  ];
}

/**
 * Whether the destination flag, with `overrides` applied, has the flag-level fingerprint the entry
 * recorded: then the source values in `overrides` equal what the migration last wrote, and any
 * difference to them was made in the destination.
 */
export async function flagLevelMatchesRecord(
  entry: FlagTargetRecord | undefined,
  destFlag: any,
  overrides: Record<string, unknown>,
): Promise<boolean> {
  return entry?.dest?.fingerprint !== undefined &&
    await fingerprint({ ...destFlag, ...overrides }, FLAG_LEVEL_FIELDS) ===
      entry.dest.fingerprint;
}

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
 * undefined when the recorded copy no longer exists; it should cover guardEnvKeys(entry, runEnvKeys).
 * `fallbackSince` (epoch ms) is used for environments without a recorded fingerprint.
 */
export function detectFlagEdits(
  entry: FlagTargetRecord | undefined,
  observed: DestFlagState | undefined,
  runEnvKeys: Iterable<string>,
  fallbackSince?: number,
): FlagTargetEdits {
  if (!entry) return NO_FLAG_EDITS;
  const runEnvs = new Set(runEnvKeys);
  const owned = entry.targetOwned;
  if (owned?.deleted || !observed) {
    // A copy recreated in the destination after its deletion belongs to the destination entirely
    const recreated = observed
      ? [...runEnvs].filter((env) => observed.environments?.[env]).sort()
      : [];
    return {
      flagLevel: true,
      environments: recreated,
      otherEnvironments: [],
      deleted: true,
    };
  }
  const edited: string[] = [];
  for (const env of guardEnvKeys(entry, runEnvs)) {
    const current = observed.environments?.[env];
    if (!current) continue;
    if (owned?.environments?.includes(env)) {
      edited.push(env);
      continue;
    }
    // Our own pending approval request may have been applied since: not an independent edit
    if (entry.awaitingApproval?.includes(env)) continue;
    const recorded = entry.dest?.environments?.[env];
    if (recorded?.fingerprint) {
      if (recorded.fingerprint !== current.fingerprint) edited.push(env);
    } else if (
      fallbackSince !== undefined && current.lastModified !== undefined &&
      current.lastModified > fallbackSince
    ) {
      edited.push(env);
    }
  }
  const flagLevel = Boolean(owned?.flag) ||
    (entry.dest?.fingerprint !== undefined &&
      entry.dest.fingerprint !== observed.fingerprint);
  return {
    flagLevel,
    environments: edited.filter((env) => runEnvs.has(env)).sort(),
    otherEnvironments: edited.filter((env) => !runEnvs.has(env)).sort(),
    deleted: false,
  };
}

/** Flag-level fields are left alone when they, or any environment, were edited in the destination. */
export const protectsFlagLevel = (edits: FlagTargetEdits): boolean =>
  edits.deleted || edits.flagLevel || edits.environments.length > 0 ||
  edits.otherEnvironments.length > 0;

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
      ...edits.otherEnvironments,
    ]),
  ].sort();
  const deleted = Boolean(entry?.targetOwned?.deleted) || edits.deleted;
  const ownedFlag = Boolean(entry?.targetOwned?.flag) || edits.flagLevel;
  const dest: DestFlagState = {
    ...(entry?.dest ?? {}),
    // Null prototype: an environment named "__proto__" must be an own entry that serializes
    environments: Object.assign(
      Object.create(null),
      entry?.dest?.environments ?? {},
    ),
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
  // An edited copy deleted later counts as deleted, so reconciliation does not expect it
  if (!observed || entry.targetOwned === "deleted") return "deleted";
  if (entry.targetOwned) return entry.targetOwned;
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
  const owned = edit === "deleted"
    ? "deleted"
    : entry?.targetOwned ?? (edit === "none" ? undefined : edit);
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
