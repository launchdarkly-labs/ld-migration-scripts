// deno-lint-ignore-file no-explicit-any
/**
 * AgentControl (AI Configs) helpers for extract and migrate.
 * API paths remain under /ai-configs (product rename only).
 */
import * as Colors from "https://deno.land/std@0.149.0/fmt/colors.ts";
import {
  getJson,
  ldAPIPatchRequest,
  ldAPIPostRequest,
  ldAPIRequest,
  rateLimitRequest,
  sha256HexUtf8,
} from "./utils.ts";
import { mergeTags } from "./tags.ts";
import {
  cloneAgentControlManifest,
  ownEntry,
  recordedDestination,
  type SyncManifestAgentControl,
  type SyncManifestAgentControlConfig,
} from "./sync_manifest.ts";

export const AGENT_CONTROL_DIR = "ai-configs";

export type UpsertOutcome = "created" | "updated" | "skipped" | "error";

export interface AgentControlSummary {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

export function emptyAgentControlSummary(): AgentControlSummary {
  return { created: 0, updated: 0, skipped: 0, errors: 0 };
}

export function recordOutcome(
  summary: AgentControlSummary,
  outcome: UpsertOutcome,
): void {
  if (outcome === "error") {
    summary.errors++;
  } else {
    summary[outcome]++;
  }
}

/** Ordered migrate stages for AgentControl resources. */
export const AGENT_CONTROL_MIGRATE_ORDER = [
  "model-configs",
  "configs",
  "variations",
  "targeting",
] as const;

export type AgentControlMigrateStage =
  (typeof AGENT_CONTROL_MIGRATE_ORDER)[number];

const READ_ONLY_FIELDS = new Set([
  "_links",
  "_id",
  "_version",
  "version",
  "createdAt",
  "updatedAt",
  "_access",
  "_site",
  "_publishedAt",
  "_archivedAt",
  "usedInCount",
  "experiments",
  // Read-only on model configs / configs (POST bodies take maintainerId / maintainerTeamKey instead)
  "_maintainer",
  "global",
  "isGlobal",
  "isRestricted",
  "dependencies",
  // targeting-adjacent read-only / migrated separately
  "variations",
  "targeting",
  "environments",
  "rules",
  "fallthrough",
  "offVariation",
  "defaults",
]);

/** Strip read-only API fields before POST/PATCH. */
export function sanitizeAgentControlPayload(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (READ_ONLY_FIELDS.has(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** Fields safe to keep on variation create/update payloads. */
const VARIATION_STRIP_FIELDS = new Set([
  "_links",
  "_id",
  "_version",
  "version",
  "createdAt",
  "updatedAt",
  "_access",
  "_site",
  // Lifecycle state the variation POST body does not take
  "state",
  "_publishedAt",
  "_archivedAt",
]);

export function sanitizeVariationPayload(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (VARIATION_STRIP_FIELDS.has(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Resolve a stable variation key from AI Config / targeting variation shapes.
 * Targeting payloads often omit `key` but include `value._ldMeta.variationKey`.
 * Disabled variations typically have no key — normalize to `"disabled"`.
 */
export function resolveVariationKey(
  variation: Record<string, unknown>,
): string {
  if (typeof variation.key === "string" && variation.key.trim()) {
    return variation.key.trim();
  }
  const value = variation.value;
  const meta = value && typeof value === "object"
    ? (value as Record<string, unknown>)._ldMeta
    : undefined;
  if (meta && typeof meta === "object") {
    const ldMeta = meta as Record<string, unknown>;
    if (typeof ldMeta.variationKey === "string" && ldMeta.variationKey.trim()) {
      return ldMeta.variationKey.trim();
    }
    if (ldMeta.enabled === false) return "disabled";
    // Agent-mode configs without authored variations expose a single built-in "enabled" variation
    if (ldMeta.enabled === true) return "enabled";
  }
  const name = typeof variation.name === "string" ? variation.name.trim() : "";
  if (name.toLowerCase() === "disabled") return "disabled";
  return "";
}

/** Collect model-config keys referenced by extracted variations / targeting. */
export function collectReferencedModelConfigKeys(
  records: Array<Record<string, unknown>>,
): Set<string> {
  const keys = new Set<string>();
  for (const record of records) {
    if (typeof record.modelConfigKey === "string" && record.modelConfigKey) {
      keys.add(record.modelConfigKey);
    }
    const value = record.value;
    if (value && typeof value === "object") {
      const meta = (value as Record<string, unknown>)._ldMeta;
      if (meta && typeof meta === "object") {
        const ldMeta = meta as Record<string, unknown>;
        if (typeof ldMeta.modelKey === "string" && ldMeta.modelKey) {
          keys.add(ldMeta.modelKey);
        }
        if (
          typeof ldMeta.modelConfigKey === "string" && ldMeta.modelConfigKey
        ) {
          keys.add(ldMeta.modelConfigKey);
        }
      }
    }
  }
  return keys;
}

export function agentControlRoot(projPath: string): string {
  return `${projPath}/${AGENT_CONTROL_DIR}`;
}

export function modelConfigsPath(projPath: string): string {
  return `${agentControlRoot(projPath)}/model-configs.json`;
}

export function configsPath(projPath: string): string {
  return `${agentControlRoot(projPath)}/configs.json`;
}

export function variationPath(
  projPath: string,
  configKey: string,
  variationKey: string,
): string {
  return `${
    agentControlRoot(projPath)
  }/variations/${configKey}/${variationKey}.json`;
}

export function targetingPath(projPath: string, configKey: string): string {
  return `${agentControlRoot(projPath)}/targeting/${configKey}.json`;
}

/** True when HTTP status means AgentControl is unavailable for this account/project. */
export function isAgentControlUnavailable(status: number): boolean {
  return status === 403 || status === 404;
}

/** Decide upsert outcome from create/update HTTP status. */
export function classifyUpsertStatus(status: number): UpsertOutcome {
  if (status >= 200 && status < 300) return "created";
  if (status === 409) return "updated"; // caller should PATCH after 409
  if (isAgentControlUnavailable(status)) return "skipped";
  return "error";
}

export interface PaginatedItems {
  items: Record<string, unknown>[];
  unavailable: boolean;
}

/**
 * Paginate a collection endpoint that returns { items, totalCount? }.
 * On 403/404 sets unavailable and returns empty items.
 */
export async function paginateAgentControlCollection(
  apiKey: string,
  domain: string,
  basePath: string,
  rateLimitKey = "ai-configs",
  pageSize = 50,
): Promise<PaginatedItems> {
  const items: Record<string, unknown>[] = [];
  let offset = 0;
  let more = true;

  while (more) {
    const sep = basePath.includes("?") ? "&" : "?";
    const path = `${basePath}${sep}limit=${pageSize}&offset=${offset}`;
    let resp: Response;
    try {
      resp = await rateLimitRequest(
        ldAPIRequest(apiKey, domain, path),
        rateLimitKey,
      );
    } catch (error) {
      console.log(Colors.yellow(
        `  ⚠ AgentControl list request failed for ${basePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ));
      return { items, unavailable: false };
    }

    if (isAgentControlUnavailable(resp.status)) {
      return { items: [], unavailable: true };
    }
    if (resp.status > 201) {
      const body = await resp.text().catch(() => "");
      console.log(Colors.yellow(
        `  ⚠ AgentControl list failed (${resp.status}) for ${basePath}${
          body ? `: ${body.slice(0, 200)}` : ""
        }`,
      ));
      return { items, unavailable: false };
    }

    const data = await resp.json();
    const pageItems = Array.isArray(data.items)
      ? data.items
      : Array.isArray(data)
      ? data
      : [];
    items.push(...pageItems);

    const totalCount = typeof data.totalCount === "number"
      ? data.totalCount
      : items.length;
    if (items.length < totalCount && pageItems.length > 0) {
      offset += pageSize;
    } else if (data._links?.next && pageItems.length > 0) {
      offset += pageSize;
    } else {
      more = false;
    }
  }

  return { items, unavailable: false };
}

export interface ExtractAgentControlOptions {
  apiKey: string;
  domain: string;
  projectKey: string;
  projPath: string;
  writeJson: (filePathWithoutExt: string, data: unknown) => Promise<void>;
  ensureDir: (path: string) => void;
}

/** Extract model-configs, configs, variations, and targeting to disk. */
export async function extractAgentControlResources(
  options: ExtractAgentControlOptions,
): Promise<
  {
    skipped: boolean;
    configCount: number;
    variationCount: number;
    modelCount: number;
  }
> {
  const { apiKey, domain, projectKey, projPath, writeJson, ensureDir } =
    options;
  const root = agentControlRoot(projPath);
  ensureDir(root);

  console.log(Colors.cyan("\nExtracting AgentControl (AI Configs) data..."));

  const models = await paginateAgentControlCollection(
    apiKey,
    domain,
    `projects/${projectKey}/ai-configs/model-configs`,
  );
  if (models.unavailable) {
    console.log(Colors.yellow(
      "Skipping AgentControl extract (not available for this account/project)",
    ));
    return { skipped: true, configCount: 0, variationCount: 0, modelCount: 0 };
  }

  await writeJson(`${root}/model-configs`, {
    items: models.items,
    totalCount: models.items.length,
  });
  console.log(Colors.gray(`  Found ${models.items.length} model config(s)`));

  const configs = await paginateAgentControlCollection(
    apiKey,
    domain,
    `projects/${projectKey}/ai-configs`,
  );
  if (configs.unavailable) {
    console.log(Colors.yellow(
      "Skipping AgentControl extract (not available for this account/project)",
    ));
    return {
      skipped: true,
      configCount: 0,
      variationCount: 0,
      modelCount: models.items.length,
    };
  }

  await writeJson(`${root}/configs`, {
    items: configs.items,
    totalCount: configs.items.length,
  });
  console.log(
    Colors.gray(`  Found ${configs.items.length} AgentControl config(s)`),
  );

  ensureDir(`${root}/variations`);
  ensureDir(`${root}/targeting`);

  let variationCount = 0;
  for (const config of configs.items) {
    const configKey = String(config.key ?? "");
    if (!configKey) continue;

    // Prefer full GET for embedded variations
    let detail: Record<string, unknown> = config;
    try {
      const detailResp = await rateLimitRequest(
        ldAPIRequest(
          apiKey,
          domain,
          `projects/${projectKey}/ai-configs/${configKey}`,
        ),
        "ai-configs",
      );
      if (detailResp.status >= 200 && detailResp.status < 300) {
        detail = await detailResp.json();
      } else if (isAgentControlUnavailable(detailResp.status)) {
        continue;
      } else if (detailResp.status > 201) {
        const body = await detailResp.text().catch(() => "");
        console.log(Colors.yellow(
          `  ⚠ Failed to GET ai-config ${configKey} (${detailResp.status})${
            body ? `: ${body.slice(0, 200)}` : ""
          }`,
        ));
      }
    } catch (error) {
      console.log(Colors.yellow(
        `  ⚠ Failed to GET ai-config ${configKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ));
    }

    const variations = Array.isArray(detail.variations)
      ? detail.variations as Record<string, unknown>[]
      : [];

    const writeVariation = async (v: Record<string, unknown>) => {
      const variationKey = resolveVariationKey(v);
      // Skip synthetic disabled — created by LD; only used for targeting index maps
      if (!variationKey || variationKey === "disabled") return;
      ensureDir(`${root}/variations/${configKey}`);
      const withKey = typeof v.key === "string" && v.key
        ? v
        : { ...v, key: variationKey };
      await writeJson(
        `${root}/variations/${configKey}/${variationKey}`,
        withKey,
      );
      variationCount++;
    };

    if (variations.length === 0) {
      const listed = await paginateAgentControlCollection(
        apiKey,
        domain,
        `projects/${projectKey}/ai-configs/${configKey}/variations`,
      );
      if (!listed.unavailable) {
        for (const v of listed.items) {
          await writeVariation(v);
        }
      }
    } else {
      for (const v of variations) {
        await writeVariation(v);
      }
    }

    // Dedicated targeting endpoint (not fields scraped from config detail)
    try {
      const targetingResp = await rateLimitRequest(
        ldAPIRequest(
          apiKey,
          domain,
          `projects/${projectKey}/ai-configs/${configKey}/targeting`,
        ),
        "ai-configs",
      );
      if (targetingResp.status >= 200 && targetingResp.status < 300) {
        const targeting = await targetingResp.json() as Record<string, unknown>;
        targeting.key = configKey;
        // Persist resolved keys on embedded variations so migrate indexes stay stable
        if (Array.isArray(targeting.variations)) {
          targeting.variations =
            (targeting.variations as Record<string, unknown>[])
              .map((v) => {
                const key = resolveVariationKey(v);
                return key && !v.key ? { ...v, key } : v;
              });
        }
        await writeJson(`${root}/targeting/${configKey}`, targeting);
      } else if (!isAgentControlUnavailable(targetingResp.status)) {
        const body = await targetingResp.text().catch(() => "");
        console.log(Colors.yellow(
          `  ⚠ Failed to GET targeting for ${configKey} (${targetingResp.status})${
            body ? `: ${body.slice(0, 200)}` : ""
          }`,
        ));
      }
    } catch (error) {
      console.log(Colors.yellow(
        `  ⚠ Failed to GET targeting for ${configKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ));
    }
  }

  console.log(Colors.gray(`  Found ${variationCount} variation(s)`));
  return {
    skipped: false,
    configCount: configs.items.length,
    variationCount,
    modelCount: models.items.length,
  };
}

export interface AgentControlHttpClient {
  post: (
    path: string,
    body: Record<string, unknown>,
  ) => Promise<{ status: number; body?: string }>;
  patch: (
    path: string,
    body: Record<string, unknown> | Array<Record<string, unknown>>,
  ) => Promise<{ status: number; body?: string }>;
  /** Semantic patch (targeting). Optional for unit tests that only cover upsert. */
  semanticPatch?: (
    path: string,
    body: Record<string, unknown>,
  ) => Promise<{ status: number; body?: string }>;
  get?: (
    path: string,
  ) => Promise<{ status: number; json?: unknown; body?: string }>;
}

function logUpsertFailure(
  action: string,
  path: string,
  status: number,
  body?: string,
): void {
  console.log(Colors.red(
    `    ✗ ${action} ${path} failed (${status})${
      body ? `: ${body.slice(0, 300)}` : ""
    }`,
  ));
}

export async function upsertAgentControlResource(
  client: AgentControlHttpClient,
  createPath: string,
  updatePath: string,
  payload: Record<string, unknown>,
  dryRun: boolean,
  options?: {
    sanitize?: (r: Record<string, unknown>) => Record<string, unknown>;
    /**
     * The resource is known to exist (looked up beforehand): go straight to the update. A POST for an
     * existing judge config is rejected with a 400 ("could not find the enabled variation") rather than
     * a 409, so it cannot be relied on to signal the conflict.
     */
    knownExisting?: boolean;
  },
): Promise<UpsertOutcome> {
  const sanitize = options?.sanitize ?? sanitizeAgentControlPayload;
  const body = sanitize(payload);
  if (dryRun) {
    console.log(Colors.gray(
      `    [DRY RUN] Would upsert ${createPath} (key=${body.key ?? "?"})`,
    ));
    return "created";
  }

  const createResp = options?.knownExisting
    ? { status: 409 as number, body: undefined }
    : await client.post(createPath, body);
  if (createResp.status >= 200 && createResp.status < 300) {
    return "created";
  }
  if (isAgentControlUnavailable(createResp.status)) {
    return "skipped";
  }
  if (createResp.status === 409) {
    // Merge-style object PATCH (AI Configs model/config/variation updates use JSON body objects)
    const patchResp = await client.patch(updatePath, body);
    if (patchResp.status >= 200 && patchResp.status < 300) {
      return "updated";
    }
    if (isAgentControlUnavailable(patchResp.status)) {
      return "skipped";
    }
    // Built-in / immutable model configs often conflict and reject update
    if (
      patchResp.status === 400 || patchResp.status === 405 ||
      patchResp.status === 422
    ) {
      console.log(Colors.yellow(
        `    ⚠ Conflict on ${updatePath}; treating as immutable/built-in skip (${patchResp.status})`,
      ));
      return "skipped";
    }
    logUpsertFailure("PATCH", updatePath, patchResp.status, patchResp.body);
    return "error";
  }

  logUpsertFailure("POST", createPath, createResp.status, createResp.body);
  return "error";
}

/** What to do with a model config or config whose key already exists in the destination. */
export type AgentControlConflictAction =
  | "overwrite"
  | "skip"
  | "prefix"
  | "abort";

export type AgentControlResourceType = "model-config" | "ai-config";

export interface MigrateAgentControlOptions {
  apiKey: string;
  domain: string;
  sourceProjectKey: string;
  destProjectKey: string;
  dryRun: boolean;
  /** Optional source→dest environment key mapping */
  envMapping?: Record<string, string>;
  /** Optional injected client for tests */
  client?: AgentControlHttpClient;
  /** Skip resources whose inputs are unchanged since the recorded sync (needs previousManifest) */
  incremental?: boolean;
  /** The AgentControl section of the previous sync manifest: this migration's own earlier copies */
  previousManifest?: SyncManifestAgentControl;
  /** --on-conflict policy; default is prefix when conflictPrefix is set, else overwrite */
  onConflict?: string;
  conflictPrefix?: string;
  /** Decides per resource (prompt mode); defaults to the onConflict policy, with prompt treated as overwrite */
  resolveConflict?: (
    resourceType: AgentControlResourceType,
    key: string,
  ) => Promise<AgentControlConflictAction>;
  /** Called when a conflict is resolved by renaming (conflict report) */
  onConflictRenamed?: (
    resourceType: AgentControlResourceType,
    originalKey: string,
    resolvedKey: string,
  ) => void;
  /** Called once when the abort policy meets an existing resource; processing stops after it */
  onAbort?: (resourceType: AgentControlResourceType, key: string) => void;
  /** Migration tags added to configs and model configs (variations take no tags) */
  tags?: string[];
  /** Source member ID -> destination member ID (maintainer_mapping.json) */
  maintainerMapping?: Record<string, string | null>;
  assignMaintainerIds?: boolean;
}

export interface AgentControlMigrationResult {
  summary: AgentControlSummary;
  /**
   * The cumulative AgentControl manifest section to write: the previous entries, with those this run
   * wrote added or refreshed and those whose write failed kept with their hash cleared. Unchanged from
   * the previous one on a dry run.
   */
  manifest: SyncManifestAgentControl;
  /** True when the abort policy stopped the run at an existing resource */
  aborted: boolean;
  /**
   * Destination keys this run left in place (written, or unchanged and confirmed present): what a
   * reconciliation against the destination should find. Excludes resources skipped by the conflict
   * policy, failed ones (already reported as errors) and global model configs.
   */
  expected: { modelConfigs: string[]; configs: string[] };
}

/** JSON with object keys sorted, so equal content fingerprints equally whatever the key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${
      Object.keys(record).sort()
        .filter((k) => record[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Fingerprint of the inputs of one write (what --incremental compares). */
export async function hashAgentControlInput(value: unknown): Promise<string> {
  return await sha256HexUtf8(stableStringify(value));
}

/** The source member a model config or config names as maintainer (`_maintainer` on reads), if it is a member. */
export function sourceMaintainerMemberId(
  source: Record<string, unknown>,
): string | undefined {
  const maintainer = source._maintainer;
  if (maintainer && typeof maintainer === "object") {
    const id = (maintainer as Record<string, unknown>)._id;
    if (typeof id === "string" && id) return id;
  }
  return typeof source.maintainerId === "string" && source.maintainerId
    ? source.maintainerId
    : undefined;
}

/**
 * The destination member ID to send as `maintainerId`, only when assigning maintainers was requested and
 * the mapping has a destination member for the source member. Anything else sends no maintainer: a
 * source-account member ID means nothing in the destination account. Team maintainers are not carried
 * over (teams are not migrated by this workflow).
 */
export function resolveAgentControlMaintainerId(
  source: Record<string, unknown>,
  mapping: Record<string, string | null> | undefined,
  assignMaintainerIds: boolean | undefined,
): string | undefined {
  if (!assignMaintainerIds) return undefined;
  const sourceId = sourceMaintainerMemberId(source);
  if (!sourceId || !mapping || !Object.hasOwn(mapping, sourceId)) {
    return undefined;
  }
  const mapped = mapping[sourceId];
  return typeof mapped === "string" && mapped ? mapped : undefined;
}

const stringTags = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((t): t is string => typeof t === "string")
    : [];

/**
 * The POST/PATCH body for a model config or config: read-only fields removed, the destination key (and
 * name) applied, tags merged (source, migration, and the destination's current tags when it is updated),
 * and a maintainer only when one maps to the destination account.
 */
export function buildAgentControlPayload(
  source: Record<string, unknown>,
  options: {
    destKey: string;
    destName?: string;
    migrationTags?: string[];
    existingTags?: string[];
    maintainerMapping?: Record<string, string | null>;
    assignMaintainerIds?: boolean;
  },
): Record<string, unknown> {
  const payload = sanitizeAgentControlPayload(source);
  delete payload.tags;
  delete payload.maintainerId;
  delete payload.maintainerTeamKey;
  payload.key = options.destKey;
  if (options.destName !== undefined && typeof source.name === "string") {
    payload.name = options.destName;
  }
  const tags = mergeTags(
    stringTags(source.tags),
    options.migrationTags,
    options.existingTags,
  );
  if (tags.length > 0) payload.tags = tags;
  const maintainerId = resolveAgentControlMaintainerId(
    source,
    options.maintainerMapping,
    options.assignMaintainerIds,
  );
  if (maintainerId) payload.maintainerId = maintainerId;
  return payload;
}

/** The conflict policy when no resolver is injected: --on-conflict, else prefix with a prefix, else overwrite. */
export function defaultConflictAction(
  onConflict: string | undefined,
  conflictPrefix: string | undefined,
): AgentControlConflictAction {
  const mode = onConflict ?? (conflictPrefix ? "prefix" : "overwrite");
  return mode === "skip" || mode === "prefix" || mode === "abort"
    ? mode
    : "overwrite";
}

function ldAPISemanticPatchRequest(
  apiKey: string,
  domain: string,
  path: string,
  body: Record<string, unknown>,
): Request {
  return new Request(`https://${domain}/api/v2/${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type":
        "application/json; domain-model=launchdarkly.semanticpatch",
      Authorization: apiKey,
      "User-Agent": "Project-Migrator-Script",
    },
    body: JSON.stringify(body),
  });
}

function defaultHttpClient(
  apiKey: string,
  domain: string,
): AgentControlHttpClient {
  return {
    async post(path, body) {
      const resp = await rateLimitRequest(
        ldAPIPostRequest(apiKey, domain, path, body),
        "ai-configs",
      );
      return {
        status: resp.status,
        body: resp.ok ? undefined : await resp.text().catch(() => undefined),
      };
    },
    async patch(path, body) {
      const resp = await rateLimitRequest(
        ldAPIPatchRequest(apiKey, domain, path, body),
        "ai-configs",
      );
      return {
        status: resp.status,
        body: resp.ok ? undefined : await resp.text().catch(() => undefined),
      };
    },
    async semanticPatch(path, body) {
      const resp = await rateLimitRequest(
        ldAPISemanticPatchRequest(apiKey, domain, path, body),
        "ai-configs",
      );
      return {
        status: resp.status,
        body: resp.ok ? undefined : await resp.text().catch(() => undefined),
      };
    },
    async get(path) {
      const resp = await rateLimitRequest(
        ldAPIRequest(apiKey, domain, path),
        "ai-configs",
      );
      if (resp.status >= 200 && resp.status < 300) {
        return { status: resp.status, json: await resp.json() };
      }
      return {
        status: resp.status,
        body: await resp.text().catch(() => undefined),
      };
    },
  };
}

export interface SourceVariationRef {
  key: string;
  _id: string;
}

/**
 * Build index-aligned variation refs from targeting.variations.
 * Preserves array indexes used by fallthrough/rules/targets.
 * Does not use blind file[i] fallback when `_id`s differ across endpoints.
 */
export function buildSourceVariationRefsFromTargeting(
  targetingVariations: Record<string, unknown>[],
  fileVariations: Record<string, unknown>[] = [],
): SourceVariationRef[] {
  return targetingVariations.map((v) => {
    const id = String(v._id ?? "");
    let key = resolveVariationKey(v);

    if (!key && id) {
      const byId = fileVariations.find((f) => String(f._id) === id);
      if (byId) key = resolveVariationKey(byId);
    }

    if (!key) {
      const name = String(v.name ?? "").trim().toLowerCase();
      if (name) {
        const byName = fileVariations.find(
          (f) => String(f.name ?? "").trim().toLowerCase() === name,
        );
        if (byName) key = resolveVariationKey(byName);
      }
    }

    return { key, _id: id };
  });
}

/** True when a targeting warning means the migrate is incomplete/incorrect. */
export function isCriticalTargetingWarning(warning: string): boolean {
  const w = warning.toLowerCase();
  return w.includes("fallthrough") ||
    w.includes("off variation") ||
    w.includes("rule variation") ||
    w.includes("rollout variation") ||
    w.includes("unmapped variation");
}

/** Build semantic-patch instructions for one environment's targeting state. */
export function buildTargetingInstructionsForEnvironment(
  envConfig: Record<string, unknown>,
  sourceVariations: SourceVariationRef[],
  destVariationIdByKey: Map<string, string>,
): { instructions: Record<string, unknown>[]; warnings: string[] } {
  const warnings: string[] = [];
  const instructions: Record<string, unknown>[] = [];

  const resolveDestId = (indexOrId: unknown): string | undefined => {
    if (typeof indexOrId === "number") {
      const key = sourceVariations[indexOrId]?.key;
      return key ? destVariationIdByKey.get(key) : undefined;
    }
    if (typeof indexOrId === "string") {
      const byId = sourceVariations.find((v) => v._id === indexOrId && v.key);
      if (byId) return destVariationIdByKey.get(byId.key);
      // Direct key lookup (e.g. already-resolved variation key)
      if (destVariationIdByKey.has(indexOrId)) {
        return destVariationIdByKey.get(indexOrId);
      }
      return undefined;
    }
    return undefined;
  };

  const mapRolloutWeights = (
    weights: Record<string, number> | undefined,
  ): Record<string, number> | undefined => {
    if (!weights) return undefined;
    const out: Record<string, number> = {};
    for (const [srcId, weight] of Object.entries(weights)) {
      const destId = resolveDestId(srcId);
      if (!destId) {
        warnings.push(`Missing dest variation for rollout weight key ${srcId}`);
        continue;
      }
      out[destId] = weight;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  // Rules
  const rules = Array.isArray(envConfig.rules)
    ? envConfig.rules as Record<string, unknown>[]
    : [];
  const mappedRules: Record<string, unknown>[] = [];
  for (const rule of rules) {
    const clauses = Array.isArray(rule.clauses)
      ? (rule.clauses as Record<string, unknown>[]).map((c) => {
        const {
          id: _id,
          _id: __id,
          ...clause
        } = c;
        return clause;
      })
      : [];
    const mapped: Record<string, unknown> = { clauses };
    if (typeof rule.description === "string") {
      mapped.description = rule.description;
    }

    if (rule.variation !== undefined || rule.variationId !== undefined) {
      const destId = resolveDestId(rule.variationId ?? rule.variation);
      if (!destId) {
        warnings.push("Could not map rule variation to destination");
        continue;
      }
      mapped.variationId = destId;
    } else if (rule.rollout && typeof rule.rollout === "object") {
      const rollout = rule.rollout as Record<string, unknown>;
      const weightsFromRollout = Array.isArray(rollout.variations)
        ? Object.fromEntries(
          (rollout.variations as Array<Record<string, unknown>>)
            .filter((v) =>
              typeof v.variation === "number" && typeof v.weight === "number"
            )
            .map((v) => [String(v.variation), v.weight as number]),
        )
        : undefined;
      // Source GET uses index-based rollout.variations; semantic patch wants variationId weights.
      // Convert index→destId via resolveDestId on numeric keys.
      let rolloutWeights: Record<string, number> | undefined;
      if (weightsFromRollout) {
        rolloutWeights = {};
        for (const [idx, weight] of Object.entries(weightsFromRollout)) {
          const destId = resolveDestId(Number(idx));
          if (destId) rolloutWeights[destId] = weight;
          else warnings.push(`Could not map rollout variation index ${idx}`);
        }
      }
      if (rolloutWeights && Object.keys(rolloutWeights).length > 0) {
        mapped.rolloutWeights = rolloutWeights;
        if (typeof rollout.bucketBy === "string") {
          mapped.rolloutBucketBy = rollout.bucketBy;
        }
        if (typeof rollout.contextKind === "string") {
          mapped.rolloutContextKind = rollout.contextKind;
        }
      } else {
        warnings.push("Rule rollout could not be mapped; skipping rule");
        continue;
      }
    }
    mappedRules.push(mapped);
  }
  instructions.push({ kind: "replaceRules", rules: mappedRules });

  // Individual targets (targets and/or contextTargets)
  const targetLists = [
    ...(Array.isArray(envConfig.targets)
      ? envConfig.targets as Record<string, unknown>[]
      : []),
    ...(Array.isArray(envConfig.contextTargets)
      ? envConfig.contextTargets as Record<string, unknown>[]
      : []),
  ];
  const mappedTargets: Record<string, unknown>[] = [];
  for (const t of targetLists) {
    const destId = resolveDestId(t.variationId ?? t.variation);
    if (!destId || !Array.isArray(t.values)) {
      warnings.push(
        "Skipping target with unmapped variation or missing values",
      );
      continue;
    }
    mappedTargets.push({
      variationId: destId,
      values: t.values,
      ...(typeof t.contextKind === "string"
        ? { contextKind: t.contextKind }
        : {}),
    });
  }
  instructions.push({ kind: "replaceTargets", targets: mappedTargets });

  // Fallthrough
  const fallthrough = envConfig.fallthrough as
    | Record<string, unknown>
    | undefined;
  if (fallthrough) {
    if (
      fallthrough.variation !== undefined ||
      fallthrough.variationId !== undefined
    ) {
      const destId = resolveDestId(
        fallthrough.variationId ?? fallthrough.variation,
      );
      if (destId) {
        instructions.push({
          kind: "updateFallthroughVariationOrRollout",
          variationId: destId,
        });
      } else {
        warnings.push("Could not map fallthrough variation");
      }
    } else if (fallthrough.rollout && typeof fallthrough.rollout === "object") {
      const rollout = fallthrough.rollout as Record<string, unknown>;
      const weightsFromRollout = Array.isArray(rollout.variations)
        ? Object.fromEntries(
          (rollout.variations as Array<Record<string, unknown>>)
            .filter((v) =>
              typeof v.variation === "number" && typeof v.weight === "number"
            )
            .map((v) => {
              const destId = resolveDestId(v.variation as number);
              return destId ? [destId, v.weight as number] : null;
            })
            .filter((e): e is [string, number] => e != null),
        )
        : mapRolloutWeights(
          rollout.weights as Record<string, number> | undefined,
        );
      if (weightsFromRollout && Object.keys(weightsFromRollout).length > 0) {
        instructions.push({
          kind: "updateFallthroughVariationOrRollout",
          rolloutWeights: weightsFromRollout,
          ...(typeof rollout.bucketBy === "string"
            ? { rolloutBucketBy: rollout.bucketBy }
            : {}),
          ...(typeof rollout.contextKind === "string"
            ? { rolloutContextKind: rollout.contextKind }
            : {}),
        });
      }
    }
  }

  // Off variation
  if (envConfig.offVariation !== undefined) {
    const destId = resolveDestId(envConfig.offVariation);
    if (destId) {
      instructions.push({ kind: "updateOffVariation", variationId: destId });
    } else {
      warnings.push("Could not map off variation");
    }
  }

  return { instructions, warnings };
}

type ExistingResource =
  | { state: "exists"; json: Record<string, unknown> }
  | { state: "missing" }
  | { state: "unknown" };

/**
 * Looks the resource up in the destination. "unknown" (no GET available, or an unexpected status) lets
 * the caller fall back to POST, with a 409 handled as an overwrite.
 */
async function fetchExisting(
  client: AgentControlHttpClient,
  path: string,
): Promise<ExistingResource> {
  if (!client.get) return { state: "unknown" };
  try {
    const resp = await client.get(path);
    if (resp.status >= 200 && resp.status < 300) {
      const json = resp.json && typeof resp.json === "object"
        ? resp.json as Record<string, unknown>
        : {};
      return { state: "exists", json };
    }
    if (resp.status === 404) return { state: "missing" };
  } catch {
    // fall through: treated as unknown
  }
  return { state: "unknown" };
}

type WritePlan =
  | {
    kind: "write";
    destKey: string;
    destName?: string;
    /** The destination's current tags, merged into the written ones */
    existingTags: string[];
    /** A copy already exists in the destination (a dry run reports an update, not a create) */
    exists: boolean;
  }
  | { kind: "skip" }
  | { kind: "abort" }
  | { kind: "error" };

/** Migrate extracted AgentControl resources to destination project. */
export async function migrateAgentControlFromExtract(
  options: MigrateAgentControlOptions,
): Promise<AgentControlMigrationResult> {
  const summary = emptyAgentControlSummary();
  const sourceRoot =
    `./data/launchdarkly-migrations/source/project/${options.sourceProjectKey}`;
  const aiRoot = agentControlRoot(sourceRoot);
  const client = options.client ??
    defaultHttpClient(options.apiKey, options.domain);
  const dest = options.destProjectKey;
  const envMapping = options.envMapping ?? {};
  const previous = options.previousManifest;
  const migrationTags = options.tags ?? [];
  const resolveConflict = options.resolveConflict ??
    (() =>
      Promise.resolve(
        defaultConflictAction(options.onConflict, options.conflictPrefix),
      ));

  // Cumulative inventory: previous entries are kept; this run refreshes the ones it wrote. A dry run
  // never records (the manifest is not written), so a later --incremental run cannot skip unsynced work.
  const manifest = cloneAgentControlManifest(previous);
  let aborted = false;
  const expected = {
    modelConfigs: new Set<string>(),
    configs: new Set<string>(),
  };
  const finish = (): AgentControlMigrationResult => ({
    summary,
    manifest,
    aborted,
    expected: {
      modelConfigs: [...expected.modelConfigs],
      configs: [...expected.configs],
    },
  });
  const ensureConfig = (key: string): SyncManifestAgentControlConfig => {
    if (!Object.hasOwn(manifest.configs, key)) {
      manifest.configs[key] = {
        variations: Object.create(null),
        targeting: Object.create(null),
      };
    }
    return manifest.configs[key];
  };

  console.log(Colors.cyan("\n🤖 Starting AgentControl migration..."));
  if (options.dryRun) {
    console.log(
      Colors.yellow("  DRY RUN — no AgentControl writes will be applied"),
    );
  }

  const stop = (type: AgentControlResourceType, key: string): void => {
    aborted = true;
    options.onAbort?.(type, key);
  };

  /**
   * Where a model config or config goes in the destination. This migration's own earlier copy (recorded
   * in the manifest) is updated in place; an existing copy it did not create follows the conflict policy.
   */
  const planWrite = async (
    resourceType: AgentControlResourceType,
    key: string,
    name: string | undefined,
    basePath: string,
    previousEntry: { destKey?: string } | undefined,
  ): Promise<WritePlan> => {
    const recorded = previousEntry !== undefined;
    let destKey = key;
    let destName = name;
    if (previousEntry) {
      const own = recordedDestination(
        previousEntry,
        { key, name: name ?? key },
        options.conflictPrefix,
      );
      destKey = own.key;
      destName = name === undefined ? undefined : own.name;
    }
    const existing = await fetchExisting(client, `${basePath}/${destKey}`);
    const existingTags = existing.state === "exists"
      ? stringTags(existing.json.tags)
      : [];
    if (recorded || existing.state !== "exists") {
      return {
        kind: "write",
        destKey,
        destName,
        existingTags,
        exists: existing.state === "exists",
      };
    }

    const label = resourceType === "model-config" ? "Model config" : "Config";
    const action = await resolveConflict(resourceType, key);
    if (action === "abort") {
      console.log(
        Colors.red(`  ✗ ${label} ${key}: exists (--on-conflict abort)`),
      );
      stop(resourceType, key);
      return { kind: "abort" };
    }
    if (action === "skip") {
      console.log(
        Colors.gray(`  → ${label} ${key}: exists, skipping (--on-conflict)`),
      );
      return { kind: "skip" };
    }
    if (action === "prefix") {
      if (resourceType === "model-config") {
        // Variations refer to model configs by key, so a model config is never renamed: the existing one is reused
        console.log(Colors.yellow(
          `  ⚠ ${label} ${key}: exists; reusing it (model configs are referenced by key and are not prefixed)`,
        ));
        return { kind: "skip" };
      }
      const prefix = options.conflictPrefix;
      if (!prefix) {
        console.log(Colors.yellow(
          `  ⚠ ${label} ${key}: exists but no conflict prefix is set; skipping`,
        ));
        return { kind: "skip" };
      }
      const prefixedKey = `${prefix}${key}`;
      const taken = await fetchExisting(client, `${basePath}/${prefixedKey}`);
      if (taken.state === "exists") {
        console.log(Colors.red(
          `  ✗ ${label} ${key}: exists, and so does the prefixed key ${prefixedKey}; not overwriting it`,
        ));
        return { kind: "error" };
      }
      console.log(Colors.yellow(
        `  ⚠ ${label} ${key}: exists, writing it as ${prefixedKey}`,
      ));
      options.onConflictRenamed?.(resourceType, key, prefixedKey);
      return {
        kind: "write",
        destKey: prefixedKey,
        destName: name === undefined ? undefined : `${prefix}${name}`,
        existingTags: [],
        exists: false,
      };
    }
    // overwrite
    console.log(Colors.gray(`  ⚠ ${label} ${key}: exists, updating it`));
    return {
      kind: "write",
      destKey,
      destName,
      existingTags,
      exists: true,
    };
  };

  const payloadFor = (
    source: Record<string, unknown>,
    destKey: string,
    destName: string | undefined,
    existingTags?: string[],
  ) =>
    buildAgentControlPayload(source, {
      destKey,
      destName,
      migrationTags,
      existingTags,
      maintainerMapping: options.maintainerMapping,
      assignMaintainerIds: options.assignMaintainerIds,
    });

  // Stage 1: model-configs
  const modelData = await getJson(modelConfigsPath(sourceRoot)) as
    | { items?: Record<string, unknown>[] }
    | undefined;
  const modelItems = modelData?.items ?? [];
  if (modelItems.length === 0 && !(await directoryExists(aiRoot))) {
    console.log(Colors.gray("  No AgentControl extract found, skipping"));
    return finish();
  }

  // Prefer only model configs referenced by extracted variations/targeting.
  // Provider catalogs are huge; migrating all of them is usually wrong/noisy.
  const referencedModelKeys = await collectReferencedModelKeysFromExtract(
    aiRoot,
  );
  const modelsToMigrate = referencedModelKeys.size > 0
    ? modelItems.filter((m) => referencedModelKeys.has(String(m.key ?? "")))
    : modelItems;
  if (
    referencedModelKeys.size > 0 && modelsToMigrate.length < modelItems.length
  ) {
    console.log(Colors.gray(
      `  Migrating ${modelsToMigrate.length} referenced model config(s) ` +
        `(skipping ${
          modelItems.length - modelsToMigrate.length
        } unreferenced catalog entries)`,
    ));
  } else {
    console.log(
      Colors.gray(`  Migrating ${modelsToMigrate.length} model config(s)...`),
    );
  }

  const modelBase = `projects/${dest}/ai-configs/model-configs`;
  for (const model of modelsToMigrate) {
    if (aborted) break;
    const key = String(model.key ?? "");
    if (!key) {
      recordOutcome(summary, "skipped");
      continue;
    }
    // Built-in (global) and restricted models cannot be created in the destination; skip without a write.
    // The API reports the flag as `global`; `isGlobal` is accepted for older extracts.
    if (
      model.global === true || model.isGlobal === true ||
      model.isRestricted === true
    ) {
      console.log(
        Colors.yellow(`  ⚠ Model config ${key}: skipped (global/restricted)`),
      );
      recordOutcome(summary, "skipped");
      continue;
    }
    const name = typeof model.name === "string" ? model.name : undefined;
    const previousEntry = ownEntry(previous?.modelConfigs, key);

    // --incremental: a recorded copy whose inputs are unchanged needs no request at all
    if (options.incremental && previousEntry?.hash) {
      const own = recordedDestination(
        previousEntry,
        { key, name: name ?? key },
        options.conflictPrefix,
      );
      const hash = await hashAgentControlInput(
        payloadFor(model, own.key, name === undefined ? undefined : own.name),
      );
      if (hash === previousEntry.hash) {
        // The manifest only says what was written once: a destination that was since deleted or
        // recreated no longer has it, so confirm it is still there before skipping
        const there = await fetchExisting(client, `${modelBase}/${own.key}`);
        if (there.state !== "missing") {
          console.log(
            Colors.gray(
              `  → Model config ${key}: unchanged, skipping (--incremental)`,
            ),
          );
          recordOutcome(summary, "skipped");
          expected.modelConfigs.add(own.key);
          continue;
        }
        console.log(Colors.yellow(
          `  ⚠ Model config ${key}: recorded in the sync manifest but missing in the destination, recreating`,
        ));
      }
    }

    const plan = await planWrite(
      "model-config",
      key,
      name,
      modelBase,
      previousEntry,
    );
    if (plan.kind === "abort") break;
    if (plan.kind === "skip") {
      recordOutcome(summary, "skipped");
      continue;
    }
    if (plan.kind === "error") {
      recordOutcome(summary, "error");
      if (!options.dryRun && previousEntry) {
        delete manifest.modelConfigs[key].hash;
      }
      continue;
    }

    const hash = await hashAgentControlInput(
      payloadFor(model, plan.destKey, plan.destName),
    );
    let outcome = await upsertAgentControlResource(
      client,
      modelBase,
      `${modelBase}/${plan.destKey}`,
      payloadFor(model, plan.destKey, plan.destName, plan.existingTags),
      options.dryRun,
      { sanitize: (r) => r, knownExisting: plan.exists },
    );
    if (options.dryRun && outcome === "created" && plan.exists) {
      outcome = "updated";
    }
    logStageOutcome("Model config", key, outcome);
    recordOutcome(summary, outcome);
    if (options.dryRun) continue;
    if (outcome === "created" || outcome === "updated") {
      expected.modelConfigs.add(plan.destKey);
      manifest.modelConfigs[key] = {
        hash,
        ...(plan.destKey !== key ? { destKey: plan.destKey } : {}),
      };
    } else if (outcome === "error" && previousEntry) {
      delete manifest.modelConfigs[key].hash;
    }
  }

  // Stage 2: configs
  const configData = await getJson(configsPath(sourceRoot)) as
    | { items?: Record<string, unknown>[] }
    | undefined;
  const configItems = configData?.items ?? [];
  console.log(Colors.gray(`  Migrating ${configItems.length} config(s)...`));
  // Where each source config lives in the destination, and whether its variations and targeting may be
  // written (not when the config was skipped by the conflict policy, failed, or is unavailable)
  const configPlans = new Map<string, { destKey: string; blocked: boolean }>();
  const configBase = `projects/${dest}/ai-configs`;
  const recreatedConfigs = new Set<string>();
  for (const config of configItems) {
    if (aborted) break;
    const key = String(config.key ?? "");
    if (!key) {
      recordOutcome(summary, "skipped");
      continue;
    }
    const name = typeof config.name === "string" ? config.name : undefined;
    const previousEntry = ownEntry(previous?.configs, key);

    if (options.incremental && previousEntry?.hash) {
      const own = recordedDestination(
        previousEntry,
        { key, name: name ?? key },
        options.conflictPrefix,
      );
      const hash = await hashAgentControlInput(
        payloadFor(config, own.key, name === undefined ? undefined : own.name),
      );
      if (hash === previousEntry.hash) {
        // Confirm the destination still has it (it may have been deleted or recreated since the sync)
        const there = await fetchExisting(client, `${configBase}/${own.key}`);
        if (there.state !== "missing") {
          console.log(
            Colors.gray(
              `  → Config ${key}: unchanged, skipping (--incremental)`,
            ),
          );
          recordOutcome(summary, "skipped");
          expected.configs.add(own.key);
          // Its variations and targeting are still checked individually
          configPlans.set(key, { destKey: own.key, blocked: false });
          continue;
        }
        console.log(Colors.yellow(
          `  ⚠ Config ${key}: recorded in the sync manifest but missing in the destination, recreating`,
        ));
      }
    }

    const plan = await planWrite(
      "ai-config",
      key,
      name,
      configBase,
      previousEntry,
    );
    if (plan.kind === "abort") break;
    if (plan.kind === "skip") {
      recordOutcome(summary, "skipped");
      configPlans.set(key, { destKey: key, blocked: true });
      continue;
    }
    if (plan.kind === "error") {
      recordOutcome(summary, "error");
      configPlans.set(key, { destKey: key, blocked: true });
      if (!options.dryRun && previousEntry) delete manifest.configs[key].hash;
      continue;
    }

    // A recorded config that is gone from the destination comes back empty: its variations and targeting
    // must be written again even though their inputs are unchanged
    if (previousEntry && !plan.exists) recreatedConfigs.add(key);
    const hash = await hashAgentControlInput(
      payloadFor(config, plan.destKey, plan.destName),
    );
    let outcome = await upsertAgentControlResource(
      client,
      configBase,
      `${configBase}/${plan.destKey}`,
      payloadFor(config, plan.destKey, plan.destName, plan.existingTags),
      options.dryRun,
      { sanitize: (r) => r, knownExisting: plan.exists },
    );
    if (options.dryRun && outcome === "created" && plan.exists) {
      outcome = "updated";
    }
    logStageOutcome("Config", key, outcome);
    recordOutcome(summary, outcome);
    configPlans.set(key, {
      destKey: plan.destKey,
      blocked: outcome === "skipped" || outcome === "error",
    });
    if (options.dryRun) continue;
    if (outcome === "created" || outcome === "updated") {
      expected.configs.add(plan.destKey);
      const entry = ensureConfig(key);
      entry.hash = hash;
      if (plan.destKey !== key) entry.destKey = plan.destKey;
      else delete entry.destKey;
    } else if (outcome === "error" && previousEntry) {
      delete manifest.configs[key].hash;
    }
  }
  // Variations and targeting of configs that were not part of configs.json keep their own key
  const planFor = (configKey: string) =>
    configPlans.get(configKey) ?? { destKey: configKey, blocked: false };

  // Stage 3: variations
  const variationFiles = await listVariationFiles(aiRoot);
  console.log(
    Colors.gray(`  Migrating ${variationFiles.length} variation(s)...`),
  );
  for (const { configKey, variationKey, filePath } of variationFiles) {
    if (aborted) break;
    const configPlan = planFor(configKey);
    if (configPlan.blocked) {
      console.log(Colors.gray(
        `  → Variation ${configKey}/${variationKey}: skipped (its config was not written)`,
      ));
      recordOutcome(summary, "skipped");
      continue;
    }
    const variation = await getJson(filePath) as
      | Record<string, unknown>
      | undefined;
    if (!variation) {
      recordOutcome(summary, "error");
      continue;
    }
    const hash = await hashAgentControlInput({
      destConfigKey: configPlan.destKey,
      variation: sanitizeVariationPayload(variation),
    });
    const previousHash = ownEntry(
      ownEntry(previous?.configs, configKey)?.variations,
      variationKey,
    )?.hash;
    if (
      options.incremental && previousHash === hash &&
      !recreatedConfigs.has(configKey)
    ) {
      console.log(Colors.gray(
        `  → Variation ${configKey}/${variationKey}: unchanged, skipping (--incremental)`,
      ));
      recordOutcome(summary, "skipped");
      continue;
    }
    const outcome = await upsertAgentControlResource(
      client,
      `projects/${dest}/ai-configs/${configPlan.destKey}/variations`,
      `projects/${dest}/ai-configs/${configPlan.destKey}/variations/${variationKey}`,
      variation,
      options.dryRun,
      { sanitize: sanitizeVariationPayload },
    );
    logStageOutcome("Variation", `${configKey}/${variationKey}`, outcome);
    recordOutcome(summary, outcome);
    if (options.dryRun) continue;
    if (outcome === "created" || outcome === "updated") {
      ensureConfig(configKey).variations[variationKey] = { hash };
    } else if (
      outcome === "error" &&
      Object.hasOwn(manifest.configs, configKey) &&
      Object.hasOwn(manifest.configs[configKey].variations, variationKey)
    ) {
      delete manifest.configs[configKey].variations[variationKey].hash;
    }
  }

  // Stage 4: targeting via semantic patch on /targeting
  const targetingFiles = await listTargetingFiles(aiRoot);
  console.log(
    Colors.gray(`  Migrating ${targetingFiles.length} targeting file(s)...`),
  );
  for (const { configKey, filePath } of targetingFiles) {
    if (aborted) break;
    const configPlan = planFor(configKey);
    if (configPlan.blocked) {
      console.log(Colors.gray(
        `  → Targeting ${configKey}: skipped (its config was not written)`,
      ));
      recordOutcome(summary, "skipped");
      continue;
    }
    const targeting = await getJson(filePath) as
      | Record<string, unknown>
      | undefined;
    if (!targeting) {
      recordOutcome(summary, "error");
      continue;
    }

    const outcome = await migrateConfigTargeting(
      client,
      dest,
      configPlan.destKey,
      configKey,
      targeting,
      aiRoot,
      envMapping,
      options.dryRun,
      {
        incremental: options.incremental && !recreatedConfigs.has(configKey),
        previousHashes: ownEntry(previous?.configs, configKey)?.targeting,
        record: (sourceEnv, hash) => {
          if (options.dryRun) return;
          if (hash) {
            ensureConfig(configKey).targeting[sourceEnv] = { hash };
          } else if (
            Object.hasOwn(manifest.configs, configKey) &&
            Object.hasOwn(manifest.configs[configKey].targeting, sourceEnv)
          ) {
            delete manifest.configs[configKey].targeting[sourceEnv].hash;
          }
        },
      },
    );
    logStageOutcome("Targeting", configKey, outcome);
    recordOutcome(summary, outcome);
  }

  console.log(Colors.cyan("\nAgentControl summary:"));
  console.log(Colors.gray(`  Created: ${summary.created}`));
  console.log(Colors.gray(`  Updated: ${summary.updated}`));
  console.log(Colors.gray(`  Skipped: ${summary.skipped}`));
  console.log(Colors.gray(`  Errors: ${summary.errors}`));
  if (aborted) {
    console.log(Colors.red("  Stopped early: --on-conflict abort"));
  }

  return finish();
}

function logStageOutcome(
  label: string,
  key: string,
  outcome: UpsertOutcome,
): void {
  if (outcome === "created") {
    console.log(Colors.green(`  ✓ ${label} ${key}: created`));
  } else if (outcome === "updated") {
    console.log(Colors.green(`  ✓ ${label} ${key}: updated`));
  } else if (outcome === "skipped") {
    console.log(Colors.yellow(`  ⚠ ${label} ${key}: skipped`));
  } else {
    console.log(Colors.red(`  ✗ ${label} ${key}: failed`));
  }
}

interface TargetingTracking {
  incremental?: boolean;
  /** Per source environment key, from the previous sync manifest */
  previousHashes?: Record<string, { hash?: string }>;
  /** Called with the hash after a successful patch, or undefined when the environment failed or was not patched */
  record?: (sourceEnvKey: string, hash: string | undefined) => void;
}

/**
 * Semantic-patch a config's per-environment targeting. `configKey` is the source key (names the extract
 * files); `destConfigKey` is where the config lives in the destination, which differs after a prefix.
 */
async function migrateConfigTargeting(
  client: AgentControlHttpClient,
  dest: string,
  destConfigKey: string,
  configKey: string,
  targeting: Record<string, unknown>,
  aiRoot: string,
  envMapping: Record<string, string>,
  dryRun: boolean,
  tracking: TargetingTracking = {},
): Promise<UpsertOutcome> {
  const environments = (targeting.environments ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const allEnvKeys = Object.keys(environments);
  if (allEnvKeys.length === 0) {
    return "skipped";
  }

  const sourceVariations = await loadSourceVariationRefs(
    aiRoot,
    configKey,
    targeting,
  );

  // --incremental: environments whose inputs are unchanged since the last sync are not patched again
  const hashes = new Map<string, string>();
  const envKeys: string[] = [];
  for (const sourceEnvKey of allEnvKeys) {
    const destEnvKey = envMapping[sourceEnvKey] ?? sourceEnvKey;
    const hash = await hashAgentControlInput({
      destConfigKey,
      destEnvKey,
      environment: environments[sourceEnvKey],
      variations: sourceVariations,
    });
    hashes.set(sourceEnvKey, hash);
    if (
      tracking.incremental &&
      ownEntry(tracking.previousHashes, sourceEnvKey)?.hash === hash
    ) {
      console.log(Colors.gray(
        `    → ${configKey}/${sourceEnvKey}: targeting unchanged, skipping (--incremental)`,
      ));
      continue;
    }
    envKeys.push(sourceEnvKey);
  }
  if (envKeys.length === 0) return "skipped";

  const destVariationIdByKey = await loadDestVariationIdByKey(
    client,
    dest,
    destConfigKey,
    sourceVariations,
    dryRun,
  );

  if (destVariationIdByKey.size === 0 && !dryRun) {
    console.log(Colors.yellow(
      `    ⚠ No destination variations found for ${destConfigKey}; skipping targeting`,
    ));
    for (const k of envKeys) tracking.record?.(k, undefined);
    return "skipped";
  }

  let anyUpdated = false;
  let anyError = false;

  for (const sourceEnvKey of envKeys) {
    const destEnvKey = envMapping[sourceEnvKey] ?? sourceEnvKey;
    const { instructions, warnings } = buildTargetingInstructionsForEnvironment(
      environments[sourceEnvKey],
      sourceVariations,
      destVariationIdByKey,
    );
    for (const w of warnings) {
      console.log(Colors.yellow(`    ⚠ ${configKey}/${sourceEnvKey}: ${w}`));
      if (isCriticalTargetingWarning(w)) anyError = true;
    }
    if (instructions.length === 0) {
      anyError = true;
      tracking.record?.(sourceEnvKey, undefined);
      continue;
    }

    if (dryRun) {
      console.log(Colors.gray(
        `    [DRY RUN] Would semantic-patch targeting ${destConfigKey} env=${destEnvKey} (${instructions.length} instruction(s))`,
      ));
      if (!warnings.some(isCriticalTargetingWarning)) {
        anyUpdated = true;
      }
      continue;
    }

    if (!client.semanticPatch) {
      console.log(Colors.red("    ✗ semanticPatch client not available"));
      anyError = true;
      tracking.record?.(sourceEnvKey, undefined);
      continue;
    }

    // Do not apply a partial targeting patch when critical mappings failed
    if (warnings.some(isCriticalTargetingWarning)) {
      tracking.record?.(sourceEnvKey, undefined);
      continue;
    }

    const resp = await client.semanticPatch(
      `projects/${dest}/ai-configs/${destConfigKey}/targeting`,
      {
        environmentKey: destEnvKey,
        comment: "Migrated by ld-migration-scripts AgentControl",
        instructions,
      },
    );

    if (resp.status >= 200 && resp.status < 300) {
      anyUpdated = true;
      tracking.record?.(sourceEnvKey, hashes.get(sourceEnvKey));
    } else if (isAgentControlUnavailable(resp.status)) {
      return "skipped";
    } else {
      logUpsertFailure(
        "SEMANTIC PATCH targeting",
        `${destConfigKey}/${destEnvKey}`,
        resp.status,
        resp.body,
      );
      anyError = true;
      tracking.record?.(sourceEnvKey, undefined);
    }
  }

  if (anyError) return "error";
  if (anyUpdated) return "updated";
  return "skipped";
}

async function loadSourceVariationRefs(
  aiRoot: string,
  configKey: string,
  targeting: Record<string, unknown>,
): Promise<SourceVariationRef[]> {
  const fromTargeting = Array.isArray(targeting.variations)
    ? targeting.variations as Record<string, unknown>[]
    : [];
  const files = await listVariationFiles(aiRoot);
  const fileVars = files
    .filter((f) => f.configKey === configKey)
    .map(async (f) =>
      await getJson(f.filePath) as Record<string, unknown> | undefined
    );
  const loadedFiles = (await Promise.all(fileVars)).filter(Boolean) as Record<
    string,
    unknown
  >[];

  if (fromTargeting.length > 0) {
    return buildSourceVariationRefsFromTargeting(fromTargeting, loadedFiles);
  }

  return loadedFiles
    .map((v) => ({
      key: resolveVariationKey(v) || String(v.key ?? ""),
      _id: String(v._id ?? ""),
    }))
    .filter((v) => v.key);
}

async function loadDestVariationIdByKey(
  client: AgentControlHttpClient,
  dest: string,
  configKey: string,
  sourceVariations: SourceVariationRef[],
  dryRun: boolean,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (dryRun) {
    // Stable fake IDs so instruction builders can run in dry-run tests
    for (const v of sourceVariations) {
      if (v.key) map.set(v.key, `dry-run-${v.key}`);
    }
    return map;
  }
  if (!client.get) return map;

  // The targeting resource lists every variation targeting can name, including the built-in "disabled"
  // (and "enabled") ones that the config detail omits; the config detail fills any gap.
  for (
    const path of [
      `projects/${dest}/ai-configs/${configKey}/targeting`,
      `projects/${dest}/ai-configs/${configKey}`,
    ]
  ) {
    const resp = await client.get(path);
    if (resp.status < 200 || resp.status >= 300 || !resp.json) continue;
    const detail = resp.json as Record<string, unknown>;
    const variations = Array.isArray(detail.variations)
      ? detail.variations as Record<string, unknown>[]
      : [];
    for (const v of variations) {
      const key = resolveVariationKey(v) || String(v.key ?? "");
      const id = String(v._id ?? "");
      if (key && id && !map.has(key)) map.set(key, id);
    }
  }
  return map;
}

async function collectReferencedModelKeysFromExtract(
  aiRoot: string,
): Promise<Set<string>> {
  const records: Record<string, unknown>[] = [];
  for (const file of await listVariationFiles(aiRoot)) {
    const v = await getJson(file.filePath) as
      | Record<string, unknown>
      | undefined;
    if (v) records.push(v);
  }
  for (const file of await listTargetingFiles(aiRoot)) {
    const t = await getJson(file.filePath) as
      | Record<string, unknown>
      | undefined;
    if (!t) continue;
    if (Array.isArray(t.variations)) {
      records.push(...t.variations as Record<string, unknown>[]);
    }
  }
  return collectReferencedModelConfigKeys(records);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const st = await Deno.stat(path);
    return st.isDirectory;
  } catch {
    return false;
  }
}

async function listVariationFiles(
  aiRoot: string,
): Promise<
  Array<{ configKey: string; variationKey: string; filePath: string }>
> {
  const out: Array<
    { configKey: string; variationKey: string; filePath: string }
  > = [];
  const variationsRoot = `${aiRoot}/variations`;
  if (!(await directoryExists(variationsRoot))) return out;
  for await (const configDir of Deno.readDir(variationsRoot)) {
    if (!configDir.isDirectory) continue;
    const configKey = configDir.name;
    for await (const file of Deno.readDir(`${variationsRoot}/${configKey}`)) {
      if (!file.isFile || !file.name.endsWith(".json")) continue;
      const variationKey = file.name.replace(/\.json$/i, "");
      out.push({
        configKey,
        variationKey,
        filePath: `${variationsRoot}/${configKey}/${file.name}`,
      });
    }
  }
  return out;
}

async function listTargetingFiles(
  aiRoot: string,
): Promise<Array<{ configKey: string; filePath: string }>> {
  const out: Array<{ configKey: string; filePath: string }> = [];
  const targetingRoot = `${aiRoot}/targeting`;
  if (!(await directoryExists(targetingRoot))) return out;
  for await (const file of Deno.readDir(targetingRoot)) {
    if (!file.isFile || !file.name.endsWith(".json")) continue;
    out.push({
      configKey: file.name.replace(/\.json$/i, ""),
      filePath: `${targetingRoot}/${file.name}`,
    });
  }
  return out;
}

/** Workflow helper: should extract AgentControl? */
export function shouldExtractAgentControl(options: {
  includeAgentControl?: boolean;
  migrateAgentControl?: boolean;
}): boolean {
  return options.includeAgentControl === true ||
    options.migrateAgentControl === true;
}

/** CLI args for source_from_ld when AgentControl extract should run. */
export function agentControlExtractCliArgs(options: {
  includeAgentControl?: boolean;
  migrateAgentControl?: boolean;
}): string[] {
  return shouldExtractAgentControl(options)
    ? ["--extract-agent-control=true"]
    : [];
}

/** CLI args for migrate when AgentControl migrate is enabled. */
export function agentControlMigrateCliArgs(
  migrateAgentControl?: boolean,
): string[] {
  return migrateAgentControl === true ? ["--migrate-agent-control"] : [];
}
