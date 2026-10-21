// deno-lint-ignore-file no-explicit-any
/**
 * Helpers for exporting larger list-based ("big") segment members from a source project.
 *
 * Membership of a big segment is not returned by the segments API, so it is exported as a CSV:
 *   POST .../exports → poll GET .../exports/{id} → download the file it links to
 * The migrate step loads the keys and imports them with its big segment CSV importer.
 */

import * as Colors from "https://deno.land/std@0.149.0/fmt/colors.ts";
import { ldAPIPostRequest, ldAPIRequest, rateLimitRequest } from "./utils.ts";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINAL_FAILURE_STATUSES = [
  "failed",
  "error",
  "stopped",
  "cancelled",
  "canceled",
];

export interface BigSegmentResult {
  ok: boolean;
  message: string;
}

/** Synced segments (Amplitude, Segment, ...) are owned by the external tool and can't be copied by CSV. */
export function isSyncedSegment(segment: any): boolean {
  return Boolean(segment._external || segment._externalLink);
}

export function bigSegmentCsvPath(
  projPath: string,
  envKey: string,
  segmentKey: string,
): string {
  return `${projPath}/segments/big/${envKey}/${segmentKey}.csv`;
}

function idFromLocation(resp: Response): string | undefined {
  const location = resp.headers.get("location");
  return location ? location.split("/").filter(Boolean).pop() : undefined;
}

async function pollUntilDone(
  apiKey: string,
  domain: string,
  path: string,
  label: string,
): Promise<{ ok: boolean; body: any }> {
  const started = Date.now();
  let lastStatus = "";
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    const resp = await rateLimitRequest(
      ldAPIRequest(apiKey, domain, path),
      "segments",
    );
    if (resp.status !== 200) {
      return {
        ok: false,
        body: { status: `HTTP ${resp.status}`, error: await resp.text() },
      };
    }
    const body = await resp.json();
    if (body.status !== lastStatus) {
      console.log(Colors.gray(`    ${label}: ${body.status}`));
      lastStatus = body.status;
    }
    if (body.status === "complete") return { ok: true, body };
    if (TERMINAL_FAILURE_STATUSES.includes(body.status)) {
      return { ok: false, body };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return {
    ok: false,
    body: { status: `timed out after ${POLL_TIMEOUT_MS / 60000} minutes` },
  };
}

function findDownloadHref(
  links: Record<string, { href: string; type?: string }> | undefined,
): string | undefined {
  if (!links) return undefined;
  const entries = Object.entries(links).filter(([name]) =>
    name !== "self" && name !== "parent" && name !== "site"
  );
  const byType = entries.find(([, l]) =>
    l.type && !l.type.includes("json") && !l.type.includes("html")
  );
  const byName = entries.find(([name]) =>
    /download|file|export|csv/i.test(name)
  );
  return (byType ?? byName)?.[1].href;
}

/**
 * Exports a big segment's members from the source and writes them to `outPath` as CSV.
 * Never throws: network and file errors are returned as a failed result.
 */
export async function exportBigSegmentCsv(
  apiKey: string,
  domain: string,
  projKey: string,
  envKey: string,
  segmentKey: string,
  outPath: string,
): Promise<BigSegmentResult> {
  try {
    return await runExport(
      apiKey,
      domain,
      projKey,
      envKey,
      segmentKey,
      outPath,
    );
  } catch (error) {
    return {
      ok: false,
      message: `export failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

async function runExport(
  apiKey: string,
  domain: string,
  projKey: string,
  envKey: string,
  segmentKey: string,
  outPath: string,
): Promise<BigSegmentResult> {
  const basePath = `segments/${projKey}/${envKey}/${segmentKey}/exports`;
  const createResp = await rateLimitRequest(
    ldAPIPostRequest(apiKey, domain, basePath, {}),
    "segments",
  );
  if (createResp.status === 403) {
    return {
      ok: false,
      message:
        `403 forbidden: the source API token needs the "createSegmentExport" action on proj/${projKey}:env/${envKey}:segment/${segmentKey}`,
    };
  }
  if (createResp.status >= 300) {
    return {
      ok: false,
      message:
        `starting export failed (HTTP ${createResp.status}): ${await createResp
          .text()}`,
    };
  }

  const createBody = await createResp.text().then((
    t,
  ) => (t ? JSON.parse(t) : {})).catch(() => ({}));
  const exportId = idFromLocation(createResp) ?? createBody.id;
  if (!exportId) {
    return {
      ok: false,
      message: `export started but no export ID was returned (body: ${
        JSON.stringify(createBody)
      })`,
    };
  }

  const done = await pollUntilDone(
    apiKey,
    domain,
    `${basePath}/${exportId}`,
    `export ${segmentKey}`,
  );
  if (!done.ok) {
    return {
      ok: false,
      message: `export did not complete: ${JSON.stringify(done.body)}`,
    };
  }

  const href = findDownloadHref(done.body._links);
  if (!href) {
    return {
      ok: false,
      message: `export complete but no download link found (links: ${
        Object.keys(done.body._links ?? {}).join(", ")
      })`,
    };
  }

  // Relative links are LaunchDarkly API paths and need auth; absolute links are pre-signed storage URLs.
  const fileResp = href.startsWith("/")
    ? await fetch(`https://${domain}${href}`, {
      headers: { Authorization: apiKey },
    })
    : await fetch(href);
  if (!fileResp.ok) {
    return {
      ok: false,
      message: `downloading export failed (HTTP ${fileResp.status})`,
    };
  }

  const bytes = new Uint8Array(await fileResp.arrayBuffer());
  await Deno.mkdir(outPath.substring(0, outPath.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.writeFile(outPath, bytes);
  return {
    ok: true,
    message: `exported ${done.body.size ?? `${bytes.length} B`} to ${outPath}`,
  };
}

/**
 * Exports contain one raw context key per line with no CSV quoting (keys containing commas or
 * quotes are written as-is), so each non-empty line is one whole key.
 */
export function readExportedKeys(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}
