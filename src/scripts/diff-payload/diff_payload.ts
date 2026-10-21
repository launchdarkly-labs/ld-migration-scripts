#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

import { parseArgs } from "jsr:@std/cli@^1.0.6/parse-args";
import { type DiffFormat, diffPayloads, fetchSDKPayload } from "./mod.ts";

const DEFAULT_KEYS_FILE = new URL(
  "../../../config/server_side_sdk_keys.json",
  import.meta.url,
);

interface ServerSideSdkKeys {
  sdkKeyA: string;
  sdkKeyB: string;
  /** Optional per-side polling base URLs, e.g. US for A and EU for B. */
  baseUrlA?: string;
  baseUrlB?: string;
}

async function loadKeysFromFile(
  keysPath: URL | string,
): Promise<ServerSideSdkKeys> {
  const configUrl = keysPath instanceof URL
    ? keysPath
    : keysPath.startsWith("/") || keysPath.match(/^[A-Za-z]:/)
    ? new URL(`file://${keysPath}`)
    : new URL(keysPath, `file://${Deno.cwd()}/`);
  const pathLabel = keysPath instanceof URL ? configUrl.pathname : keysPath;
  const text = await Deno.readTextFile(configUrl).catch((err) => {
    throw new Error(
      `Could not read keys file ${pathLabel}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  const data = JSON.parse(text) as Record<string, unknown>;
  const sdkKeyA = data.sdkKeyA;
  const sdkKeyB = data.sdkKeyB;
  if (typeof sdkKeyA !== "string" || typeof sdkKeyB !== "string") {
    throw new Error(
      "Keys file must contain sdkKeyA and sdkKeyB (strings). See config/server_side_sdk_keys.json.example.",
    );
  }
  const baseUrlA = typeof data.baseUrlA === "string"
    ? data.baseUrlA
    : undefined;
  const baseUrlB = typeof data.baseUrlB === "string"
    ? data.baseUrlB
    : undefined;
  return { sdkKeyA, sdkKeyB, baseUrlA, baseUrlB };
}

const args = parseArgs(Deno.args, {
  string: ["base-url", "base-url-a", "base-url-b", "format", "keys-file"],
  boolean: ["help", "include-segments"],
  alias: { h: "help", f: "format" },
  default: { format: "console", "include-segments": true },
});

if (args.help) {
  console.error(
    `Usage: diff_payload.ts [<sdk-key-a> <sdk-key-b>] [options]

Compare the SDK polling payloads from two LaunchDarkly environments.
Fetches /sdk/latest-all for each key and diffs the flag/segment rules.

Keys can be passed as two positional arguments, or read from a config file
(config/server_side_sdk_keys.json by default). Positionals override the file.

Arguments:
  sdk-key-a     First SDK key (left side of diff) — optional if using keys file
  sdk-key-b     Second SDK key (right side of diff) — optional if using keys file

Options:
  --format, -f          Diff format: console (default) | jsonpatch | delta
                          console    Human-readable colored text
                          jsonpatch  RFC 6902 ops array — {op, path, value}
                          delta      Raw jsondiffpatch delta — compact
  --no-include-segments  Exclude segments from the diff
  --base-url            SDK polling base URL for both sides (default: https://sdk.launchdarkly.com)
  --base-url-a          SDK polling base URL for key A (overrides --base-url; e.g. US)
  --base-url-b          SDK polling base URL for key B (overrides --base-url; e.g. https://sdk.eu.launchdarkly.com)
  --keys-file           Path to JSON file with sdkKeyA and sdkKeyB (default: config/server_side_sdk_keys.json)
  --help, -h            Show this help message

Environment variables:
  LD_BASE_URL            Alternative to --base-url
  LD_BASE_URL_A / LD_BASE_URL_B  Alternatives to --base-url-a / --base-url-b

Config file (when no two positionals given):
  Default path: config/server_side_sdk_keys.json
  Shape: { "sdkKeyA": "...", "sdkKeyB": "..." }
  Example: config/server_side_sdk_keys.json.example

Examples:
  deno task diff
  deno task diff sdk-xxx-111 sdk-xxx-222
  deno task diff -- --format jsonpatch | jq .
  deno task diff -- --keys-file ./config/server_side_sdk_keys.json`,
  );
  Deno.exit(0);
}

let sdkKeyA!: string;
let keysFile: ServerSideSdkKeys | undefined;
let sdkKeyB!: string;

if (args._.length >= 2) {
  sdkKeyA = String(args._[0]);
  sdkKeyB = String(args._[1]);
} else {
  const keysPath: URL | string = args["keys-file"] ?? DEFAULT_KEYS_FILE;
  try {
    const keys = await loadKeysFromFile(keysPath);
    keysFile = keys;
    sdkKeyA = keys.sdkKeyA;
    sdkKeyB = keys.sdkKeyB;
  } catch (err) {
    console.error(
      "Error loading SDK keys:",
      err instanceof Error ? err.message : String(err),
    );
    Deno.exit(1); // never returns
  }
}

const format = args.format as string;
if (format !== "jsonpatch" && format !== "delta" && format !== "console") {
  console.error(
    `Error: --format must be "jsonpatch", "delta", or "console"`,
  );
  Deno.exit(1);
}

const baseUrl = args["base-url"] ||
  Deno.env.get("LD_BASE_URL") ||
  "https://sdk.launchdarkly.com";
const baseUrlA = args["base-url-a"] || Deno.env.get("LD_BASE_URL_A") ||
  keysFile?.baseUrlA || baseUrl;
const baseUrlB = args["base-url-b"] || Deno.env.get("LD_BASE_URL_B") ||
  keysFile?.baseUrlB || baseUrl;

const includeSegments = args["include-segments"] as boolean;

// Fetch both payloads in parallel
console.error("Fetching payload A...");
console.error("Fetching payload B...");
const [payloadA, payloadB] = await Promise.all([
  fetchSDKPayload(sdkKeyA, baseUrlA),
  fetchSDKPayload(sdkKeyB, baseUrlB),
]);

const flagsA = (payloadA.flags ?? {}) as Record<string, unknown>;
const flagsB = (payloadB.flags ?? {}) as Record<string, unknown>;
console.error(`  A: ${Object.keys(flagsA).length} flags`);
console.error(`  B: ${Object.keys(flagsB).length} flags`);

if (includeSegments) {
  const segsA = (payloadA.segments ?? {}) as Record<string, unknown>;
  const segsB = (payloadB.segments ?? {}) as Record<string, unknown>;
  console.error(`  A: ${Object.keys(segsA).length} segments`);
  console.error(`  B: ${Object.keys(segsB).length} segments`);
}

// Diff
console.error("Diffing...");
const result = diffPayloads(payloadA, payloadB, {
  includeSegments,
  format: format as DiffFormat,
});

// Output
if (format === "console") {
  if (result.formatted) {
    console.log(result.formatted);
  } else {
    console.error("No differences found.");
  }
} else {
  console.log(result.formatted);
}

// Summary
const fs = result.flags;
console.error(
  `\nFlags:    ${fs.identical} identical, ${fs.changed} changed, ${fs.onlyLeft} only in A, ${fs.onlyRight} only in B`,
);

if (includeSegments && result.segments) {
  const ss = result.segments;
  console.error(
    `Segments: ${ss.identical} identical, ${ss.changed} changed, ${ss.onlyLeft} only in A, ${ss.onlyRight} only in B`,
  );
}
