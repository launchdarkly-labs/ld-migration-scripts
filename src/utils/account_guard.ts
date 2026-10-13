/**
 * Guards against migrating a project onto itself (same account, same key).
 */

import * as Colors from "https://deno.land/std@0.149.0/fmt/colors.ts";
import { getDestinationApiKey, getSourceApiKey } from "./api_keys.ts";
import type { ProjectPair } from "./workflow_config.ts";

export const DEFAULT_DOMAIN = "app.launchdarkly.com";

type FetchFn = typeof fetch;

export interface AccountGuardDeps {
  fetchFn?: FetchFn;
  getSourceKey?: () => Promise<string>;
  getDestinationKey?: () => Promise<string>;
  warn?: (message: string) => void;
}

/**
 * Returns the account ID behind an API token via GET /api/v2/caller-identity.
 * @throws Error on a non-200 response or a response without accountId
 */
export async function getAccountId(
  apiKey: string,
  domain: string,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  const response = await fetchFn(`https://${domain}/api/v2/caller-identity`, {
    headers: { Authorization: apiKey },
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`caller-identity returned ${response.status}`);
  }
  const data = await response.json();
  if (typeof data?.accountId !== "string") {
    throw new Error("caller-identity response has no accountId");
  }
  return data.accountId;
}

/**
 * Throws when source and destination tokens belong to the same account and any pair
 * migrates a project onto the same key. Makes no API calls when the domains differ.
 * A failed account lookup only warns, so tokens without caller-identity access still run.
 */
export async function assertNotSelfMigration(
  pairs: ProjectPair[],
  sourceDomain: string | undefined,
  destDomain: string | undefined,
  deps: AccountGuardDeps = {},
): Promise<void> {
  const source = sourceDomain || DEFAULT_DOMAIN;
  const dest = destDomain || DEFAULT_DOMAIN;
  if (source !== dest) {
    return;
  }
  const sameKeyPairs = pairs.filter((p) => p.source === p.destination);
  if (sameKeyPairs.length === 0) {
    return;
  }

  const warn = deps.warn ?? ((m: string) => console.log(Colors.yellow(m)));
  const fetchFn = deps.fetchFn ?? fetch;

  let sourceAccount: string;
  let destAccount: string;
  try {
    [sourceAccount, destAccount] = await Promise.all([
      (deps.getSourceKey ?? getSourceApiKey)().then((key) =>
        getAccountId(key, source, fetchFn)
      ),
      (deps.getDestinationKey ?? getDestinationApiKey)().then((key) =>
        getAccountId(key, dest, fetchFn)
      ),
    ]);
  } catch (error) {
    warn(
      `Warning: could not verify that source and destination are different accounts (${
        error instanceof Error ? error.message : String(error)
      }); continuing`,
    );
    return;
  }

  if (sourceAccount === destAccount) {
    const list = sameKeyPairs.map((p) => p.source).join(", ");
    throw new Error(
      `Source and destination tokens belong to the same account (${sourceAccount}) on ${source}, ` +
        `so migrating ${list} would write into the source project(s). ` +
        `Use a destination token for a different account, or map these projects to new keys.`,
    );
  }
}
