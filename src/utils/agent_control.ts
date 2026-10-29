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

/** How much of an API error body is logged and reported. */
const BODY_LOG_LIMIT = 500;

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

export type AgentControlReportStage =
  | "extract"
  | "model-configs"
  | "configs"
  | "variations"
  | "targeting"
  | "variation-state";

/** A resource (or part of one) that was not migrated, with why. */
export interface AgentControlFailure {
  stage: AgentControlReportStage;
  /** Source key: `config`, `config/variation`, `config/environment` or a model key */
  key: string;
  /** Destination key when it differs from the source key (conflict prefix) */
  destKey?: string;
  status?: number;
  reason: string;
}

/** Something that was migrated, or deliberately left alone, but differs from the source. */
export interface AgentControlWarning {
  stage: AgentControlReportStage;
  key: string;
  message: string;
}

/** A model referenced by the extract that the destination does not offer. */
export interface AgentControlMissingModel {
  /** The destination key that was looked for (the mapped key when a model mapping applies) */
  modelKey: string;
  /** `config/variation` keys that use it */
  usedBy: string[];
  /** The source model key, when `modelKey` comes from the model mapping */
  mappedFrom?: string;
  /** Destination models that look like the same model, candidates for the model mapping */
  suggestions?: string[];
}

/** A source model that variations reference under a different destination key (model mapping). */
export interface AgentControlModelMappingUse {
  sourceKey: string;
  destKey: string;
  /** `config/variation` keys that use it */
  usedBy: string[];
}

/** What a default rule does when the variation it serves cannot be migrated. */
export type UnmappedDefaultRule = "leave" | "disabled";

/** Source model key -> destination model key. */
export type AgentControlModelMapping = Record<string, string>;

/** The destination model key for a source model key. Mappings are a single hop. */
export function mapModelKey(
  key: string,
  mapping: AgentControlModelMapping | undefined,
): string {
  return mapping && Object.hasOwn(mapping, key) ? mapping[key] : key;
}

/**
 * Validate a model mapping (an object, or its JSON text from the CLI). Throws with the reason when it
 * is not an object of non-empty strings; entries that map a key to itself are dropped.
 */
export function parseModelMapping(
  raw: unknown,
): AgentControlModelMapping | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `the AgentControl model mapping is not valid JSON: ${
          errorMessage(error)
        }`,
      );
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "the AgentControl model mapping must be an object of source model key -> destination model key",
    );
  }
  const entries: Array<[string, string]> = [];
  for (const [from, to] of Object.entries(value as Record<string, unknown>)) {
    if (!from.trim() || typeof to !== "string" || !to.trim()) {
      throw new Error(
        `the AgentControl model mapping entry ${
          JSON.stringify(from)
        } must map to a non-empty destination model key`,
      );
    }
    if (from.trim() !== to.trim()) entries.push([from.trim(), to.trim()]);
  }
  // fromEntries defines own properties, so a "__proto__" key stays an entry
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Validate the unmapped default rule setting; unset means "leave". */
export function parseUnmappedDefaultRule(raw: unknown): UnmappedDefaultRule {
  if (raw === undefined || raw === null || raw === "") return "leave";
  if (raw === "leave" || raw === "disabled") return raw;
  throw new Error(
    `the AgentControl unmapped default rule must be "leave" or "disabled", not ${
      JSON.stringify(raw)
    }`,
  );
}

/**
 * A copy of a variation with its model references (`modelConfigKey`, and `modelKey`/`modelConfigKey`
 * in its `value` metadata) rewritten through the mapping. Returns the variation itself when nothing maps.
 */
export function applyModelMapping(
  variation: Record<string, unknown>,
  mapping: AgentControlModelMapping | undefined,
): Record<string, unknown> {
  if (!mapping) return variation;
  const remap = (record: Record<string, unknown>, fields: string[]) => {
    let out: Record<string, unknown> | undefined;
    for (const field of fields) {
      const key = record[field];
      if (typeof key !== "string" || !key) continue;
      const mapped = mapModelKey(key, mapping);
      if (mapped === key) continue;
      out ??= { ...record };
      out[field] = mapped;
    }
    return out;
  };

  let result = remap(variation, ["modelConfigKey"]);
  const value = variation.value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const valueRecord = value as Record<string, unknown>;
    const ldMeta = valueRecord._ldMeta;
    let mappedValue: Record<string, unknown> | undefined;
    if (ldMeta && typeof ldMeta === "object") {
      const mappedMeta = remap(ldMeta as Record<string, unknown>, [
        "modelKey",
        "modelConfigKey",
      ]);
      if (mappedMeta) mappedValue = { ...valueRecord, _ldMeta: mappedMeta };
    } else {
      // Agent-mode values carry the metadata as the value itself
      mappedValue = remap(valueRecord, ["modelKey", "modelConfigKey"]);
    }
    if (mappedValue) {
      result ??= { ...variation };
      result.value = mappedValue;
    }
  }
  return result ?? variation;
}

const providerName = (value: unknown): string | undefined => {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object") {
    const name = (value as Record<string, unknown>).name;
    if (typeof name === "string" && name) return name;
  }
  return undefined;
};

/** Provider and model ID of a model config, falling back to the `Provider.model-id` key shape. */
function modelIdentity(
  key: string,
  model: Record<string, unknown> | undefined,
): { provider?: string; id?: string } {
  const dot = key.indexOf(".");
  const provider = providerName(model?.provider) ??
    (dot > 0 ? key.slice(0, dot) : undefined);
  const id = typeof model?.id === "string" && model.id
    ? model.id
    : dot > 0
    ? key.slice(dot + 1)
    : undefined;
  return { provider: provider?.toLowerCase(), id: id?.toLowerCase() };
}

/**
 * Destination model keys that look like a source model: the same provider and model ID (a custom model
 * of the same underlying model), or a key that starts with the source key (generated suffixes).
 */
export function suggestModelMappings(
  sourceKey: string,
  sourceModel: Record<string, unknown> | undefined,
  destModels: Iterable<Record<string, unknown>>,
  limit = 5,
): string[] {
  const source = modelIdentity(sourceKey, sourceModel);
  const prefix = sourceKey.toLowerCase();
  const matches = new Set<string>();
  for (const model of destModels) {
    const key = String(model.key ?? "");
    if (!key || key === sourceKey) continue;
    const dest = modelIdentity(key, model);
    const sameModel = source.provider !== undefined &&
      source.id !== undefined &&
      dest.provider === source.provider && dest.id === source.id;
    if (sameModel || key.toLowerCase().startsWith(prefix)) matches.add(key);
  }
  return [...matches].sort().slice(0, limit);
}

/**
 * YAML lines for `migration.agentControlModelMapping` from the missing models' suggestions: an entry for
 * each model with exactly one candidate, a comment listing the candidates otherwise.
 */
export function modelMappingSnippet(
  missingModels: AgentControlMissingModel[],
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const m of missingModels) {
    const sourceKey = m.mappedFrom ?? m.modelKey;
    const suggestions = m.suggestions ?? [];
    if (seen.has(sourceKey) || suggestions.length === 0) continue;
    seen.add(sourceKey);
    lines.push(
      suggestions.length === 1
        ? `    ${JSON.stringify(sourceKey)}: ${JSON.stringify(suggestions[0])}`
        : `    # ${JSON.stringify(sourceKey)}: one of ${
          suggestions.join(", ")
        }`,
    );
  }
  return lines.length > 0
    ? ["migration:", "  agentControlModelMapping:", ...lines]
    : [];
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
  // Archived variations are archived last, once targeting no longer needs them active
  "variation-state",
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
  // The targeting resource carries the metadata as the value itself; other shapes wrap it in `_ldMeta`
  const meta = value && typeof value === "object"
    ? (value as Record<string, unknown>)._ldMeta ?? value
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
      const meta = (value as Record<string, unknown>)._ldMeta ?? value;
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
  // A 403/404 on a write is a failure of that write (for example a missing model or environment), not a
  // sign that AgentControl is unavailable: that is only decided by the extract's first list call
  return "error";
}

