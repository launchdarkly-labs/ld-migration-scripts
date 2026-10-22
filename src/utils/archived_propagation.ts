/**
 * Flags the sync manifest records that have left the extracted flag list.
 *
 * The flags API omits archived flags unless asked (`--include-archived`), so a flag archived in the
 * source after it was migrated simply disappears from `flags.json` and the flag loop never sees it
 * again. The extraction therefore always records the source's archived flag keys
 * (`archived-flags.json`); this helper tells, for every recorded flag that is no longer in the flag
 * list, whether it was archived in the source (its destination copy is archived too) or deleted
 * there (its destination copy is kept and reported).
 */

export interface VanishedFlagsInput {
  /** Source keys of the flags the sync manifest records */
  manifestKeys: Iterable<string>;
  /** Source keys in the extracted (unfiltered) flag list */
  extractedKeys: Iterable<string>;
  /** Source keys the extraction found archived */
  archivedKeys: Iterable<string>;
  /** `includeFlags` / `excludeFlags` of this run, as comma-separated lists; a flag outside the scope is left alone */
  includeFlags?: string;
  excludeFlags?: string;
  /**
   * Extracted flags this run did not process (`--since` skipped them): their primary copy was not touched,
   * so their adopted copies are left alone too and they are not listed in `archivedInList`
   */
  skippedKeys?: Iterable<string>;
}

export interface VanishedFlags {
  /** Recorded flags archived in the source and absent from the flag list: archive every destination copy */
  archived: string[];
  /** Recorded flags neither live nor archived in the source: deleted there, destination copy kept */
  deleted: string[];
  /**
   * Recorded flags archived in the source that are in the flag list (--include-archived). The flag loop
   * archives their primary copy; adopted extra copies still need archiving.
   */
  archivedInList: string[];
}

function parseKeyList(list?: string): Set<string> | null {
  if (!list) return null;
  const keys = list.split(",").map((s) => s.trim()).filter(Boolean);
  return keys.length > 0 ? new Set(keys) : null;
}

export function classifyVanishedFlags(
  input: VanishedFlagsInput,
): VanishedFlags {
  const extracted = new Set(input.extractedKeys);
  const archivedInSource = new Set(input.archivedKeys);
  const include = parseKeyList(input.includeFlags);
  const exclude = parseKeyList(input.excludeFlags);
  const skipped = new Set(input.skippedKeys ?? []);
  const archived: string[] = [];
  const deleted: string[] = [];
  const archivedInList: string[] = [];
  for (const key of input.manifestKeys) {
    if (include && !include.has(key)) continue;
    if (exclude && exclude.has(key)) continue;
    if (extracted.has(key)) {
      if (archivedInSource.has(key) && !skipped.has(key)) {
        archivedInList.push(key);
      }
      continue;
    }
    (archivedInSource.has(key) ? archived : deleted).push(key);
  }
  return {
    archived: archived.sort(),
    deleted: deleted.sort(),
    archivedInList: archivedInList.sort(),
  };
}
