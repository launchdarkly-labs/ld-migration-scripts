/**
 * Metadata of an existing destination segment that a rerun brings in line with the source.
 *
 * The segment update path patches targeting (included/excluded, context targets, rules). Name,
 * description and tags are not part of it; without this, a tag or description changed in the source
 * after the first run never reached the destination copy. With migration tags set, the destination
 * tags are the merge of source tags, migration tags and the tags already there (a tag on the copy is
 * never lost); without them the copy gets the source tags, as flags do.
 */

import { mergeTags } from "./tags.ts";

export interface SegmentMetadata {
  name?: string;
  description?: string | null;
  tags?: string[] | null;
}

export interface MetadataPatch {
  op: "replace";
  path: "/name" | "/description" | "/tags";
  value: string | string[];
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((t, i) => t === sb[i]);
}

/** Patches that make `existing` match `source`; empty when nothing differs. */
export function segmentMetadataPatches(
  source: SegmentMetadata,
  existing: SegmentMetadata,
  migrationTags: readonly string[] = [],
): MetadataPatch[] {
  const patches: MetadataPatch[] = [];
  if (source.name !== undefined && source.name !== existing.name) {
    patches.push({ op: "replace", path: "/name", value: source.name });
  }
  const desiredDescription = source.description ?? "";
  if (desiredDescription !== (existing.description ?? "")) {
    patches.push({
      op: "replace",
      path: "/description",
      value: desiredDescription,
    });
  }
  const desiredTags = migrationTags.length > 0
    ? mergeTags(source.tags, migrationTags, existing.tags)
    : mergeTags(source.tags);
  if (!sameTags(desiredTags, existing.tags ?? [])) {
    patches.push({ op: "replace", path: "/tags", value: desiredTags });
  }
  return patches;
}
