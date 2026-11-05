export interface FlagVariation {
  _id?: string;
  value: unknown;
  name?: string;
  description?: string;
  [key: string]: unknown;
}

export interface FlagDefaults {
  onVariation: number;
  offVariation: number;
}

export interface VariationPatchOp {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

export interface VariationPlan {
  /** Sent before environment patches: in-place edits, appended variations and defaults */
  before: VariationPatchOp[];
  /** Sent once every environment patch succeeded: removed variations, with the final defaults */
  after: VariationPatchOp[];
  /**
   * Destination index each source variation has between `before` and `after`; environment settings
   * (built from the source) are translated with it. After `after`, LaunchDarkly renumbers environment
   * references itself, so they line up with the source again.
   */
  sourceToDest: number[];
  /** Set when the destination flag cannot be brought in line by patching */
  incompatible?: string;
}

const FIELDS = ["value", "name", "description"] as const;

const key = (v: unknown) => JSON.stringify(v);

function editOps(
  src: FlagVariation,
  dest: FlagVariation,
  destIndex: number,
): VariationPatchOp[] {
  const ops: VariationPatchOp[] = [];
  for (const field of FIELDS) {
    const want = src[field];
    const have = dest[field];
    if (key(want) === key(have)) continue;
    const path = `/variations/${destIndex}/${field}`;
    if (want === undefined) ops.push({ op: "remove", path });
    else {ops.push({
        op: have === undefined ? "add" : "replace",
        path,
        value: want,
      });}
  }
  return ops;
}

function appendOp(src: FlagVariation): VariationPatchOp {
  const value: Record<string, unknown> = { value: src.value };
  if (src.name !== undefined) value.name = src.name;
  if (src.description !== undefined) value.description = src.description;
  return { op: "add", path: "/variations/-", value };
}

// Longest common subsequence of variation values: [destIndex, srcIndex] pairs in order
function matchByValue(
  src: FlagVariation[],
  dest: FlagVariation[],
): Array<[number, number]> {
  const n = dest.length, m = src.length;
  const len = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i][j] = key(dest[i].value) === key(src[j].value)
        ? len[i + 1][j + 1] + 1
        : Math.max(len[i + 1][j], len[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (key(dest[i].value) === key(src[j].value)) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (len[i + 1][j] >= len[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

interface Alignment {
  sourceToDest: number[]; // source index → destination index after edits and appends
  edits: Array<[number, number]>; // [destIndex, srcIndex] edited in place
  appended: number[]; // source indexes appended, in order
  removed: number[]; // destination indexes removed in `after`
}

// Keeps variations whose value survives, edits unmatched ones in place, removes the rest. Environments
// that serve a surviving variation keep serving it (same ID) while the others are removed around it.
function alignByValue(src: FlagVariation[], dest: FlagVariation[]): Alignment {
  const pairs = matchByValue(src, dest);
  const a: Alignment = {
    sourceToDest: new Array(src.length),
    edits: [],
    appended: [],
    removed: [],
  };
  const gap = (d0: number, d1: number, s0: number, s1: number) => {
    const edits = Math.min(d1 - d0, s1 - s0);
    for (let k = 0; k < edits; k++) {
      a.edits.push([d0 + k, s0 + k]);
      a.sourceToDest[s0 + k] = d0 + k;
    }
    for (let d = d0 + edits; d < d1; d++) a.removed.push(d);
    for (let s = s0 + edits; s < s1; s++) a.appended.push(s);
  };
  let d = 0, s = 0;
  for (const [di, si] of pairs) {
    gap(d, di, s, si);
    a.edits.push([di, si]); // same value; the name or description may differ
    a.sourceToDest[si] = di;
    d = di + 1;
    s = si + 1;
  }
  gap(d, dest.length, s, src.length);
  a.appended.forEach((si, k) => (a.sourceToDest[si] = dest.length + k));
  return a;
}

// Position by position: index i becomes source variation i. Handles values that moved between
// positions (a swap), which value matching would turn into a removal and a duplicate append.
function alignByPosition(
  src: FlagVariation[],
  dest: FlagVariation[],
): Alignment {
  const shared = Math.min(src.length, dest.length);
  return {
    sourceToDest: src.map((_, i) => i),
    edits: Array.from({ length: shared }, (_, i) => [i, i]),
    appended: Array.from(
      { length: Math.max(0, src.length - shared) },
      (_, k) => shared + k,
    ),
    removed: Array.from(
      { length: Math.max(0, dest.length - shared) },
      (_, k) => shared + k,
    ),
  };
}

// Appends land at the end, so a variation the source inserted mid-list would end up out of order;
// other flags' prerequisites reference this flag's variations by position, so the order must match
function keepsSourceOrder(a: Alignment, src: FlagVariation[]): boolean {
  const tail = src.length - a.appended.length;
  return a.appended.every((si, k) => si === tail + k);
}

// Values the destination holds between `before` and `after`: LaunchDarkly rejects duplicates
function intermediateIsDistinct(
  a: Alignment,
  src: FlagVariation[],
  dest: FlagVariation[],
): boolean {
  const values = dest.map((v) => key(v.value));
  for (const [di, si] of a.edits) values[di] = key(src[si].value);
  for (const si of a.appended) values.push(key(src[si].value));
  return new Set(values).size === values.length;
}

/**
 * Plans the JSON patches that make the destination variations match the source.
 *
 * Replacing the whole list without `_id`s makes LaunchDarkly delete every variation, which it rejects
 * while defaults or environments use them. Instead: surviving variations are kept, the others are
 * edited in place, new ones appended (`before`, with defaults); environments are then patched with
 * `sourceToDest`; finally removed variations are deleted together with the final defaults (`after`),
 * since LaunchDarkly renumbers environment references on removal but not defaults, and rejects a
 * patch that changes variations and environments together.
 */
export function planVariationSync(
  src: FlagVariation[],
  dest: FlagVariation[],
  options: {
    srcKind?: string;
    destKind?: string;
    srcDefaults?: FlagDefaults;
    destDefaults?: FlagDefaults;
  } = {},
): VariationPlan {
  const { srcKind, destKind, srcDefaults, destDefaults } = options;
  if (srcKind && destKind && srcKind !== destKind) {
    return {
      before: [],
      after: [],
      sourceToDest: src.map((_, i) => i),
      incompatible:
        `flag kind changed (${destKind} → ${srcKind}); LaunchDarkly cannot change a flag's kind, so the destination flag must be deleted and re-created`,
    };
  }

  let alignment = alignByValue(src, dest);
  if (
    !keepsSourceOrder(alignment, src) ||
    !intermediateIsDistinct(alignment, src, dest)
  ) {
    alignment = alignByPosition(src, dest);
    if (!intermediateIsDistinct(alignment, src, dest)) {
      return {
        before: [],
        after: [],
        sourceToDest: src.map((_, i) => i),
        incompatible:
          "variations could not be reconciled without a duplicate value; update the destination flag's variations by hand",
      };
    }
  }

  const before: VariationPatchOp[] = [];
  for (const [di, si] of alignment.edits) {
    before.push(...editOps(src[si], dest[di], di));
  }
  for (const si of alignment.appended) before.push(appendOp(src[si]));

  const removed = [...alignment.removed].sort((x, y) => y - x);
  const finalIndex = (i: number) => i - removed.filter((r) => r < i).length;
  const map = (d: FlagDefaults, f: (i: number) => number): FlagDefaults => ({
    onVariation: f(d.onVariation),
    offVariation: f(d.offVariation),
  });

  if (srcDefaults) {
    const interim = map(srcDefaults, (i) => alignment.sourceToDest[i]);
    if (key(interim) !== key(destDefaults)) {
      before.push({ op: "replace", path: "/defaults", value: interim });
    }
  }

  const after: VariationPatchOp[] = removed.map((i) => ({
    op: "remove",
    path: `/variations/${i}`,
  }));
  if (after.length > 0 && srcDefaults) {
    after.push({
      op: "replace",
      path: "/defaults",
      value: map(srcDefaults, (i) => finalIndex(alignment.sourceToDest[i])),
    });
  }

  return { before, after, sourceToDest: alignment.sourceToDest };
}

/** True when the plan changes the destination variations (defaults alone do not count) */
export function planChangesVariations(plan: VariationPlan): boolean {
  return plan.after.length > 0 ||
    plan.before.some((op) => op.path.startsWith("/variations"));
}

/**
 * The destination index of the variation with the value of source variation srcIndex, or undefined
 * when the destination has no such value (its variation update did not happen or was refused).
 * Variation values are distinct within a flag, so at most one matches.
 */
export function variationIndexByValue(
  srcVariations: FlagVariation[],
  destVariations: FlagVariation[],
  srcIndex: number,
): number | undefined {
  const source = srcVariations[srcIndex];
  if (!source) return undefined;
  const index = destVariations.findIndex((v) =>
    key(v.value) === key(source.value)
  );
  return index === -1 ? undefined : index;
}

/** True when environment settings need no translation */
export function isIdentityMapping(sourceToDest: number[]): boolean {
  return sourceToDest.every((d, s) => d === s);
}

/**
 * A copy of a source environment's settings with every variation index translated to the destination
 * (fallthrough, off variation, rules, rollouts and individual targets).
 */
export function translateVariationRefs<T extends Record<string, any>>(
  envConfig: T,
  sourceToDest: number[],
): T {
  const t = (i: unknown) =>
    typeof i === "number" && sourceToDest[i] !== undefined
      ? sourceToDest[i]
      : i;
  const serve = (s: any) => {
    if (!s || typeof s !== "object") return s;
    const out = { ...s };
    if ("variation" in out) out.variation = t(out.variation);
    if (out.rollout?.variations) {
      out.rollout = {
        ...out.rollout,
        variations: out.rollout.variations.map((rv: any) => ({
          ...rv,
          variation: t(rv.variation),
        })),
      };
    }
    return out;
  };
  const copy: Record<string, any> = { ...envConfig };
  if ("fallthrough" in copy) copy.fallthrough = serve(copy.fallthrough);
  if ("offVariation" in copy) copy.offVariation = t(copy.offVariation);
  if (Array.isArray(copy.rules)) copy.rules = copy.rules.map(serve);
  for (const field of ["targets", "contextTargets"]) {
    if (Array.isArray(copy[field])) copy[field] = copy[field].map(serve);
  }
  return copy as T;
}
