// deno-lint-ignore-file no-explicit-any
/**
 * Helpers for copying views between projects.
 *
 * Flags don't report which views they belong to, so membership is read from the views API:
 *   GET  projects/{p}/views                          → view details
 *   GET  projects/{p}/views/{v}/linked/{flags|segments} → linked resources
 *   POST projects/{p}/views/{v}/link/{flags|segments}   → link resources in the destination
 * All views endpoints require the beta API version.
 */

import { ldAPIPostRequest, ldAPIRequest, rateLimitRequest } from "./utils.ts";

const PAGE_SIZE = 50;
const LINK_BATCH_SIZE = 20;

export interface SourceView {
  key: string;
  name: string;
  description?: string;
  tags?: string[];
  maintainerId?: string;
  maintainerTeamKey?: string;
  flags: string[];
  segments: Array<{ environmentKey: string; segmentKey: string }>;
}

async function getAllPages(apiKey: string, domain: string, path: string): Promise<any[]> {
  const items: any[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const sep = path.includes("?") ? "&" : "?";
    const resp = await rateLimitRequest(
      ldAPIRequest(apiKey, domain, `${path}${sep}limit=${PAGE_SIZE}&offset=${offset}`, true),
      "views",
    );
    if (resp.status !== 200) {
      throw new Error(`GET ${path} failed (HTTP ${resp.status}): ${await resp.text()}`);
    }
    const body = await resp.json();
    const page: any[] = body.items ?? [];
    items.push(...page);
    if (page.length === 0) return items;
    // The beta endpoints don't always return totalCount; without it, a short page with no next link ends the list
    if (typeof body.totalCount === "number") {
      if (items.length >= body.totalCount) return items;
    } else if (page.length < PAGE_SIZE && !body._links?.next) {
      return items;
    }
  }
}

/**
 * Reads every view in a project with its linked flags and segments.
 * Note: the list only includes views the token has `viewView` on; others are silently omitted.
 */
export async function extractViews(apiKey: string, domain: string, projectKey: string): Promise<SourceView[]> {
  const views = await getAllPages(apiKey, domain, `projects/${projectKey}/views`);
  const result: SourceView[] = [];
  for (const v of views) {
    const linkedBase = `projects/${projectKey}/views/${v.key}/linked`;
    const flags = await getAllPages(apiKey, domain, `${linkedBase}/flags`);
    const segments = await getAllPages(apiKey, domain, `${linkedBase}/segments`);
    result.push({
      key: v.key,
      name: v.name,
      description: v.description || undefined,
      tags: v.tags?.length ? v.tags : undefined,
      maintainerId: v.maintainer?.maintainerMember?.id ?? v.maintainerId ?? undefined,
      maintainerTeamKey: v.maintainer?.maintainerTeam?.key ?? v.maintainerTeamKey ?? undefined,
      flags: flags.map((f) => f.resourceKey),
      segments: segments.map((s) => ({ environmentKey: s.environmentKey, segmentKey: s.resourceKey })),
    });
  }
  return result;
}

export interface LinkResult {
  linked: number;
  failed: string[];
}

/** Links flags (by key) or segments (by environment id + key) to a view, in batches. */
export async function linkToView(
  apiKey: string,
  domain: string,
  projectKey: string,
  viewKey: string,
  resourceType: "flags" | "segments",
  items: string[] | Array<{ environmentId: string; segmentKey: string }>,
): Promise<LinkResult> {
  const result: LinkResult = { linked: 0, failed: [] };
  for (let i = 0; i < items.length; i += LINK_BATCH_SIZE) {
    const batch = items.slice(i, i + LINK_BATCH_SIZE);
    const body = resourceType === "flags"
      ? { keys: batch, comment: "Linked by ld-migration-scripts" }
      : { segmentIdentifiers: batch, comment: "Linked by ld-migration-scripts" };
    const resp = await rateLimitRequest(
      ldAPIPostRequest(apiKey, domain, `projects/${projectKey}/views/${viewKey}/link/${resourceType}`, body, true),
      "views",
    );
    const label = (x: any) => (typeof x === "string" ? x : `${x.segmentKey}`);
    if (resp.status >= 300) {
      const err = await resp.text();
      result.failed.push(...batch.map((x: any) => `${label(x)} (HTTP ${resp.status}: ${err.slice(0, 200)})`));
      continue;
    }
    const data = await resp.json().catch(() => ({}));
    const failedHere: any[] = data.failedResources ?? [];
    result.linked += data.successCount ?? batch.length - failedHere.length;
    result.failed.push(...failedHere.map((f: any) => `${f.resourceKey ?? JSON.stringify(f)}${f.errorMessage ? ` (${f.errorMessage})` : ""}`));
  }
  return result;
}