export interface PaginatedItems {
  items: Record<string, unknown>[];
  unavailable: boolean;
  /** Set when a page could not be read: `items` holds only the pages read before it */
  error?: { status?: number; reason: string };
}

type AgentControlGet = (
  path: string,
) => Promise<{ status: number; json?: unknown; body?: string }>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Paginate a collection endpoint that returns { items, totalCount? } (or a bare array).
 * On 403/404 sets unavailable and returns empty items; any other failure sets `error`.
 */
export async function listAgentControlCollection(
  get: AgentControlGet,
  basePath: string,
  pageSize = 50,
): Promise<PaginatedItems> {
  const items: Record<string, unknown>[] = [];
  let offset = 0;

  while (true) {
    const sep = basePath.includes("?") ? "&" : "?";
    const path = `${basePath}${sep}limit=${pageSize}&offset=${offset}`;
    let resp: Awaited<ReturnType<AgentControlGet>>;
    try {
      resp = await get(path);
    } catch (error) {
      return {
        items,
        unavailable: false,
        error: { reason: errorMessage(error) },
      };
    }

    if (isAgentControlUnavailable(resp.status)) {
      return { items: [], unavailable: true };
    }
    if (resp.status < 200 || resp.status >= 300) {
      return {
        items,
        unavailable: false,
        error: {
          status: resp.status,
          reason: resp.body?.slice(0, BODY_LOG_LIMIT) || `HTTP ${resp.status}`,
        },
      };
    }

    const data = resp.json as
      | { items?: unknown; totalCount?: unknown; _links?: { next?: unknown } }
      | unknown[]
      | undefined;
    const pageItems = (Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
      ? data.items
      : []) as Record<string, unknown>[];
    items.push(...pageItems);

    const paged = Array.isArray(data) ? undefined : data;
    const totalCount = typeof paged?.totalCount === "number"
      ? paged.totalCount
      : items.length;
    if (
      pageItems.length > 0 &&
      (items.length < totalCount || paged?._links?.next)
    ) {
      offset += pageSize;
    } else {
      return { items, unavailable: false };
    }
  }
}

export interface ExtractAgentControlOptions {
  apiKey: string;
  domain: string;
  projectKey: string;
  projPath: string;
  writeJson: (filePathWithoutExt: string, data: unknown) => Promise<void>;
  ensureDir: (path: string) => void;
  /** Optional injected reader for tests; defaults to the rate-limited API client */
  client?: Pick<AgentControlHttpClient, "get">;
}

export interface ExtractAgentControlResult {
  skipped: boolean;
  configCount: number;
  variationCount: number;
  modelCount: number;
  /** Configs whose targeting was written */
  targetingCount: number;
  /** Reads that failed: the extract is incomplete for these */
  failures: AgentControlFailure[];
}

