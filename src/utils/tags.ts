export function mergeTags(
  ...tagGroups: Array<readonly string[] | null | undefined>
): string[] {
  return [...new Set(tagGroups.flatMap((tags) => tags ?? []))];
}
