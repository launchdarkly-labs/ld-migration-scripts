/**
 * Split (Harness FME) Admin API client.
 *
 * Read-only client used by the Split → LaunchDarkly source adapter.
 * Auth is a Bearer Admin API key. List endpoints paginate with an
 * objects/offset/limit/totalCount envelope; pagination terminates when a
 * page comes back empty (mirroring LaunchDarkly's product Split importer)
 * or when offset reaches totalCount.
 */

import type {
  SplitEnvironment,
  SplitFlag,
  SplitFlagDefinition,
  SplitFlagSet,
  SplitFlagSetsPage,
  SplitLargeSegment,
  SplitPage,
  SplitRuleBasedSegment,
  SplitSegment,
  SplitSegmentInEnvironment,
  SplitSegmentKeysPage,
  SplitTrafficType,
  SplitWorkspace,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://api.split.io";
/** Max page size for most Split list endpoints. */
const PAGE_SIZE = 50;
/** Max page size for the segment keys endpoint. */
const KEYS_PAGE_SIZE = 100;
const MAX_429_RETRIES = 5;
/** Env-scoped list endpoints intermittently return raw 500s (observed live). */
const MAX_5XX_RETRIES = 2;
/** Abort requests that never respond (hangs observed against Split). */
const REQUEST_TIMEOUT_MS = 60_000;

export class SplitApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
  ) {
    super(`Split API ${status} on ${path}: ${message}`);
    this.name = "SplitApiError";
  }
}

type FetchFn = (input: Request) => Promise<Response>;

export interface SplitClientOptions {
  baseUrl?: string;
  /** Injectable fetch for tests. */
  fetchFn?: FetchFn;
  /** Injectable sleep for tests (defaults to real setTimeout delay). */
  delayFn?: (ms: number) => Promise<void>;
}