/** Extract model-configs, configs, variations, and targeting to disk. */
export async function extractAgentControlResources(
  options: ExtractAgentControlOptions,
): Promise<ExtractAgentControlResult> {
  const { apiKey, domain, projectKey, projPath, writeJson, ensureDir } =
    options;
  const get = options.client?.get ?? defaultHttpClient(apiKey, domain).get!;
  const root = agentControlRoot(projPath);
  ensureDir(root);
  const failures: AgentControlFailure[] = [];
  const fail = (key: string, reason: string, status?: number) => {
    failures.push({
      stage: "extract",
      key,
      reason,
      ...(status !== undefined ? { status } : {}),
    });
    console.log(Colors.red(
      `  ✗ ${key}: ${reason}${status !== undefined ? ` (HTTP ${status})` : ""}`,
    ));
  };
  const empty = (modelCount = 0): ExtractAgentControlResult => ({
    skipped: true,
    configCount: 0,
    variationCount: 0,
    modelCount,
    targetingCount: 0,
    failures,
  });

  console.log(Colors.cyan("\nExtracting AgentControl (AI Configs) data..."));

  const models = await listAgentControlCollection(
    get,
    `projects/${projectKey}/ai-configs/model-configs`,
  );
  if (models.unavailable) {
    console.log(Colors.yellow(
      "Skipping AgentControl extract (not available for this account/project)",
    ));
    return empty();
  }
  if (models.error) {
    fail(
      "model-configs",
      `listing model configs failed: ${models.error.reason}`,
      models.error.status,
    );
  }

  await writeJson(`${root}/model-configs`, {
    items: models.items,
    totalCount: models.items.length,
  });
  console.log(Colors.gray(`  Found ${models.items.length} model config(s)`));

  const configs = await listAgentControlCollection(
    get,
    `projects/${projectKey}/ai-configs`,
  );
  if (configs.unavailable) {
    console.log(Colors.yellow(
      "Skipping AgentControl extract (not available for this account/project)",
    ));
    return empty(models.items.length);
  }
  if (configs.error) {
    fail(
      "configs",
      `listing configs failed after ${configs.items.length} config(s): ${configs.error.reason}`,
      configs.error.status,
    );
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

  // An earlier extract's targeting must not be migrated as if it were current
  const removeStaleTargeting = (configKey: string) =>
    Deno.remove(targetingPath(projPath, configKey)).catch(() => {});

  let variationCount = 0;
  let targetingCount = 0;
  for (const config of configs.items) {
    const configKey = String(config.key ?? "");
    if (!configKey) continue;

    // Prefer full GET for embedded variations
    let detail: Record<string, unknown> = config;
    try {
      const detailResp = await get(
        `projects/${projectKey}/ai-configs/${configKey}`,
      );
      if (detailResp.status >= 200 && detailResp.status < 300) {
        detail = (detailResp.json ?? config) as Record<string, unknown>;
      } else {
        fail(
          configKey,
          `reading the config failed: ${
            detailResp.body?.slice(0, BODY_LOG_LIMIT) || "no response body"
          }`,
          detailResp.status,
        );
        if (isAgentControlUnavailable(detailResp.status)) {
          await removeStaleTargeting(configKey);
          continue;
        }
      }
    } catch (error) {
      fail(configKey, `reading the config failed: ${errorMessage(error)}`);
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

    if (variations.length === 0 && detail.mode !== "agent") {
      const listed = await listAgentControlCollection(
        get,
        `projects/${projectKey}/ai-configs/${configKey}/variations`,
      );
      // 405: the config has no variation collection (agent mode); nothing to extract
      if (listed.error && listed.error.status !== 405) {
        fail(
          `${configKey}/variations`,
          `listing variations failed: ${listed.error.reason}`,
          listed.error.status,
        );
      }
      for (const v of listed.items) {
        await writeVariation(v);
      }
    } else {
      for (const v of variations) {
        await writeVariation(v);
      }
    }

    // Dedicated targeting endpoint (not fields scraped from config detail)
    try {
      const targetingResp = await get(
        `projects/${projectKey}/ai-configs/${configKey}/targeting`,
      );
      if (targetingResp.status >= 200 && targetingResp.status < 300) {
        const targeting = (targetingResp.json ?? {}) as Record<string, unknown>;
        targeting.key = configKey;
        if (targetingHasRules(targeting)) {
          // The targeting resource omits what each rule serves (and clause context kinds); the
          // config's backing flag carries them. The flags API is read-only for AI Configs.
          const flagResp = await get(`flags/${projectKey}/${configKey}`);
          if (
            flagResp.status >= 200 && flagResp.status < 300 && flagResp.json
          ) {
            const unmatched = mergeFlagRulesIntoTargeting(
              targeting,
              flagResp.json as Record<string, unknown>,
            );
            for (const envKey of unmatched) {
              fail(
                `${configKey}/targeting`,
                `targeting rules in environment ${envKey} differ from its flag's rules; what they serve is unknown and they will not be migrated`,
              );
            }
          } else {
            fail(
              `${configKey}/targeting`,
              `reading the rules' variations (flags/${projectKey}/${configKey}) failed; its targeting rules will not be migrated: ${
                flagResp.body?.slice(0, BODY_LOG_LIMIT) || "no response body"
              }`,
              flagResp.status,
            );
          }
        }
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
        targetingCount++;
      } else {
        await removeStaleTargeting(configKey);
        fail(
          `${configKey}/targeting`,
          `reading targeting failed, its targeting will not be migrated: ${
            targetingResp.body?.slice(0, BODY_LOG_LIMIT) || "no response body"
          }`,
          targetingResp.status,
        );
      }
    } catch (error) {
      await removeStaleTargeting(configKey);
      fail(
        `${configKey}/targeting`,
        `reading targeting failed, its targeting will not be migrated: ${
          errorMessage(error)
        }`,
      );
    }
  }

  console.log(Colors.gray(`  Found ${variationCount} variation(s)`));
  console.log(Colors.gray(
    `  Targeting extracted for ${targetingCount} of ${configs.items.length} config(s)`,
  ));
  if (failures.length > 0) {
    console.log(Colors.red(
      `\n  ✗ AgentControl extract incomplete: ${failures.length} read(s) failed`,
    ));
    for (const f of failures) {
      console.log(Colors.red(
        `    ✗ ${f.key}${
          f.status !== undefined ? ` (HTTP ${f.status})` : ""
        }: ${f.reason}`,
      ));
    }
  }
  return {
    skipped: false,
    configCount: configs.items.length,
    variationCount,
    modelCount: models.items.length,
    targetingCount,
    failures,
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
      body ? `: ${body.slice(0, BODY_LOG_LIMIT)}` : ""
    }`,
  ));
}

/** A failed write, as reported to `onFailure`. */
export interface UpsertFailure {
  action: "POST" | "PATCH";
  path: string;
  status: number;
  body?: string;
}

/** Report reason for a failed write: the API's message when it sent one. */
export function upsertFailureReason(failure: UpsertFailure): string {
  const body = failure.body?.trim();
  return `${failure.action} ${failure.path} failed${
    body ? `: ${body.slice(0, BODY_LOG_LIMIT)}` : ""
  }`;
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
    /**
     * Model configs only: an existing model config that rejects the update (400/405/422) is built-in or
     * immutable and is left as it is. For any other resource that rejection is an error.
     */
    immutableSkip?: boolean;
    /** Called with the failed request when the outcome is "error" */
    onFailure?: (failure: UpsertFailure) => void;
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
  const failed = (failure: UpsertFailure): UpsertOutcome => {
    logUpsertFailure(
      failure.action,
      failure.path,
      failure.status,
      failure.body,
    );
    options?.onFailure?.(failure);
    return "error";
  };

  const createResp = options?.knownExisting
    ? { status: 409 as number, body: undefined }
    : await client.post(createPath, body);
  if (createResp.status >= 200 && createResp.status < 300) {
    return "created";
  }
  if (createResp.status === 409) {
    // Merge-style object PATCH (AI Configs model/config/variation updates use JSON body objects)
    const patchResp = await client.patch(updatePath, body);
    if (patchResp.status >= 200 && patchResp.status < 300) {
      return "updated";
    }
    if (
      options?.immutableSkip &&
      (patchResp.status === 400 || patchResp.status === 405 ||
        patchResp.status === 422)
    ) {
      console.log(Colors.yellow(
        `    ⚠ ${updatePath} rejected the update (${patchResp.status}); leaving the existing model config as it is${
          patchResp.body ? `: ${patchResp.body.slice(0, BODY_LOG_LIMIT)}` : ""
        }`,
      ));
      return "skipped";
    }
    return failed({
      action: "PATCH",
      path: updatePath,
      status: patchResp.status,
      body: patchResp.body,
    });
  }

  return failed({
    action: "POST",
    path: createPath,
    status: createResp.status,
    body: createResp.body,
  });
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
  /**
   * Source model key -> destination model key, for destination models whose key differs (custom models
   * get generated keys). Mapped source models are not created; variations are written with the mapped key.
   */
  modelMapping?: AgentControlModelMapping;
  /** What a default rule does when the variation it serves cannot be migrated (default: leave) */
  unmappedDefaultRule?: UnmappedDefaultRule;
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
  /** Everything that was not migrated, with why; `summary.errors` counts these */
  failures: AgentControlFailure[];
  /** Migrated, or deliberately left alone, but different from the source */
  warnings: AgentControlWarning[];
  /** Models the extract uses that the destination does not offer (their variations are failures) */
  missingModels: AgentControlMissingModel[];
  /** Source models that variations use under their mapped destination key */
  modelMappings: AgentControlModelMappingUse[];
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

/** True when any environment of an AI Config targeting resource has targeting rules. */
export function targetingHasRules(targeting: Record<string, unknown>): boolean {
  const environments = (targeting.environments ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  return Object.values(environments).some((env) =>
    Array.isArray(env?.rules) && env.rules.length > 0
  );
}

/**
 * Replace each environment's targeting rules with its backing flag's rules, which carry what each rule
 * serves (as a variation `_id`, the same IDs the targeting resource uses), its description and the
 * clauses' context kinds. The flag's variation indexes are converted to IDs so they never depend on the
 * order of the targeting resource's list. Returns the environments whose rules could not be matched.
 */
export function mergeFlagRulesIntoTargeting(
  targeting: Record<string, unknown>,
  flag: Record<string, unknown>,
): string[] {
  const flagVariations = Array.isArray(flag.variations)
    ? flag.variations as Record<string, unknown>[]
    : [];
  // An index with no ID must not be read against the targeting resource's (differently ordered) list
  const idAt = (index: unknown) =>
    typeof index === "number" && typeof flagVariations[index]?._id === "string"
      ? flagVariations[index]._id as string
      : `flag variation ${String(index)}`;
  const environments = (targeting.environments ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const flagEnvironments = (flag.environments ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const unmatched: string[] = [];

  for (const [envKey, env] of Object.entries(environments)) {
    const rules = Array.isArray(env?.rules)
      ? env.rules as Record<string, unknown>[]
      : [];
    if (rules.length === 0) continue;
    const flagRules = Array.isArray(flagEnvironments[envKey]?.rules)
      ? flagEnvironments[envKey].rules as Record<string, unknown>[]
      : undefined;
    const clauseIds = (rule: Record<string, unknown>) =>
      (Array.isArray(rule.clauses) ? rule.clauses : [])
        .map((c) =>
          String(
            (c as Record<string, unknown>).id ??
              (c as Record<string, unknown>)._id ?? "",
          )
        )
        .join(",");
    if (
      !flagRules || flagRules.length !== rules.length ||
      rules.some((rule, i) => clauseIds(rule) !== clauseIds(flagRules[i]))
    ) {
      unmatched.push(envKey);
      continue;
    }

    env.rules = flagRules.map((flagRule) => {
      const merged: Record<string, unknown> = {
        clauses: (Array.isArray(flagRule.clauses) ? flagRule.clauses : []).map(
          (c) => {
            const { _id: _clauseId, ...clause } = c as Record<string, unknown>;
            return clause;
          },
        ),
        trackEvents: flagRule.trackEvents === true,
      };
      if (typeof flagRule.description === "string" && flagRule.description) {
        merged.description = flagRule.description;
      }
      if (flagRule.variation !== undefined) {
        merged.variation = idAt(flagRule.variation);
      } else if (flagRule.rollout && typeof flagRule.rollout === "object") {
        const rollout = flagRule.rollout as Record<string, unknown>;
        merged.rollout = {
          ...rollout,
          variations: (Array.isArray(rollout.variations)
            ? rollout.variations as Record<string, unknown>[]
            : []).map((v) => ({
              ...v,
              variation: idAt(v.variation),
            })),
        };
      }
      return merged;
    });
  }
  return unmatched;
}

export type TargetingPart =
  | "rule"
  | "target"
  | "fallthrough"
  | "offVariation"
  | "trackEvents";

/**
 * Something in one environment's targeting that could not be migrated as it is in the source.
 * Errors are parts left out of the patch; warnings are settings the patch cannot carry.
 */
export interface TargetingIssue {
  severity: "error" | "warning";
  part: TargetingPart;
  /** Source key of the variation the part serves, when known */
  variationKey?: string;
  message: string;
}

export interface TargetingBuildOptions {
  /** "disabled": a default rule that cannot be mapped serves the destination's disabled variation */
  unmappedDefaultRule?: UnmappedDefaultRule;
  /** Key of the variation the destination's default rule serves now, named when it is left as it is */
  currentDefaultVariationKey?: string;
}

/**
 * Build semantic-patch instructions for one environment's targeting state. Whatever maps to destination
 * variations is applied; each rule, target list, default rule or off variation that does not is left out
 * and reported as an error issue. With `unmappedDefaultRule: "disabled"`, an unmappable default rule is
 * pointed at the disabled variation instead of being left out (still reported as an error).
 */
export function buildTargetingInstructionsForEnvironment(
  envConfig: Record<string, unknown>,
  sourceVariations: SourceVariationRef[],
  destVariationIdByKey: Map<string, string>,
  options: TargetingBuildOptions = {},
): { instructions: Record<string, unknown>[]; issues: TargetingIssue[] } {
  const issues: TargetingIssue[] = [];
  const instructions: Record<string, unknown>[] = [];
  const error = (
    part: TargetingPart,
    message: string,
    variationKey?: string,
  ) =>
    issues.push({
      severity: "error",
      part,
      message,
      ...(variationKey ? { variationKey } : {}),
    });

  const resolve = (ref: unknown) => {
    let key: string | undefined;
    if (typeof ref === "number") {
      key = sourceVariations[ref]?.key || undefined;
    } else if (typeof ref === "string") {
      key = sourceVariations.find((v) => v._id === ref && v.key)?.key ??
        // Direct key lookup (e.g. already-resolved variation key)
        (destVariationIdByKey.has(ref) ? ref : undefined);
    }
    return {
      destId: key ? destVariationIdByKey.get(key) : undefined,
      variationKey: key,
      label: key
        ? `"${key}"`
        : typeof ref === "number"
        ? `at index ${ref}`
        : `"${String(ref)}"`,
    };
  };

  /** Destination rollout weights, or the first source variation that has no destination copy. */
  const mapRollout = (
    rollout: Record<string, unknown>,
  ): {
    weights?: Record<string, number>;
    missing?: ReturnType<typeof resolve>;
  } => {
    const entries: Array<[unknown, number]> = Array.isArray(rollout.variations)
      ? (rollout.variations as Array<Record<string, unknown>>)
        // A rollout lists every variation, with weight 0 for those it does not serve
        .filter((v) => typeof v.weight === "number" && v.weight > 0)
        .map((v) => [v.variation ?? v.variationId, v.weight as number])
      : rollout.weights && typeof rollout.weights === "object"
      ? Object.entries(rollout.weights as Record<string, number>)
      : [];
    const weights: Record<string, number> = {};
    for (const [ref, weight] of entries) {
      const r = resolve(ref);
      if (!r.destId) return { missing: r };
      weights[r.destId] = (weights[r.destId] ?? 0) + weight;
    }
    return Object.keys(weights).length > 0 ? { weights } : {};
  };
  const rolloutFields = (rollout: Record<string, unknown>) => ({
    ...(typeof rollout.bucketBy === "string"
      ? { rolloutBucketBy: rollout.bucketBy }
      : {}),
    ...(typeof rollout.contextKind === "string"
      ? { rolloutContextKind: rollout.contextKind }
      : {}),
  });
  const notInDestination = (r: ReturnType<typeof resolve>) =>
    `variation ${r.label}, which is not in the destination`;

  // Rules
  const rules = Array.isArray(envConfig.rules)
    ? envConfig.rules as Record<string, unknown>[]
    : [];
  const mappedRules: Record<string, unknown>[] = [];
  rules.forEach((rule, index) => {
    const label = `Rule ${index + 1}${
      typeof rule.description === "string" && rule.description
        ? ` ("${rule.description}")`
        : ""
    }`;
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
      const r = resolve(rule.variationId ?? rule.variation);
      if (!r.destId) {
        error(
          "rule",
          `${label} not migrated: it serves ${notInDestination(r)}`,
          r.variationKey,
        );
        return;
      }
      mapped.variationId = r.destId;
    } else if (rule.rollout && typeof rule.rollout === "object") {
      const rollout = rule.rollout as Record<string, unknown>;
      const { weights, missing } = mapRollout(rollout);
      if (missing) {
        error(
          "rule",
          `${label} not migrated: its percentage rollout includes ${
            notInDestination(missing)
          }`,
          missing.variationKey,
        );
        return;
      }
      if (!weights) {
        error(
          "rule",
          `${label} not migrated: its percentage rollout has no weights`,
        );
        return;
      }
      mapped.rolloutWeights = weights;
      Object.assign(mapped, rolloutFields(rollout));
    } else {
      error(
        "rule",
        `${label} not migrated: the source did not report what it serves (neither a variation nor a rollout)`,
      );
      return;
    }
    if (rule.trackEvents === true) {
      issues.push({
        severity: "warning",
        part: "trackEvents",
        message:
          `${label} tracks events in the source; per-rule event tracking is not migrated`,
      });
    }
    mappedRules.push(mapped);
  });
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
  // User targets are listed in both `targets` and `contextTargets`
  const seenTargets = new Set<string>();
  for (const t of targetLists) {
    const values = Array.isArray(t.values) ? t.values : undefined;
    if (!values || values.length === 0) continue;
    const signature = stableStringify([
      t.contextKind ?? "user",
      t.variationId ?? t.variation,
      [...values].map(String).sort(),
    ]);
    if (seenTargets.has(signature)) continue;
    seenTargets.add(signature);
    const r = resolve(t.variationId ?? t.variation);
    if (!r.destId) {
      error(
        "target",
        `Individual targets (${values.length} ${
          typeof t.contextKind === "string" ? t.contextKind : "user"
        } context(s)) not migrated: they are served ${notInDestination(r)}`,
        r.variationKey,
      );
      continue;
    }
    mappedTargets.push({
      variationId: r.destId,
      values,
      ...(typeof t.contextKind === "string"
        ? { contextKind: t.contextKind }
        : {}),
    });
  }
  instructions.push({ kind: "replaceTargets", targets: mappedTargets });

  // Fallthrough (the default rule)
  const fallthrough = envConfig.fallthrough as
    | Record<string, unknown>
    | undefined;
  /** An unmappable default rule: left as the destination has it, or pointed at the disabled variation */
  const unmappedFallthrough = (message: string, variationKey?: string) => {
    const disabledId = options.unmappedDefaultRule === "disabled"
      ? destVariationIdByKey.get("disabled")
      : undefined;
    if (disabledId) {
      instructions.push({
        kind: "updateFallthroughVariationOrRollout",
        variationId: disabledId,
      });
      error(
        "fallthrough",
        `${message}; it was set to serve the disabled variation instead`,
        variationKey,
      );
      return;
    }
    const current = options.currentDefaultVariationKey;
    error(
      "fallthrough",
      current
        ? `${message}; the destination's default rule still serves "${current}"`
        : message,
      variationKey,
    );
  };
  if (fallthrough) {
    if (
      fallthrough.variation !== undefined ||
      fallthrough.variationId !== undefined
    ) {
      const r = resolve(fallthrough.variationId ?? fallthrough.variation);
      if (r.destId) {
        instructions.push({
          kind: "updateFallthroughVariationOrRollout",
          variationId: r.destId,
        });
      } else {
        unmappedFallthrough(
          `Default rule not migrated: it serves ${notInDestination(r)}`,
          r.variationKey,
        );
      }
    } else if (fallthrough.rollout && typeof fallthrough.rollout === "object") {
      const rollout = fallthrough.rollout as Record<string, unknown>;
      const { weights, missing } = mapRollout(rollout);
      if (weights) {
        instructions.push({
          kind: "updateFallthroughVariationOrRollout",
          rolloutWeights: weights,
          ...rolloutFields(rollout),
        });
      } else {
        unmappedFallthrough(
          missing
            ? `Default rule not migrated: its percentage rollout includes ${
              notInDestination(missing)
            }`
            : "Default rule not migrated: its percentage rollout has no weights",
          missing?.variationKey,
        );
      }
    }
  }

  // Off variation
  if (envConfig.offVariation !== undefined && envConfig.offVariation !== null) {
    const r = resolve(envConfig.offVariation);
    if (r.destId) {
      instructions.push({ kind: "updateOffVariation", variationId: r.destId });
    } else {
      error(
        "offVariation",
        `Off variation not migrated: it is ${notInDestination(r)}`,
        r.variationKey,
      );
    }
  }

  if (typeof envConfig.trackEvents === "boolean") {
    instructions.push({
      kind: "updateTrackEvents",
      trackEvents: envConfig.trackEvents,
    });
  }
  if (typeof envConfig.trackEventsFallthrough === "boolean") {
    instructions.push({
      kind: "updateTrackEventsFallthrough",
      trackEvents: envConfig.trackEventsFallthrough,
    });
  }

  // Undocumented in the API reference; a new config starts with targeting on in every environment
  if (typeof envConfig.enabled === "boolean") {
    instructions.push({
      kind: envConfig.enabled ? "enableTargeting" : "disableTargeting",
    });
  }

  return { instructions, issues };
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
  | { kind: "error"; reason: string };

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
  const failures: AgentControlFailure[] = [];
  const warnings: AgentControlWarning[] = [];
  const missingModels: AgentControlMissingModel[] = [];
  const modelMappings: AgentControlModelMappingUse[] = [];
  /** Records a failure and counts it as an error; the caller has already logged the request failure, if any */
  const fail = (
    stage: AgentControlReportStage,
    key: string,
    reason: string,
    extra: { status?: number; destKey?: string; log?: boolean } = {},
  ): void => {
    failures.push({
      stage,
      key,
      reason,
      ...(extra.destKey && extra.destKey !== key.split("/")[0]
        ? { destKey: extra.destKey }
        : {}),
      ...(extra.status !== undefined ? { status: extra.status } : {}),
    });
    summary.errors++;
    if (extra.log !== false) {
      console.log(Colors.red(`    ✗ ${key}: ${reason}`));
    }
  };
  const warn = (
    stage: AgentControlReportStage,
    key: string,
    message: string,
  ): void => {
    warnings.push({ stage, key, message });
    console.log(Colors.yellow(`    ⚠ ${key}: ${message}`));
  };
  /** A failed write's outcome is counted through `fail`, not `recordOutcome` */
  const writeFailure = (
    stage: AgentControlReportStage,
    key: string,
    destKey?: string,
  ) => {
    let reported = false;
    return {
      onFailure: (f: UpsertFailure) => {
        reported = true;
        fail(stage, key, upsertFailureReason(f), {
          status: f.status,
          destKey,
          log: false,
        });
      },
      /** Count the outcome: an error the write did not report is recorded with a generic reason */
      record: (outcome: UpsertOutcome) => {
        if (outcome !== "error") recordOutcome(summary, outcome);
        else if (!reported) fail(stage, key, "write failed", { destKey });
      },
    };
  };
  /** Source variations that were not written this run, with why (targeting names them) */
  const failedVariations = new Map<string, Map<string, string>>();
  const variationFailed = (
    configKey: string,
    variationKey: string,
    reason: string,
  ) => {
    if (!failedVariations.has(configKey)) {
      failedVariations.set(configKey, new Map());
    }
    failedVariations.get(configKey)!.set(variationKey, reason);
  };
  const finish = (): AgentControlMigrationResult => ({
    summary,
    manifest,
    aborted,
    expected: {
      modelConfigs: [...expected.modelConfigs],
      configs: [...expected.configs],
    },
    failures,
    warnings,
    missingModels,
    modelMappings,
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
        const reason =
          `exists, and so does the prefixed key ${prefixedKey}; not overwriting it`;
        console.log(Colors.red(`  ✗ ${label} ${key}: ${reason}`));
        return { kind: "error", reason };
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
  const modelUsage = await collectModelUsageFromExtract(aiRoot);
  const referencedModelKeys = new Set(modelUsage.keys());
  const usedBy = (k: string) => [...(modelUsage.get(k) ?? [])].sort();
  const modelMapping = options.modelMapping;
  const mapKey = (k: string) => mapModelKey(k, modelMapping);
  // A mapped source model is not created: its variations use the destination model it maps to
  const mappedSourceKeys = [...referencedModelKeys].filter((k) =>
    mapKey(k) !== k
  ).sort();
  const modelsToMigrate =
    (referencedModelKeys.size > 0
      ? modelItems.filter((m) => referencedModelKeys.has(String(m.key ?? "")))
      : modelItems).filter((m) => {
        const k = String(m.key ?? "");
        return mapKey(k) === k;
      });

  for (const [from, to] of Object.entries(modelMapping ?? {})) {
    if (referencedModelKeys.has(from)) continue;
    warn(
      "model-configs",
      from,
      `the model mapping maps "${from}" to "${to}", but no extracted variation uses "${from}"`,
    );
  }

  // Preflight: built-in models (and ones the extract does not define) are not created by this
  // migration, so the destination must already offer them; so must every model mapping target. Instances
  // differ (the Federal catalog is smaller than the commercial one, and custom models get generated
  // keys), so check before writing anything, dry runs included.
  const sourceModels = new Map(
    modelItems.map((m) => [String(m.key ?? ""), m] as const),
  );
  /** Destination keys this run creates (non-built-in source models), available once written */
  const createdHere = new Set(
    modelsToMigrate.filter((m) => !isBuiltInModel(m)).map((m) =>
      String(m.key ?? "")
    ),
  );
  const mustExist = [...referencedModelKeys].filter((k) => {
    if (mapKey(k) !== k) return true;
    const m = sourceModels.get(k);
    return !m || isBuiltInModel(m);
  }).sort();
  /** Source model keys variations cannot use in the destination, with why */
  const unavailableModels = new Map<string, string>();
  let destModels: Map<string, Record<string, unknown>> | undefined;
  if (mustExist.length > 0) {
    destModels = await listDestinationModels(client, dest);
    if (!destModels) {
      warn(
        "model-configs",
        "model-configs",
        "could not list the destination's model configs; availability of built-in and mapped models was not checked",
      );
    } else {
      for (const k of mustExist) {
        const target = mapKey(k);
        if (destModels.has(target) || createdHere.has(target)) continue;
        const suggestions = suggestModelMappings(
          k,
          sourceModels.get(k),
          [...destModels.values()].filter((m) => m.key !== target),
        );
        missingModels.push({
          modelKey: target,
          usedBy: usedBy(k),
          ...(target !== k ? { mappedFrom: k } : {}),
          ...(suggestions.length > 0 ? { suggestions } : {}),
        });
        unavailableModels.set(
          k,
          target !== k
            ? `model "${target}" (mapped from "${k}") is not available in the destination`
            : `model "${k}" is not available in the destination`,
        );
      }
      if (missingModels.length > 0) {
        console.log(Colors.red(
          `  ✗ ${missingModels.length} model(s) used by the source are not available in the destination:`,
        ));
        for (const m of missingModels) {
          console.log(Colors.red(
            `    ✗ ${m.modelKey}${
              m.mappedFrom ? ` (mapped from ${m.mappedFrom})` : ""
            } (used by ${m.usedBy.join(", ") || "no variation"})`,
          ));
          if (m.suggestions) {
            console.log(Colors.yellow(
              `      possible destination models: ${m.suggestions.join(", ")}`,
            ));
          }
        }
      } else {
        console.log(Colors.gray(
          `  All ${mustExist.length} built-in or mapped model(s) used by the source are available in the destination`,
        ));
      }
    }
  }
  for (const k of mappedSourceKeys) {
    if (unavailableModels.has(k)) continue;
    modelMappings.push({ sourceKey: k, destKey: mapKey(k), usedBy: usedBy(k) });
    console.log(Colors.gray(
      `  → Model ${k}: mapped to ${mapKey(k)} (used by ${
        usedBy(k).length
      } variation(s))`,
    ));
  }

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
    if (isBuiltInModel(model)) {
      if (destModels && !destModels.has(key)) {
        console.log(Colors.red(
          `  ✗ Model config ${key}: built-in, and not available in the destination`,
        ));
      } else {
        console.log(Colors.gray(
          `  → Model config ${key}: built-in, ${
            destModels
              ? "available in the destination"
              : "not verified in the destination"
          }`,
        ));
      }
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
      fail("model-configs", key, plan.reason, { log: false });
      if (!options.dryRun && previousEntry) {
        delete manifest.modelConfigs[key].hash;
      }
      continue;
    }

    const hash = await hashAgentControlInput(
      payloadFor(model, plan.destKey, plan.destName),
    );
    const report = writeFailure("model-configs", key, plan.destKey);
    let outcome = await upsertAgentControlResource(
      client,
      modelBase,
      `${modelBase}/${plan.destKey}`,
      payloadFor(model, plan.destKey, plan.destName, plan.existingTags),
      options.dryRun,
      {
        sanitize: (r) => r,
        knownExisting: plan.exists,
        immutableSkip: true,
        onFailure: report.onFailure,
      },
    );
    if (options.dryRun && outcome === "created" && plan.exists) {
      outcome = "updated";
    }
    logStageOutcome("Model config", key, outcome);
    report.record(outcome);
    // A model config that is not in the destination cannot be used by the variations that name it
    if (outcome === "error" && !plan.exists) {
      unavailableModels.set(key, `model config "${key}" was not migrated`);
    }
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
      fail("configs", key, plan.reason, { log: false });
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
    const report = writeFailure("configs", key, plan.destKey);
    let outcome = await upsertAgentControlResource(
      client,
      configBase,
      `${configBase}/${plan.destKey}`,
      payloadFor(config, plan.destKey, plan.destName, plan.existingTags),
      options.dryRun,
      {
        sanitize: (r) => r,
        knownExisting: plan.exists,
        onFailure: report.onFailure,
      },
    );
    if (options.dryRun && outcome === "created" && plan.exists) {
      outcome = "updated";
    }
    logStageOutcome("Config", key, outcome);
    report.record(outcome);
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
  const variationFiles = await sortVariationFilesBySourceOrder(
    aiRoot,
    await listVariationFiles(aiRoot),
  );
  console.log(
    Colors.gray(`  Migrating ${variationFiles.length} variation(s)...`),
  );
  /** Variations present in the destination after this stage, for the state stage */
  const placedVariations: Array<{
    configKey: string;
    variationKey: string;
    destConfigKey: string;
    state: unknown;
  }> = [];
  for (const { configKey, variationKey, filePath } of variationFiles) {
    if (aborted) break;
    const configPlan = planFor(configKey);
    const label = `${configKey}/${variationKey}`;
    const clearVariationHash = () => {
      if (
        !options.dryRun &&
        Object.hasOwn(manifest.configs, configKey) &&
        Object.hasOwn(manifest.configs[configKey].variations, variationKey)
      ) {
        delete manifest.configs[configKey].variations[variationKey].hash;
      }
    };
    if (configPlan.blocked) {
      console.log(Colors.gray(
        `  → Variation ${label}: skipped (its config was not written)`,
      ));
      recordOutcome(summary, "skipped");
      continue;
    }
    const variation = await getJson(filePath) as
      | Record<string, unknown>
      | undefined;
    if (!variation) {
      fail("variations", label, `could not read ${filePath}`);
      variationFailed(
        configKey,
        variationKey,
        "its extract file is unreadable",
      );
      continue;
    }
    // Hashed with the mapped model keys, so a changed mapping rewrites the variation under --incremental
    const destVariation = applyModelMapping(variation, modelMapping);
    const hash = await hashAgentControlInput({
      destConfigKey: configPlan.destKey,
      variation: sanitizeVariationPayload(destVariation),
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
        `  → Variation ${label}: unchanged, skipping (--incremental)`,
      ));
      recordOutcome(summary, "skipped");
      placedVariations.push({
        configKey,
        variationKey,
        destConfigKey: configPlan.destKey,
        state: variation.state,
      });
      continue;
    }
    // A variation whose model the destination does not offer would be rejected: report it instead
    const unavailable = [...collectReferencedModelConfigKeys([variation])]
      .map((m) => unavailableModels.get(m) ?? unavailableModels.get(mapKey(m)))
      .find((reason) => reason !== undefined);
    if (unavailable) {
      fail("variations", label, `not migrated: ${unavailable}`, {
        destKey: configPlan.destKey,
      });
      variationFailed(configKey, variationKey, unavailable);
      clearVariationHash();
      continue;
    }
    let writeReason: string | undefined;
    const report = writeFailure("variations", label, configPlan.destKey);
    const outcome = await upsertAgentControlResource(
      client,
      `projects/${dest}/ai-configs/${configPlan.destKey}/variations`,
      `projects/${dest}/ai-configs/${configPlan.destKey}/variations/${variationKey}`,
      destVariation,
      options.dryRun,
      {
        sanitize: sanitizeVariationPayload,
        onFailure: (f) => {
          writeReason = `its write failed (HTTP ${f.status})`;
          report.onFailure(f);
        },
      },
    );
    logStageOutcome("Variation", label, outcome);
    report.record(outcome);
    if (outcome === "error") {
      variationFailed(
        configKey,
        variationKey,
        writeReason ?? "its write failed",
      );
      clearVariationHash();
      continue;
    }
    placedVariations.push({
      configKey,
      variationKey,
      destConfigKey: configPlan.destKey,
      state: variation.state,
    });
    if (options.dryRun) continue;
    if (outcome === "created" || outcome === "updated") {
      ensureConfig(configKey).variations[variationKey] = {
        ...ownEntry(manifest.configs[configKey]?.variations, variationKey),
        hash,
      };
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
      fail("targeting", configKey, `could not read ${filePath}`);
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
      {
        failedVariations: failedVariations.get(configKey) ?? new Map(),
        fail: (key, reason, status) =>
          fail("targeting", key, reason, {
            status,
            destKey: configPlan.destKey,
          }),
        warn: (key, message) => warn("targeting", key, message),
        unmappedDefaultRule: options.unmappedDefaultRule,
      },
    );
    logStageOutcome("Targeting", configKey, outcome);
    // Failed environments were counted (with their reasons) as they happened
    if (outcome !== "error") recordOutcome(summary, outcome);
  }

  // Stage 5: variation state. A variation is created published; archive the ones archived in the source,
  // and restore ones this migration archived earlier that the source has since restored.
  const archivedBefore = (configKey: string, variationKey: string) =>
    ownEntry(ownEntry(previous?.configs, configKey)?.variations, variationKey)
      ?.archived === true;
  const stateChanges = placedVariations.filter((v) =>
    v.state === "archived" || archivedBefore(v.configKey, v.variationKey)
  );
  if (stateChanges.length > 0 && !aborted) {
    console.log(Colors.gray(
      `  Checking the state of ${stateChanges.length} archived variation(s)...`,
    ));
  }
  const destStates = new Map<string, Map<string, string> | undefined>();
  const destStateOf = async (destConfigKey: string) => {
    if (!destStates.has(destConfigKey)) {
      const existing = await fetchExisting(
        client,
        `${configBase}/${destConfigKey}`,
      );
      destStates.set(
        destConfigKey,
        existing.state === "exists" && Array.isArray(existing.json.variations)
          ? new Map(
            (existing.json.variations as Record<string, unknown>[]).map(
              (v) => [
                resolveVariationKey(v) || String(v.key ?? ""),
                typeof v.state === "string" ? v.state : "published",
              ],
            ),
          )
          : undefined,
      );
    }
    return destStates.get(destConfigKey);
  };
  const recordArchived = (
    configKey: string,
    variationKey: string,
    archived: boolean,
  ) => {
    if (options.dryRun) return;
    const entry = {
      ...ownEntry(manifest.configs[configKey]?.variations, variationKey),
    };
    if (archived) entry.archived = true;
    else delete entry.archived;
    ensureConfig(configKey).variations[variationKey] = entry;
  };
  for (const v of stateChanges) {
    if (aborted) break;
    const target = v.state === "archived" ? "archived" : "published";
    const label = `${v.configKey}/${v.variationKey}`;
    const states = await destStateOf(v.destConfigKey);
    if (states?.get(v.variationKey) === target) {
      recordArchived(v.configKey, v.variationKey, target === "archived");
      recordOutcome(summary, "skipped");
      continue;
    }
    if (target === "archived" && states) {
      const active = [...states.entries()].filter(([k, s]) =>
        k !== v.variationKey && k !== "disabled" && k !== "enabled" &&
        s !== "archived"
      );
      if (active.length === 0) {
        warn(
          "variation-state",
          label,
          "archived in the source, but it is the config's only active variation in the destination, which cannot be archived",
        );
        continue;
      }
    }
    const verb = target === "archived" ? "archive" : "restore";
    if (options.dryRun) {
      console.log(
        Colors.gray(`    [DRY RUN] Would ${verb} variation ${label}`),
      );
      recordOutcome(summary, "updated");
      continue;
    }
    const path =
      `${configBase}/${v.destConfigKey}/variations/${v.variationKey}`;
    const resp = await client.patch(path, { state: target });
    if (resp.status >= 200 && resp.status < 300) {
      console.log(Colors.green(
        `  ✓ Variation ${label}: ${
          target === "archived" ? "archived" : "restored"
        }`,
      ));
      // Later variations of the same config are checked against the state this one now has
      states?.set(v.variationKey, target);
      recordArchived(v.configKey, v.variationKey, target === "archived");
      recordOutcome(summary, "updated");
    } else {
      logUpsertFailure("PATCH", path, resp.status, resp.body);
      fail(
        "variation-state",
        label,
        `could not ${verb} the variation: ${
          upsertFailureReason({
            action: "PATCH",
            path,
            status: resp.status,
            body: resp.body,
          })
        }`,
        { status: resp.status, destKey: v.destConfigKey, log: false },
      );
    }
  }

  console.log(Colors.cyan("\nAgentControl summary:"));
  console.log(Colors.gray(`  Created: ${summary.created}`));
  console.log(Colors.gray(`  Updated: ${summary.updated}`));
  console.log(Colors.gray(`  Skipped: ${summary.skipped}`));
  console.log(
    (summary.errors > 0 ? Colors.red : Colors.gray)(
      `  Errors: ${summary.errors}`,
    ),
  );
  if (warnings.length > 0) {
    console.log(Colors.yellow(`  Warnings: ${warnings.length}`));
  }
  if (missingModels.length > 0) {
    console.log(Colors.red(
      `  Models not available in the destination: ${missingModels.length}`,
    ));
  }
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

interface TargetingReport {
  /** Source variations of this config that were not written this run, with why */
  failedVariations: Map<string, string>;
  /** Records (and logs) a failure; each call counts as one error */
  fail: (key: string, reason: string, status?: number) => void;
  warn: (key: string, message: string) => void;
  /** What a default rule that cannot be mapped does (default: leave) */
  unmappedDefaultRule?: UnmappedDefaultRule;
}

/**
 * Semantic-patch a config's per-environment targeting. `configKey` is the source key (names the extract
 * files); `destConfigKey` is where the config lives in the destination, which differs after a prefix.
 * Each environment is patched with whatever maps; the parts that do not are reported as failures, and an
 * environment that fails does not stop the others.
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
  report: TargetingReport = {
    failedVariations: new Map(),
    fail: () => {},
    warn: () => {},
  },
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

  const { ids: destVariationIdByKey, defaultByEnv } =
    await loadDestVariationIdByKey(
      client,
      dest,
      destConfigKey,
      sourceVariations,
      dryRun,
    );
  // A dry run invents destination IDs; variations that were not written this run would not have one
  if (dryRun) {
    for (const key of report.failedVariations.keys()) {
      destVariationIdByKey.delete(key);
    }
  }

  const envLabel = (sourceEnvKey: string) => {
    const destEnvKey = envMapping[sourceEnvKey] ?? sourceEnvKey;
    return `${configKey}/${sourceEnvKey}${
      destEnvKey !== sourceEnvKey ? ` (destination ${destEnvKey})` : ""
    }`;
  };

  if (destVariationIdByKey.size === 0 && !dryRun) {
    for (const k of envKeys) {
      report.fail(
        envLabel(k),
        `targeting not applied: no variations of ${destConfigKey} were found in the destination`,
      );
      tracking.record?.(k, undefined);
    }
    return "error";
  }

  let anyUpdated = false;
  let anyError = false;

  for (const sourceEnvKey of envKeys) {
    const destEnvKey = envMapping[sourceEnvKey] ?? sourceEnvKey;
    const label = envLabel(sourceEnvKey);
    const { instructions, issues } = buildTargetingInstructionsForEnvironment(
      environments[sourceEnvKey],
      sourceVariations,
      destVariationIdByKey,
      {
        unmappedDefaultRule: report.unmappedDefaultRule,
        currentDefaultVariationKey: defaultByEnv.get(destEnvKey),
      },
    );
    // Name the earlier failure that left a variation out of the destination
    const explain = (issue: TargetingIssue) => {
      const why = issue.variationKey
        ? report.failedVariations.get(issue.variationKey)
        : undefined;
      return why
        ? `${issue.message} (variation "${issue.variationKey}" was not migrated: ${why})`
        : issue.message;
    };
    const errors = issues.filter((i) => i.severity === "error");
    for (const issue of issues) {
      if (issue.severity === "warning") report.warn(label, issue.message);
    }

    if (dryRun) {
      for (const issue of errors) report.fail(label, explain(issue));
      console.log(Colors.gray(
        `    [DRY RUN] Would semantic-patch targeting ${destConfigKey} env=${destEnvKey} (${instructions.length} instruction(s)${
          errors.length > 0 ? `, ${errors.length} part(s) left out` : ""
        })`,
      ));
      if (errors.length > 0) anyError = true;
      else anyUpdated = true;
      continue;
    }

    if (!client.semanticPatch) {
      report.fail(
        label,
        "targeting not applied: semantic patch client not available",
      );
      anyError = true;
      tracking.record?.(sourceEnvKey, undefined);
      continue;
    }

    const path = `projects/${dest}/ai-configs/${destConfigKey}/targeting`;
    const resp = await client.semanticPatch(path, {
      environmentKey: destEnvKey,
      comment: "Migrated by ld-migration-scripts AgentControl",
      instructions,
    });

    if (resp.status >= 200 && resp.status < 300) {
      anyUpdated = true;
      if (errors.length === 0) {
        console.log(Colors.green(`    ✓ ${label}: targeting applied`));
        tracking.record?.(sourceEnvKey, hashes.get(sourceEnvKey));
      } else {
        console.log(Colors.yellow(
          `    ⚠ ${label}: targeting applied without ${errors.length} part(s):`,
        ));
        for (const issue of errors) report.fail(label, explain(issue));
        anyError = true;
        // Not recorded: --incremental retries it once the missing variations exist
        tracking.record?.(sourceEnvKey, undefined);
      }
    } else {
      logUpsertFailure(
        "SEMANTIC PATCH targeting",
        `${path} env=${destEnvKey}`,
        resp.status,
        resp.body,
      );
      report.fail(
        label,
        `targeting not applied: ${
          upsertFailureReason({
            action: "PATCH",
            path: `${path} (environment ${destEnvKey})`,
            status: resp.status,
            body: resp.body,
          })
        }`,
        resp.status,
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
): Promise<{
  /** Variation key -> destination variation ID */
  ids: Map<string, string>;
  /** Destination environment key -> key of the variation its default rule serves now */
  defaultByEnv: Map<string, string>;
}> {
  const map = new Map<string, string>();
  const defaultByEnv = new Map<string, string>();
  if (dryRun) {
    // Stable fake IDs so instruction builders can run in dry-run tests
    for (const v of sourceVariations) {
      if (v.key) map.set(v.key, `dry-run-${v.key}`);
    }
    return { ids: map, defaultByEnv };
  }
  if (!client.get) return { ids: map, defaultByEnv };

  // The targeting resource lists every variation targeting can name, including the built-in "disabled"
  // (and "enabled") ones that the config detail omits; the config detail fills any gap.
  const targetingPath = `projects/${dest}/ai-configs/${configKey}/targeting`;
  for (
    const path of [targetingPath, `projects/${dest}/ai-configs/${configKey}`]
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
    if (path !== targetingPath) continue;
    // A default rule that cannot be migrated is left as it is: name what it serves in the report
    const environments = (detail.environments ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    for (const [envKey, env] of Object.entries(environments)) {
      const fallthrough = env?.fallthrough as
        | Record<string, unknown>
        | undefined;
      const ref = fallthrough?.variationId ?? fallthrough?.variation;
      const served = typeof ref === "number"
        ? variations[ref]
        : typeof ref === "string"
        ? variations.find((v) => v._id === ref)
        : undefined;
      const key = served
        ? resolveVariationKey(served) || String(served.key ?? "")
        : "";
      if (key) defaultByEnv.set(envKey, key);
    }
  }
  return { ids: map, defaultByEnv };
}

/** Built-in (global) and restricted model configs: offered by the instance, never created by a migration. */
export function isBuiltInModel(model: Record<string, unknown>): boolean {
  return model.global === true || model.isGlobal === true ||
    model.isRestricted === true;
}

/** The model configs the destination offers (its own and built-in) by key, or undefined when they cannot be listed. */
async function listDestinationModels(
  client: AgentControlHttpClient,
  dest: string,
): Promise<Map<string, Record<string, unknown>> | undefined> {
  if (!client.get) return undefined;
  const listed = await listAgentControlCollection(
    client.get,
    `projects/${dest}/ai-configs/model-configs`,
  );
  if (listed.unavailable || listed.error) return undefined;
  return new Map(
    listed.items
      .map((m) => [String(m.key ?? ""), m] as const)
      .filter(([k]) => k !== ""),
  );
}

/** Model key -> the `config/variation` keys in the extract that use it. */
async function collectModelUsageFromExtract(
  aiRoot: string,
): Promise<Map<string, Set<string>>> {
  const usage = new Map<string, Set<string>>();
  const add = (record: Record<string, unknown>, usedBy: string) => {
    for (const modelKey of collectReferencedModelConfigKeys([record])) {
      if (!usage.has(modelKey)) usage.set(modelKey, new Set());
      usage.get(modelKey)!.add(usedBy);
    }
  };
  for (const file of await listVariationFiles(aiRoot)) {
    const v = await getJson(file.filePath) as
      | Record<string, unknown>
      | undefined;
    if (v) add(v, `${file.configKey}/${file.variationKey}`);
  }
  for (const file of await listTargetingFiles(aiRoot)) {
    const t = await getJson(file.filePath) as
      | Record<string, unknown>
      | undefined;
    if (!t || !Array.isArray(t.variations)) continue;
    for (const v of t.variations as Record<string, unknown>[]) {
      add(
        v,
        `${file.configKey}/${resolveVariationKey(v) || String(v.key ?? "?")}`,
      );
    }
  }
  return usage;
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

/**
 * Orders each config's variations as the source lists them in targeting, so the destination shows them
 * in the same order and its default rule (which a new config points at the first variation created) is
 * never an archived one. Variations targeting does not list (archived ones) come last, by key.
 */
async function sortVariationFilesBySourceOrder<
  T extends { configKey: string; variationKey: string },
>(aiRoot: string, files: T[]): Promise<T[]> {
  const order = new Map<string, Map<string, number>>();
  for (const configKey of new Set(files.map((f) => f.configKey))) {
    const path = `${aiRoot}/targeting/${configKey}.json`;
    const exists = await Deno.stat(path).then(() => true, () => false);
    const targeting = exists
      ? await getJson(path) as Record<string, unknown> | undefined
      : undefined;
    const variations = Array.isArray(targeting?.variations)
      ? targeting.variations as Record<string, unknown>[]
      : [];
    order.set(
      configKey,
      new Map(variations.map((v, i) => [resolveVariationKey(v), i])),
    );
  }
  const position = (f: T) =>
    order.get(f.configKey)?.get(f.variationKey) ?? Number.MAX_SAFE_INTEGER;
  return [...files].sort((a, b) =>
    a.configKey.localeCompare(b.configKey) || position(a) - position(b) ||
    a.variationKey.localeCompare(b.variationKey)
  );
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

/** CLI args for migrate's AgentControl model mapping and unmapped default rule settings. */
export function agentControlModelCliArgs(options: {
  modelMapping?: Record<string, string>;
  unmappedDefaultRule?: string;
}): string[] {
  const args: string[] = [];
  if (options.modelMapping && Object.keys(options.modelMapping).length > 0) {
    args.push(
      "--agent-control-model-map",
      JSON.stringify(options.modelMapping),
    );
  }
  if (options.unmappedDefaultRule) {
    args.push(
      "--agent-control-unmapped-default-rule",
      options.unmappedDefaultRule,
    );
  }
  return args;
}
