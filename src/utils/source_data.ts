// deno-lint-ignore-file no-explicit-any
/** Reads data written by `source-from-ld` without logging missing-file noise. */

import { sha256HexUtf8 } from "./utils.ts";

export const sourceProjectPath = (project: string) =>
  `./data/launchdarkly-migrations/source/project/${project}`;

async function readJsonIfExists(path: string): Promise<any | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/** Flag files are `{index}-{key}.json` (index in flags.json); older extracts used `{index}.json`, `{key}-{sha}.json` or `{key}.json`. */
export async function readExtractedFlag(
  projPath: string,
  index: number,
  key: string,
): Promise<any | undefined> {
  const dir = `${projPath}/flags`;
  return await readJsonIfExists(`${dir}/${index}-${key}.json`) ??
    await readJsonIfExists(`${dir}/${index}.json`).then((
      f,
    ) => (f?.key === key ? f : undefined)) ??
    await readJsonIfExists(`${dir}/${key}-${await sha256HexUtf8(key)}.json`) ??
    await readJsonIfExists(`${dir}/${key}.json`);
}

export async function readExtractedFlagKeys(
  projPath: string,
): Promise<string[]> {
  const keys = await readJsonIfExists(`${projPath}/flags.json`);
  if (!Array.isArray(keys)) {
    throw new Error(
      `No flag list at ${projPath}/flags.json; run source-from-ld first`,
    );
  }
  return keys;
}