export class SplitClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly delayFn: (ms: number) => Promise<void>;

  constructor(apiKey: string, options: SplitClientOptions = {}) {
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? ((req) => fetch(req));
    this.delayFn = options.delayFn ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * GET a Split Admin API path (relative to the API host, e.g.
   * "/internal/api/v2/workspaces") with Bearer auth and 429 retry.
   */
  async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, String(value));
    }

    for (let attempt = 0, serverErrors = 0; ; attempt++) {
      const req = new Request(url.toString(), {
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "ld-migration-scripts/split-source-adapter",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      let resp: Response;
      try {
        resp = await this.fetchFn(req);
      } catch (e) {
        const timedOut = e instanceof DOMException &&
          (e.name === "TimeoutError" || e.name === "AbortError");
        if (timedOut && serverErrors < MAX_5XX_RETRIES) {
          serverErrors++;
          await this.delayFn(1000 * serverErrors);
          continue;
        }
        if (timedOut) {
          throw new SplitApiError(408, path, `no response after ${REQUEST_TIMEOUT_MS / 1000}s`);
        }
        throw e;
      }

      if (resp.status === 429 && attempt < MAX_429_RETRIES) {
        const retryAfter = parseInt(resp.headers.get("retry-after") ?? "", 10);
        // Exponential backoff fallback: 1s, 2s, 4s, ... capped at 30s
        const waitMs = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** attempt, 30_000);
        await resp.body?.cancel();
        await this.delayFn(waitMs);
        continue;
      }

      // Intermittent raw 500s were observed on env-scoped list endpoints;
      // retry briefly before surfacing.
      if (resp.status >= 500 && serverErrors < MAX_5XX_RETRIES) {
        serverErrors++;
        await resp.body?.cancel();
        await this.delayFn(1000 * serverErrors);
        continue;
      }

      if (!resp.ok) {
        let message = resp.statusText;
        try {
          const body = await resp.json();
          if (body?.message) message = body.message;
        } catch {
          // Non-JSON error body; keep statusText
        }
        throw new SplitApiError(resp.status, path, message);
      }

      return await resp.json() as T;
    }
  }

  /**
   * Fetch every page of an objects/offset/limit/totalCount endpoint.
   * Terminates on an empty page or once totalCount items are collected.
   */
  private async getAllPages<T>(
    path: string,
    params: Record<string, string | number> = {},
    limit = PAGE_SIZE,
  ): Promise<T[]> {
    const results: T[] = [];
    let offset = 0;
    while (true) {
      const page = await this.get<SplitPage<T> | T[]>(path, { ...params, limit, offset });
      // Some endpoints return a BARE ARRAY instead of the documented
      // objects/offset/limit/totalCount envelope (observed live on
      // rule-based-segments in-environment, whose docs show {objects});
      // treat it as the complete, non-paginated result.
      if (Array.isArray(page)) {
        results.push(...page);
        break;
      }
      const objects = page.objects ?? [];
      if (objects.length === 0) break;
      results.push(...objects);
      offset += objects.length;
      if (typeof page.totalCount === "number" && offset >= page.totalCount) break;
    }
    return results;
  }

  // ==================== Workspaces / Environments / Traffic Types ====================

  listWorkspaces(): Promise<SplitWorkspace[]> {
    return this.getAllPages<SplitWorkspace>("/internal/api/v2/workspaces");
  }

  /** Returns a plain (non-paginated) array. */
  getEnvironments(workspaceId: string): Promise<SplitEnvironment[]> {
    return this.get<SplitEnvironment[]>(
      `/internal/api/v2/environments/ws/${workspaceId}`,
    );
  }

  /** Returns a plain (non-paginated) array. */
  getTrafficTypes(workspaceId: string): Promise<SplitTrafficType[]> {
    return this.get<SplitTrafficType[]>(
      `/internal/api/v2/trafficTypes/ws/${workspaceId}`,
    );
  }

  // ==================== Feature Flags ====================

  /** Flag metadata (name, description, traffic type, tags). Optional tag filter. */
  listFlags(workspaceId: string, tag?: string): Promise<SplitFlag[]> {
    const params: Record<string, string> = {};
    if (tag) params.tag = tag;
    return this.getAllPages<SplitFlag>(`/internal/api/v2/splits/ws/${workspaceId}`, params);
  }

  /** Per-environment flag definitions (treatments, rules, default rule). */
  listFlagDefinitions(
    workspaceId: string,
    environmentIdOrName: string,
  ): Promise<SplitFlagDefinition[]> {
    return this.getAllPages<SplitFlagDefinition>(
      `/internal/api/v2/splits/ws/${workspaceId}/environments/${environmentIdOrName}`,
    );
  }

  // ==================== Segments ====================

  listSegments(workspaceId: string, tag?: string): Promise<SplitSegment[]> {
    const params: Record<string, string> = {};
    if (tag) params.tag = tag;
    return this.getAllPages<SplitSegment>(
      `/internal/api/v2/segments/ws/${workspaceId}`,
      params,
    );
  }

  listSegmentsInEnvironment(
    workspaceId: string,
    environmentIdOrName: string,
  ): Promise<SplitSegmentInEnvironment[]> {
    return this.getAllPages<SplitSegmentInEnvironment>(
      `/internal/api/v2/segments/ws/${workspaceId}/environments/${environmentIdOrName}`,
    );
  }

  /**
   * All member keys of a standard segment in an environment.
   * NOTE: this endpoint's envelope is {keys, count, offset, limit} — not the
   * usual objects/totalCount page.
   */
  async getSegmentKeys(
    environmentId: string,
    segmentName: string,
    /** Called after each page with (fetched, total?) — large segments page
     * 100 keys at a time, so callers can show progress instead of silence. */
    onProgress?: (fetched: number, total?: number) => void,
  ): Promise<string[]> {
    const keys: string[] = [];
    let offset = 0;
    while (true) {
      const page = await this.get<SplitSegmentKeysPage>(
        `/internal/api/v2/segments/${environmentId}/${segmentName}/keys`,
        { limit: KEYS_PAGE_SIZE, offset },
      );
      const pageKeys = page.keys ?? [];
      if (pageKeys.length === 0) break;
      keys.push(...pageKeys.map((k) => k.key));
      offset += pageKeys.length;
      onProgress?.(offset, typeof page.count === "number" ? page.count : undefined);
      if (typeof page.count === "number" && offset >= page.count) break;
    }
    return keys;
  }

  /**
   * Large segment metadata. The public Admin API has no endpoint to list or
   * export large segment MEMBERS — membership must be re-imported from the
   * customer's source-of-truth CSV.
   */
  listLargeSegmentsInEnvironment(
    workspaceId: string,
    environmentId: string,
  ): Promise<SplitLargeSegment[]> {
    return this.getAllPages<SplitLargeSegment>(
      `/internal/api/v2/large-segments/ws/${workspaceId}/environments/${environmentId}`,
    );
  }

  // ==================== Rule-based Segments ====================

  listRuleBasedSegmentsInEnvironment(
    workspaceId: string,
    environmentId: string,
  ): Promise<SplitRuleBasedSegment[]> {
    return this.getAllPages<SplitRuleBasedSegment>(
      `/internal/api/v2/rule-based-segments/ws/${workspaceId}/environments/${environmentId}`,
    );
  }

  // ==================== Flag Sets ====================

  /** Flag sets live on the v3 API and key by workspace_id query param. */
  async listFlagSets(workspaceId: string): Promise<SplitFlagSet[]> {
    const page = await this.get<SplitFlagSetsPage>(
      "/internal/api/v3/flag-sets",
      { workspace_id: workspaceId },
    );
    // v3 envelope has been observed as {data: []}; tolerate {objects: []} or a bare array too.
    if (Array.isArray(page)) return page as unknown as SplitFlagSet[];
    return page.data ?? page.objects ?? [];
  }
}
