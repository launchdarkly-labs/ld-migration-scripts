// deno-lint-ignore-file no-explicit-any
/**
 * Pure transforms from Split (Harness FME) objects to LaunchDarkly API
 * payload shapes, as consumed by migrate_between_ld_instances.ts via the
 * source-data directory format.
 *
 * Every transform also emits fidelity Notes so the migration report can say
 * exactly what mapped FULLy, what mapped PARTIALly, and what needs MANUAL
 * follow-up. Nothing here talks to the network.
 *
 * The mapping rules are documented in docs/SPLIT-MAPPING.md.
 */

import type {
  SplitBucket,
  SplitFlag,
  SplitFlagDefinition,
  SplitMatcher,
  SplitRbsMatcher,
  SplitRule,
  SplitRuleBasedSegment,
  SplitSegment,
  SplitTrafficType,
  SplitTreatment,
} from "./types.ts";

// ==================== Fidelity Notes ====================

export type NoteLevel = "FULL" | "PARTIAL" | "MANUAL" | "SKIPPED";

export interface Note {
  level: NoteLevel;
  /** Resource area, e.g. "flag", "segment", "context-kind". */
  area: string;
  /** Resource identifier, e.g. "my-flag (production)". */
  item: string;
  message: string;
  /** Exact Split JSON fragment for MANUAL items so a human can act on it. */
  splitFragment?: unknown;
}

const note = (
  level: NoteLevel,
  area: string,
  item: string,
  message: string,
  splitFragment?: unknown,
): Note => ({ level, area, item, message, ...(splitFragment !== undefined && { splitFragment }) });

// ==================== LD payload shapes ====================

export interface LDClause {
  attribute: string;
  op: string;
  values: unknown[];
  negate: boolean;
  contextKind: string;
}

export interface LDRolloutVariation {
  variation: number;
  weight: number;
}

export interface LDRollout {
  variations: LDRolloutVariation[];
  contextKind: string;
}

export interface LDRule {
  description?: string;
  clauses: LDClause[];
  variation?: number;
  rollout?: LDRollout;
  trackEvents: boolean;
}

export interface LDTarget {
  values: string[];
  variation: number;
  contextKind?: string;
}

export interface LDEnvConfig {
  on: boolean;
  offVariation: number;
  fallthrough: { variation: number } | { rollout: LDRollout };
  rules: LDRule[];
  targets?: LDTarget[];
  contextTargets?: LDTarget[];
  prerequisites?: Array<{ key: string; variation: number }>;
}

export interface LDVariation {
  value: unknown;
  name?: string;
}

export interface LDFlagPayload {
  key: string;
  name: string;
  description?: string;
  kind: "boolean" | "multivariate";
  temporary: boolean;
  tags: string[];
  variations: LDVariation[];
  defaults: { onVariation: number; offVariation: number };
  environments: Record<string, LDEnvConfig>;
}

export interface LDSegmentPayload {
  key: string;
  name: string;
  description?: string;
  tags?: string[];
  included?: string[];
  excluded?: string[];
  includedContexts?: Array<{ contextKind: string; values: string[] }>;
  excludedContexts?: Array<{ contextKind: string; values: string[] }>;
  rules?: Array<{ clauses: LDClause[] }>;
  unbounded?: boolean;
  unboundedContextKind?: string;
  /**
   * Members to load via the big segment CSV import endpoint. Not an LD API
   * field — consumed (and stripped) by migrate_between_ld_instances.ts.
   */
  _importKeys?: string[];
}

export interface LDContextKind {
  key: string;
  name: string;
  description?: string;
}

// ==================== Constants ====================

/** LD standard segments cap individual targets at 15,000 keys. */
export const STANDARD_SEGMENT_TARGET_LIMIT = 15_000;
/** Max adjacent rules a single Split rule may expand into (OR emulation). */
const MAX_RULE_EXPANSION = 8;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** LD's built-in context kind. Split's "user" traffic type maps onto it. */
export const USER_CONTEXT_KIND = "user";

// ==================== Keys ====================

/**
 * Sanitizes a Split name into a valid LD key (charset [A-Za-z0-9._-]).
 * Case is preserved by default because Split flag names are case-sensitive
 * code identifiers; pass lowercase=true for env/context-kind keys.
 */
export function sanitizeKey(name: string, opts: { lowercase?: boolean } = {}): string {
  let key = opts.lowercase ? name.toLowerCase() : name;
  key = key.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  if (key.length === 0) key = "unnamed";
  return key.slice(0, 256);
}

/** Allocates unique keys, suffixing -2, -3, ... on sanitization collisions. */
export class KeyRegistry {
  private readonly byName = new Map<string, string>();
  private readonly used = new Set<string>();

  constructor(private readonly opts: { lowercase?: boolean } = {}) {}

  keyFor(name: string): string {
    const existing = this.byName.get(name);
    if (existing) return existing;
    const base = sanitizeKey(name, this.opts);
    let key = base;
    for (let n = 2; this.used.has(key); n++) key = `${base}-${n}`;
    this.byName.set(name, key);
    this.used.add(key);
    return key;
  }

  entries(): Array<[string, string]> {
    return [...this.byName.entries()];
  }
}

/** LD tags may not contain ':'; sanitize the rest conservatively. */
export function sanitizeTag(tag: string): string {
  return tag.replace(/[^A-Za-z0-9._\- ]+/g, "-").trim();
}

// ==================== Context kinds ====================

/** Context kind keys LD reserves. */
const RESERVED_CONTEXT_KINDS = new Set(["kind", "multi"]);

export function mapTrafficTypes(
  trafficTypes: SplitTrafficType[],
): { contextKinds: LDContextKind[]; kindByTrafficType: Map<string, string>; notes: Note[] } {
  const notes: Note[] = [];
  const contextKinds: LDContextKind[] = [];
  const kindByTrafficType = new Map<string, string>();
  const registry = new KeyRegistry({ lowercase: true });

  for (const tt of trafficTypes) {
    if (tt.name.toLowerCase() === USER_CONTEXT_KIND) {
      kindByTrafficType.set(tt.name, USER_CONTEXT_KIND);
      notes.push(note("FULL", "context-kind", tt.name, `Mapped to LD's built-in "user" context kind`));
      continue;
    }
    let key = registry.keyFor(tt.name);
    if (RESERVED_CONTEXT_KINDS.has(key)) {
      key = `${key}-context`;
      notes.push(note(
        "PARTIAL",
        "context-kind",
        tt.name,
        `"${tt.name}" is a reserved LD context kind key; using "${key}" instead`,
      ));
    }
    kindByTrafficType.set(tt.name, key);
    contextKinds.push({
      key,
      name: tt.name,
      description: `Migrated from Split traffic type "${tt.name}"`,
    });
    notes.push(note("FULL", "context-kind", tt.name, `Mapped to LD context kind "${key}"`));
  }

  return { contextKinds, kindByTrafficType, notes };
}

// ==================== Variations ====================

export interface VariationDecision {
  kind: "boolean" | "multivariate";
  variations: LDVariation[];
  indexByTreatment: Map<string, number>;
  notes: Note[];
}

const parseConfiguration = (config: string | undefined): unknown => {
  if (config === undefined || config === null || config === "") return null;
  try {
    return JSON.parse(config);
  } catch {
    return config; // Non-JSON configuration strings survive as raw strings
  }
};

/**
 * Decides the LD variation set for a flag from its per-environment Split
 * definitions (envs listed in priority order; the first env wins ties):
 *   - exactly {on, off} treatments and zero configurations anywhere → boolean
 *   - any treatment with a configuration anywhere → JSON variations of
 *     {"treatment": name, "config": parsed|null} (names stay unique and the
 *     Split getTreatmentWithConfig() pair survives the round trip)
 *   - otherwise → string variations valued by treatment name
 */
export function decideVariations(
  flagName: string,
  defsInPriorityOrder: SplitFlagDefinition[],
): VariationDecision {
  const notes: Note[] = [];
  const treatmentOrder: string[] = [];
  const configByTreatment = new Map<string, { value: unknown; envName: string }>();
  let hasAnyConfig = false;

  for (const def of defsInPriorityOrder) {
    const envName = def.environment?.name ?? "?";
    for (const t of def.treatments ?? []) {
      if (!treatmentOrder.includes(t.name)) treatmentOrder.push(t.name);
      if (t.configurations !== undefined && t.configurations !== null && t.configurations !== "") {
        hasAnyConfig = true;
        const parsed = parseConfiguration(t.configurations);
        const existing = configByTreatment.get(t.name);
        if (existing === undefined) {
          configByTreatment.set(t.name, { value: parsed, envName });
        } else if (JSON.stringify(existing.value) !== JSON.stringify(parsed)) {
          notes.push(note(
            "PARTIAL",
            "flag",
            flagName,
            `Treatment "${t.name}" has different configurations across environments; ` +
              `LD variations are flag-global, so the "${existing.envName}" value was used ` +
              `(the "${envName}" value differs)`,
            { treatment: t.name, kept: existing.value, dropped: parsed },
          ));
        }
      }
    }
  }

  const indexByTreatment = new Map<string, number>();
  treatmentOrder.forEach((name, i) => indexByTreatment.set(name, i));

  const isPlainOnOff = !hasAnyConfig &&
    treatmentOrder.length === 2 &&
    treatmentOrder.includes("on") &&
    treatmentOrder.includes("off");

  if (isPlainOnOff) {
    return {
      kind: "boolean",
      variations: treatmentOrder.map((name) => ({ value: name === "on", name })),
      indexByTreatment,
      notes,
    };
  }

  if (hasAnyConfig) {
    notes.push(note(
      "FULL",
      "flag",
      flagName,
      `Treatments carry dynamic configurations; mapped to JSON variations of ` +
        `{"treatment", "config"} — update getTreatment() call sites to read the "config" field`,
    ));
    return {
      kind: "multivariate",
      variations: treatmentOrder.map((name) => ({
        value: { treatment: name, config: configByTreatment.get(name)?.value ?? null },
        name,
      })),
      indexByTreatment,
      notes,
    };
  }

  return {
    kind: "multivariate",
    variations: treatmentOrder.map((name) => ({ value: name, name })),
    indexByTreatment,
    notes,
  };
}

// ==================== Matchers → clauses ====================

export interface MappingContext {
  /** Split traffic type name → LD context kind key. */
  kindByTrafficType: Map<string, string>;
  /** Split segment name → LD segment key (standard, large, and rule-based). */
  segmentKeyByName: Map<string, string>;
  /** Split flag name → LD flag key. */
  flagKeyByName: Map<string, string>;
  /**
   * Resolves an IN_SPLIT dependency to an LD prerequisite: the dependency
   * flag's LD key and the LD variation index of the required treatment.
   */
  resolvePrerequisite?: (
    splitName: string,
    treatment: string,
  ) => { key: string; variation: number } | null;
}

/** Split epochs are documented as ms but appear as seconds in examples; normalize. */
export const normalizeEpochMs = (value: number): number =>
  value < 1e11 ? value * 1000 : value;

const truncateToMinute = (ms: number): number => ms - (ms % MINUTE_MS);
const truncateToUtcDay = (ms: number): number => ms - (ms % DAY_MS);

const clause = (
  attribute: string,
  op: string,
  values: unknown[],
  contextKind: string,
  negate = false,
): LDClause => ({ attribute, op, values, negate, contextKind });

type MatcherResult =
  | { ok: true; clauses: LDClause[]; notes: Note[] }
  | { ok: false; reason: string; level: NoteLevel };

/**
 * Maps one Split matcher to a set of AND'd LD clauses (negation is applied
 * by the caller via De Morgan expansion when the matcher yields >1 clause).
 */
function mapMatcherPositive(
  m: SplitMatcher,
  contextKind: string,
  ctx: MappingContext,
  item: string,
): MatcherResult {
  // Split matches against the customer key when no attribute is set.
  const attr = m.attribute && m.attribute.length > 0 ? m.attribute : "key";
  const notes: Note[] = [];
  const ok = (clauses: LDClause[]): MatcherResult => ({ ok: true, clauses, notes });

  switch (m.type) {
    // ---- Everyone ----
    case "ALL_KEYS":
      // "All contexts of this kind" idiom: match on the built-in kind attribute.
      return ok([clause("kind", "in", [contextKind], "")]);

    // ---- Strings ----
    case "IN_LIST_STRING":
      return ok([clause(attr, "in", m.strings ?? [], contextKind)]);
    case "STARTS_WITH_STRING":
      return ok([clause(attr, "startsWith", m.strings ?? [], contextKind)]);
    case "ENDS_WITH_STRING":
      return ok([clause(attr, "endsWith", m.strings ?? [], contextKind)]);
    case "CONTAINS_STRING":
      return ok([clause(attr, "contains", m.strings ?? [], contextKind)]);
    case "MATCHES_STRING":
      notes.push(note(
        "PARTIAL",
        "rule",
        item,
        `MATCHES_STRING regex "${m.string}" copied verbatim; Split (java.util.regex) and ` +
          `LD SDK regex dialects differ — verify the pattern behaves identically`,
      ));
      return ok([clause(attr, "matches", [m.string], contextKind)]);

    // ---- Booleans ----
    case "BOOLEAN":
      return ok([clause(attr, "in", [m.bool ?? true], contextKind)]);

    // ---- Numbers ----
    case "EQUAL_NUMBER":
      return ok([clause(attr, "in", [m.number], contextKind)]);
    case "LESS_THAN_OR_EQUAL_NUMBER":
      return ok([clause(attr, "lessThanOrEqual", [m.number], contextKind)]);
    case "GREATER_THAN_OR_EQUAL_NUMBER":
      return ok([clause(attr, "greaterThanOrEqual", [m.number], contextKind)]);
    case "BETWEEN_NUMBER":
      return ok([
        clause(attr, "greaterThanOrEqual", [m.between?.from], contextKind),
        clause(attr, "lessThanOrEqual", [m.between?.to], contextKind),
      ]);

    // ---- Sets (LD array-attribute semantics: "in" matches any element) ----
    case "ANY_OF_SET":
      return ok([clause(attr, "in", m.strings ?? [], contextKind)]);
    case "ALL_OF_SET":
      return ok((m.strings ?? []).map((s) => clause(attr, "in", [s], contextKind)));
    case "EQUAL_SET":
      return {
        ok: false,
        level: "MANUAL",
        reason:
          `EQUAL_SET (set equality) has no LD clause equivalent — no operator can require ` +
          `an attribute to contain exactly a given set`,
      };
    case "PART_OF_SET":
      return {
        ok: false,
        level: "MANUAL",
        reason:
          `PART_OF_SET (subset-of) has no LD clause equivalent — no operator can require ` +
          `every attribute element to be within a given set`,
      };

    // ---- Dates (Split truncates to minutes; ON_DATE to the day) ----
    case "ON_DATE": {
      const day = truncateToUtcDay(normalizeEpochMs(m.date ?? 0));
      notes.push(note(
        "PARTIAL",
        "rule",
        item,
        `ON_DATE mapped to a [day-start, next-day) window using UTC day boundaries; ` +
          `Split's day-equality semantics may use a different timezone`,
      ));
      return ok([
        clause(attr, "before", [day], contextKind, true), // NOT before day-start ⇒ ≥ day-start
        clause(attr, "before", [day + DAY_MS], contextKind),
      ]);
    }
    case "ON_OR_AFTER_DATE": {
      const minute = truncateToMinute(normalizeEpochMs(m.date ?? 0));
      // x ≥ minute ⇔ NOT (x before minute)
      return ok([clause(attr, "before", [minute], contextKind, true)]);
    }
    case "ON_OR_BEFORE_DATE": {
      const minute = truncateToMinute(normalizeEpochMs(m.date ?? 0));
      // Split compares at minute granularity: x ≤ minute ⇔ x before (minute + 1min)
      return ok([clause(attr, "before", [minute + MINUTE_MS], contextKind)]);
    }
    case "BETWEEN_DATE": {
      const from = truncateToMinute(normalizeEpochMs(m.between?.from ?? 0));
      const to = truncateToMinute(normalizeEpochMs(m.between?.to ?? 0));
      return ok([
        clause(attr, "before", [from], contextKind, true),
        clause(attr, "before", [to + MINUTE_MS], contextKind),
      ]);
    }

    // ---- Semver (≥ / ≤ via the LD negate idiom) ----
    case "EQUAL_TO_SEMVER":
      return ok([clause(attr, "semVerEqual", [m.string], contextKind)]);
    case "GREATER_THAN_OR_EQUAL_TO_SEMVER":
      return ok([clause(attr, "semVerLessThan", [m.string], contextKind, true)]);
    case "LESS_THAN_OR_EQUAL_TO_SEMVER":
      return ok([clause(attr, "semVerGreaterThan", [m.string], contextKind, true)]);
    case "BETWEEN_SEMVER":
      return ok([
        clause(attr, "semVerLessThan", [m.between?.from], contextKind, true),
        clause(attr, "semVerGreaterThan", [m.between?.to], contextKind, true),
      ]);
    case "IN_LIST_SEMVER":
      return ok([clause(attr, "semVerEqual", m.strings ?? (m.string ? [m.string] : []), contextKind)]);

    // ---- Segments ----
    case "IN_SEGMENT":
    case "IN_LARGE_SEGMENT":
    case "IN_RULE_BASED_SEGMENT": {
      const segmentName = m.string ?? "";
      const segmentKey = ctx.segmentKeyByName.get(segmentName) ?? sanitizeKey(segmentName);
      if (!ctx.segmentKeyByName.has(segmentName)) {
        notes.push(note(
          "PARTIAL",
          "rule",
          item,
          `Segment "${segmentName}" was not part of this extract; the rule references ` +
            `segment key "${segmentKey}" which must exist in LD for the rule to work`,
        ));
      }
      return ok([segmentMatchClause(segmentKey)]);
    }

    // ---- Flag dependencies ----
    case "IN_SPLIT":
      // Only expressible as a prerequisite in the specific whole-flag shape
      // handled by mapEnvironment; as a clause it is impossible.
      return {
        ok: false,
        level: "MANUAL",
        reason:
          `IN_SPLIT (depends on flag "${m.depends?.splitName}" serving ` +
          `"${m.depends?.treatment}") cannot be expressed as an LD clause in this rule shape; ` +
          `recreate as a prerequisite or restructure the flag`,
      };

    default:
      return {
        ok: false,
        level: "MANUAL",
        reason: `Unknown Split matcher type "${m.type}"`,
      };
  }
}

export const segmentMatchClause = (segmentKey: string, negate = false): LDClause => ({
  attribute: "segmentMatch",
  op: "segmentMatch",
  values: [segmentKey],
  negate,
  contextKind: "",
});

/**
 * Maps a matcher (including its negate flag) to OR'd groups of AND'd clauses.
 * A negated multi-clause matcher becomes one OR-group per negated clause
 * (De Morgan); the caller cross-products groups into adjacent LD rules.
 */
function mapMatcherToGroups(
  m: SplitMatcher,
  contextKind: string,
  ctx: MappingContext,
  item: string,
): { groups: LDClause[][]; notes: Note[] } | { error: string; level: NoteLevel } {
  const result = mapMatcherPositive(m, contextKind, ctx, item);
  if (!result.ok) return { error: result.reason, level: result.level };

  if (!m.negate) {
    return { groups: [result.clauses], notes: result.notes };
  }
  // NOT (c1 AND c2 AND ...) = (NOT c1) OR (NOT c2) OR ...
  return {
    groups: result.clauses.map((c) => [{ ...c, negate: !c.negate }]),
    notes: result.notes,
  };
}

// ==================== Rules / rollouts ====================

function bucketsToOutcome(
  buckets: SplitBucket[],
  indexByTreatment: Map<string, number>,
  contextKind: string,
  item: string,
  notes: Note[],
  defaultTreatment?: string,
): { variation: number } | { rollout: LDRollout } | null {
  const known = buckets.filter((b) => indexByTreatment.has(b.treatment));
  for (const b of buckets) {
    if (!indexByTreatment.has(b.treatment)) {
      notes.push(note(
        "PARTIAL",
        "rule",
        item,
        `Bucket treatment "${b.treatment}" is not a known treatment; bucket dropped`,
        b,
      ));
    }
  }
  if (known.length === 0) return null;

  if (known.length === 1 && known[0].size === 100) {
    return { variation: indexByTreatment.get(known[0].treatment)! };
  }

  const weights = known.map((b) => ({
    variation: indexByTreatment.get(b.treatment)!,
    weight: Math.round(b.size * 1000),
  }));
  const sum = weights.reduce((s, w) => s + w.weight, 0);

  if (sum !== 100_000) {
    // Prefer assigning the remainder to the default treatment (Split serves
    // it to unallocated traffic), else adjust the largest bucket.
    const defaultIdx = defaultTreatment !== undefined ? indexByTreatment.get(defaultTreatment) : undefined;
    let target = defaultIdx !== undefined ? weights.find((w) => w.variation === defaultIdx) : undefined;
    if (!target && defaultIdx !== undefined && sum < 100_000) {
      target = { variation: defaultIdx, weight: 0 };
      weights.push(target);
    }
    if (!target) target = weights.reduce((a, b) => (a.weight >= b.weight ? a : b));
    target.weight = Math.max(0, target.weight + (100_000 - sum));
    notes.push(note(
      "PARTIAL",
      "rule",
      item,
      `Bucket sizes summed to ${sum / 1000}% in Split; normalized to 100% by adjusting ` +
        `the ${defaultIdx !== undefined ? "default treatment" : "largest"} bucket`,
    ));
  }

  return { rollout: { variations: weights, contextKind } };
}

interface RuleMappingInput {
  rule: SplitRule;
  ruleIndex: number;
  contextKind: string;
  indexByTreatment: Map<string, number>;
  defaultTreatment?: string;
  ctx: MappingContext;
  item: string;
}

/** Maps one Split rule to 1..N adjacent LD rules (N > 1 when OR-expansion applies). */
function mapRule(input: RuleMappingInput): { rules: LDRule[]; notes: Note[] } {
  const { rule, ruleIndex, contextKind, indexByTreatment, defaultTreatment, ctx, item } = input;
  const notes: Note[] = [];

  // Cross-product of per-matcher OR-groups → one LD rule per combination.
  let combinations: LDClause[][] = [[]];
  for (const matcher of rule.condition?.matchers ?? []) {
    const mapped = mapMatcherToGroups(matcher, contextKind, ctx, item);
    if ("error" in mapped) {
      notes.push(note(
        mapped.level,
        "rule",
        item,
        `Rule #${ruleIndex + 1} skipped: ${mapped.error}`,
        rule,
      ));
      return { rules: [], notes };
    }
    notes.push(...mapped.notes);
    combinations = combinations.flatMap((prefix) =>
      mapped.groups.map((group) => [...prefix, ...group])
    );
    if (combinations.length > MAX_RULE_EXPANSION) {
      notes.push(note(
        "MANUAL",
        "rule",
        item,
        `Rule #${ruleIndex + 1} skipped: negated matchers require OR logic that expands to ` +
          `more than ${MAX_RULE_EXPANSION} LD rules — restructure manually`,
        rule,
      ));
      return { rules: [], notes };
    }
  }

  if (combinations.length === 1 && combinations[0].length === 0) {
    notes.push(note(
      "PARTIAL",
      "rule",
      item,
      `Rule #${ruleIndex + 1} had no matchers; mapped as an all-contexts rule`,
    ));
    combinations = [[clause("kind", "in", [contextKind], "")]];
  }

  const outcome = bucketsToOutcome(
    rule.buckets ?? [],
    indexByTreatment,
    contextKind,
    item,
    notes,
    defaultTreatment,
  );
  if (outcome === null) {
    notes.push(note(
      "MANUAL",
      "rule",
      item,
      `Rule #${ruleIndex + 1} skipped: no usable buckets`,
      rule,
    ));
    return { rules: [], notes };
  }

  const expanded = combinations.length > 1;
  const rules = combinations.map((clauses, i) => ({
    ...(expanded && {
      description: `Split rule #${ruleIndex + 1} (OR expansion ${i + 1}/${combinations.length})`,
    }),
    clauses,
    ...outcome,
    trackEvents: false,
  }));
  return { rules, notes };
}

// ==================== Environment definition ====================

export interface EnvMappingResult {
  envConfig: LDEnvConfig;
  notes: Note[];
}

/**
 * Detects the one Split shape that maps to an LD prerequisite:
 * a single rule whose sole matcher is a plain (not negated, no attribute)
 * IN_SPLIT, with the default rule serving 100% default treatment.
 */
function tryPrerequisiteShape(
  def: SplitFlagDefinition,
): { depends: { splitName: string; treatment: string }; buckets: SplitBucket[] } | null {
  const rules = def.rules ?? [];
  if (rules.length !== 1) return null;
  const matchers = rules[0].condition?.matchers ?? [];
  if (matchers.length !== 1) return null;
  const m = matchers[0];
  if (m.type !== "IN_SPLIT" || m.negate || (m.attribute && m.attribute.length > 0)) return null;
  if (!m.depends?.splitName || !m.depends?.treatment) return null;
  const dr = def.defaultRule ?? [];
  const servesDefault = dr.length === 0 ||
    (dr.length === 1 && dr[0].treatment === def.defaultTreatment && dr[0].size === 100);
  if (!servesDefault) return null;
  return { depends: m.depends, buckets: rules[0].buckets ?? [] };
}

/** Maps one per-environment Split flag definition to an LD environment config. */
export function mapEnvironment(
  def: SplitFlagDefinition,
  decision: VariationDecision,
  ctx: MappingContext,
  envLabel: string,
): EnvMappingResult {
  const notes: Note[] = [];
  const item = `${def.name} (${envLabel})`;
  const trafficTypeName = def.trafficType?.name ?? USER_CONTEXT_KIND;
  const contextKind = ctx.kindByTrafficType.get(trafficTypeName) ?? USER_CONTEXT_KIND;
  const { indexByTreatment } = decision;

  const offVariation = indexByTreatment.get(def.defaultTreatment) ?? 0;
  if (!indexByTreatment.has(def.defaultTreatment)) {
    notes.push(note(
      "PARTIAL",
      "flag",
      item,
      `defaultTreatment "${def.defaultTreatment}" is not a known treatment; using variation 0 as off`,
    ));
  }

  if ((def.trafficAllocation ?? 100) < 100) {
    notes.push(note(
      "PARTIAL",
      "flag",
      item,
      `Split limits this flag's rules to ${def.trafficAllocation}% of traffic (the rest gets ` +
        `"${def.defaultTreatment}" before any rule runs). LD has no equivalent — migrated as 100% ` +
        `allocation, so MORE users will match targeting rules than in Split`,
    ));
  }

  notes.push(note(
    "PARTIAL",
    "flag",
    item,
    `Percentage rollouts re-bucket at cutover: Split and LD hash differently, so individual ` +
      `users may switch treatments even at identical percentages`,
  ));

  // ---- Prerequisite shape ----
  const prereqShape = tryPrerequisiteShape(def);
  if (prereqShape && ctx.resolvePrerequisite) {
    const resolved = ctx.resolvePrerequisite(
      prereqShape.depends.splitName,
      prereqShape.depends.treatment,
    );
    if (resolved) {
      const outcome = bucketsToOutcome(
        prereqShape.buckets,
        indexByTreatment,
        contextKind,
        item,
        notes,
        def.defaultTreatment,
      );
      const fallthrough = outcome ?? { variation: offVariation };
      notes.push(note(
        "FULL",
        "flag",
        item,
        `IN_SPLIT dependency on "${prereqShape.depends.splitName}" mapped to an LD prerequisite`,
      ));
      return {
        envConfig: {
          on: !(def.killed ?? false),
          offVariation,
          fallthrough,
          rules: [],
          prerequisites: [resolved],
          ...buildTargets(def, indexByTreatment, contextKind, item, notes),
        },
        notes,
      };
    }
    // Fall through to normal rule mapping (which will emit MANUAL for IN_SPLIT).
  }

  // ---- Rules ----
  let rules: LDRule[] = [];
  (def.rules ?? []).forEach((rule, ruleIndex) => {
    const mapped = mapRule({
      rule,
      ruleIndex,
      contextKind,
      indexByTreatment,
      defaultTreatment: def.defaultTreatment,
      ctx,
      item,
    });
    notes.push(...mapped.notes);
    rules.push(...mapped.rules);
  });

  // ---- Treatment-level segment targeting (prepended, serve that treatment) ----
  const segmentRules: LDRule[] = [];
  for (const treatment of def.treatments ?? []) {
    const variation = indexByTreatment.get(treatment.name);
    if (variation === undefined) continue;
    for (const segmentName of treatment.segments ?? []) {
      const segmentKey = ctx.segmentKeyByName.get(segmentName) ?? sanitizeKey(segmentName);
      segmentRules.push({
        description: `Split treatment "${treatment.name}" segment targeting: ${segmentName}`,
        clauses: [segmentMatchClause(segmentKey)],
        variation,
        trackEvents: false,
      });
    }
  }
  rules = [...segmentRules, ...rules];

  // ---- Fallthrough (default rule) ----
  const fallthroughOutcome = bucketsToOutcome(
    def.defaultRule ?? [],
    indexByTreatment,
    contextKind,
    item,
    notes,
    def.defaultTreatment,
  );
  const fallthrough = fallthroughOutcome ?? { variation: offVariation };

  return {
    envConfig: {
      on: !(def.killed ?? false),
      offVariation,
      fallthrough,
      rules,
      ...buildTargets(def, indexByTreatment, contextKind, item, notes),
    },
    notes,
  };
}

/** treatments[].keys → individual targets, deduped first-wins across treatments. */
function buildTargets(
  def: SplitFlagDefinition,
  indexByTreatment: Map<string, number>,
  contextKind: string,
  item: string,
  notes: Note[],
): { targets?: LDTarget[]; contextTargets?: LDTarget[] } {
  const seen = new Map<string, string>(); // key → first treatment
  const byVariation = new Map<number, string[]>();

  for (const treatment of def.treatments ?? []) {
    const variation = indexByTreatment.get(treatment.name);
    if (variation === undefined) continue;
    for (const key of treatment.keys ?? []) {
      const first = seen.get(key);
      if (first !== undefined) {
        if (first !== treatment.name) {
          notes.push(note(
            "PARTIAL",
            "flag",
            item,
            `Key "${key}" is individually targeted by both "${first}" and "${treatment.name}"; ` +
              `LD allows one variation per key — kept "${first}"`,
          ));
        }
        continue;
      }
      seen.set(key, treatment.name);
      const list = byVariation.get(variation) ?? [];
      list.push(key);
      byVariation.set(variation, list);
    }
  }

  if (byVariation.size === 0) return {};
  const entries = [...byVariation.entries()].map(([variation, values]) => ({ values, variation }));
  if (contextKind === USER_CONTEXT_KIND) {
    return { targets: entries };
  }
  return { contextTargets: entries.map((t) => ({ ...t, contextKind })) };
}

// ==================== Whole flag ====================

export interface FlagMappingInput {
  /** Flag metadata from the workspace flag list (may be null if unavailable). */
  meta: SplitFlag | null;
  splitName: string;
  flagKey: string;
  /** LD env key → Split definition for that environment. */
  defsByLdEnv: Record<string, SplitFlagDefinition>;
  /** LD env keys in priority order (first = wins variation-config ties). */
  envPriority: string[];
  decision: VariationDecision;
  ctx: MappingContext;
  /** Extra tags to apply (e.g. "imported-from-split"). */
  extraTags?: string[];
  /** Names of Split flag sets containing this flag → tags "flagset.<name>". */
  flagSetNames?: string[];
}

export function mapFlag(input: FlagMappingInput): { flag: LDFlagPayload; notes: Note[] } {
  const { meta, splitName, flagKey, defsByLdEnv, envPriority, decision, ctx } = input;
  const notes: Note[] = [...decision.notes];

  // Tags: Split tags + flag sets (LD tags forbid ':') + extra tags.
  const tags = new Set<string>();
  for (const t of meta?.tags ?? []) {
    if (t?.name) tags.add(sanitizeTag(t.name));
  }
  for (const fs of input.flagSetNames ?? []) {
    tags.add(sanitizeTag(`flagset.${fs}`));
  }
  for (const t of input.extraTags ?? []) tags.add(sanitizeTag(t));

  // Defaults for environments created later: off = priority env's default
  // treatment; on = its fallthrough treatment when fixed, else variation 0.
  const priorityDef = envPriority.map((e) => defsByLdEnv[e]).find((d) => d !== undefined);
  let defaultOff = 0;
  let defaultOn = 0;
  if (priorityDef) {
    defaultOff = decision.indexByTreatment.get(priorityDef.defaultTreatment) ?? 0;
    const dr = priorityDef.defaultRule ?? [];
    if (dr.length === 1 && dr[0].size === 100) {
      defaultOn = decision.indexByTreatment.get(dr[0].treatment) ?? 0;
    }
  }

  const environments: Record<string, LDEnvConfig> = {};
  for (const [ldEnvKey, def] of Object.entries(defsByLdEnv)) {
    const mapped = mapEnvironment(def, decision, ctx, ldEnvKey);
    environments[ldEnvKey] = mapped.envConfig;
    notes.push(...mapped.notes);
  }

  const flag: LDFlagPayload = {
    key: flagKey,
    name: splitName,
    description: meta?.description ?? "",
    kind: decision.kind,
    temporary: false,
    tags: [...tags],
    variations: decision.variations,
    defaults: { onVariation: defaultOn, offVariation: defaultOff },
    environments,
  };

  return { flag, notes };
}

// ==================== Segments ====================

export interface StandardSegmentInput {
  meta: SplitSegment | null;
  splitName: string;
  segmentKey: string;
  keys: string[];
  ctx: MappingContext;
  extraTags?: string[];
}

/**
 * Standard Split segment → LD segment with individual targets. Segments over
 * LD's 15,000-target cap are upgraded to big (unbounded) segments whose
 * members are loaded via CSV import (see _importKeys).
 */
export function mapStandardSegment(
  input: StandardSegmentInput,
): { segment: LDSegmentPayload; notes: Note[] } {
  const { meta, splitName, segmentKey, keys, ctx } = input;
  const notes: Note[] = [];
  const trafficTypeName = meta?.trafficType?.name ?? USER_CONTEXT_KIND;
  const contextKind = ctx.kindByTrafficType.get(trafficTypeName) ?? USER_CONTEXT_KIND;

  const tags = new Set<string>((input.extraTags ?? []).map(sanitizeTag));
  for (const t of meta?.tags ?? []) {
    if (t?.name) tags.add(sanitizeTag(t.name));
  }

  const base: LDSegmentPayload = {
    key: segmentKey,
    name: splitName,
    description: meta?.description ?? "",
    ...(tags.size > 0 && { tags: [...tags] }),
  };

  if (keys.length > STANDARD_SEGMENT_TARGET_LIMIT) {
    notes.push(note(
      "PARTIAL",
      "segment",
      splitName,
      `${keys.length} keys exceeds LD's ${STANDARD_SEGMENT_TARGET_LIMIT} individual-target cap ` +
        `for standard segments; upgraded to a big (unbounded) segment with CSV member import`,
    ));
    return {
      segment: { ...base, unbounded: true, unboundedContextKind: contextKind, _importKeys: keys },
      notes,
    };
  }

  notes.push(note("FULL", "segment", splitName, `Mapped with ${keys.length} included key(s)`));
  if (contextKind === USER_CONTEXT_KIND) {
    return { segment: { ...base, included: keys }, notes };
  }
  return { segment: { ...base, includedContexts: [{ contextKind, values: keys }] }, notes };
}

// ---- Rule-based segments ----

/** RBS operator dialect (attribute/operator/value) → LD clause op. */
const RBS_OPERATOR_MAP: Record<string, { op: string; negate?: boolean }> = {
  equals: { op: "in" },
  not_equals: { op: "in", negate: true },
  contains: { op: "contains" },
  starts_with: { op: "startsWith" },
  ends_with: { op: "endsWith" },
  matches: { op: "matches" },
  greater_than: { op: "greaterThan" },
  greater_than_or_equal: { op: "greaterThanOrEqual" },
  less_than: { op: "lessThan" },
  less_than_or_equal: { op: "lessThanOrEqual" },
  in_list: { op: "in" },
};

export interface RuleBasedSegmentInput {
  rbs: SplitRuleBasedSegment;
  segmentKey: string;
  ctx: MappingContext;
  /**
   * Returns the member keys of another segment (for inlining excludedSegments
   * snapshots), or null when unavailable.
   */
  resolveSegmentKeys?: (segmentName: string) => string[] | null;
  extraTags?: string[];
}

/**
 * Rule-based Split segment → LD segment with rules. LD segment rules may NOT
 * contain segmentMatch clauses, so excludedSegments are inlined as key
 * snapshots when possible and flagged MANUAL otherwise.
 */
export function mapRuleBasedSegment(
  input: RuleBasedSegmentInput,
): { segment: LDSegmentPayload; notes: Note[] } {
  const { rbs, segmentKey, ctx } = input;
  const notes: Note[] = [];
  const item = rbs.name;
  const trafficTypeName = rbs.trafficType?.name ?? USER_CONTEXT_KIND;
  const contextKind = ctx.kindByTrafficType.get(trafficTypeName) ?? USER_CONTEXT_KIND;

  const rules: Array<{ clauses: LDClause[] }> = [];
  for (const [i, rule] of (rbs.rules ?? []).entries()) {
    const matchers: SplitRbsMatcher[] = rule.condition?.matchers ??
      (rule.attribute !== undefined || rule.operator !== undefined ? [rule] : []);
    const clauses: LDClause[] = [];
    let failed = false;

    for (const m of matchers) {
      if (typeof m.type === "string") {
        // Flag-matcher dialect: reuse the flag matcher table, but reject
        // segmentMatch results (not allowed inside LD segment rules).
        const mapped = mapMatcherToGroups(m as SplitMatcher, contextKind, ctx, item);
        if ("error" in mapped) {
          notes.push(note(mapped.level, "segment", item, `Rule #${i + 1} skipped: ${mapped.error}`, rule));
          failed = true;
          break;
        }
        if (mapped.groups.length > 1) {
          notes.push(note(
            "MANUAL",
            "segment",
            item,
            `Rule #${i + 1} skipped: negated multi-clause matcher needs OR expansion, ` +
              `which LD segment rules cannot express`,
            rule,
          ));
          failed = true;
          break;
        }
        if (mapped.groups[0].some((c) => c.op === "segmentMatch")) {
          notes.push(note(
            "MANUAL",
            "segment",
            item,
            `Rule #${i + 1} skipped: LD segment rules cannot reference other segments (segmentMatch)`,
            rule,
          ));
          failed = true;
          break;
        }
        notes.push(...mapped.notes);
        clauses.push(...mapped.groups[0]);
        continue;
      }

      const operator = typeof m.operator === "string" ? m.operator.toLowerCase() : "";
      const mapping = RBS_OPERATOR_MAP[operator];
      if (!mapping) {
        notes.push(note(
          "MANUAL",
          "segment",
          item,
          `Rule #${i + 1} skipped: unmapped rule-based segment operator "${m.operator}"`,
          rule,
        ));
        failed = true;
        break;
      }
      const values = Array.isArray(m.value) ? m.value : [m.value];
      clauses.push(clause(m.attribute ?? "key", mapping.op, values, contextKind, mapping.negate ?? false));
    }

    if (!failed && clauses.length > 0) rules.push({ clauses });
  }

  const segment: LDSegmentPayload = {
    key: segmentKey,
    name: rbs.name,
    description: rbs.description ?? "",
    ...(input.extraTags?.length && { tags: input.extraTags.map(sanitizeTag) }),
    ...(rules.length > 0 && { rules }),
  };

  // Excluded keys map directly.
  const excludedKeys = [...(rbs.excludedKeys ?? [])];

  // excludedSegments: LD segment rules can't reference segments — snapshot keys.
  for (const excluded of rbs.excludedSegments ?? []) {
    const snapshot = input.resolveSegmentKeys?.(excluded.name) ?? null;
    if (snapshot) {
      excludedKeys.push(...snapshot.filter((k) => !excludedKeys.includes(k)));
      notes.push(note(
        "PARTIAL",
        "segment",
        item,
        `excludedSegments "${excluded.name}" inlined as a point-in-time snapshot of ` +
          `${snapshot.length} key(s); future changes to that segment will NOT flow through`,
      ));
    } else {
      notes.push(note(
        "MANUAL",
        "segment",
        item,
        `excludedSegments "${excluded.name}" could not be inlined (member keys unavailable); ` +
          `recreate the exclusion manually in LD`,
        excluded,
      ));
    }
  }

  if (excludedKeys.length > 0) {
    if (contextKind === USER_CONTEXT_KIND) {
      segment.excluded = excludedKeys;
    } else {
      segment.excludedContexts = [{ contextKind, values: excludedKeys }];
    }
  }

  return { segment, notes };
}

// ---- Large segments ----

export interface LargeSegmentInput {
  name: string;
  segmentKey: string;
  trafficTypeName?: string;
  description?: string | null;
  ctx: MappingContext;
  extraTags?: string[];
}

/**
 * Split large segment → LD big (unbounded) segment. The Split public Admin
 * API cannot export large segment members, so membership is always MANUAL.
 */
export function mapLargeSegment(
  input: LargeSegmentInput,
): { segment: LDSegmentPayload; notes: Note[] } {
  const contextKind = input.ctx.kindByTrafficType.get(input.trafficTypeName ?? USER_CONTEXT_KIND) ??
    USER_CONTEXT_KIND;
  const notes: Note[] = [
    note(
      "MANUAL",
      "segment",
      input.name,
      `Large segment created as an LD big segment, but the Split Admin API has no endpoint to ` +
        `export large segment members — re-import membership from your source-of-truth CSV ` +
        `(LD big segment CSV import: no header row, ≤1M rows / 40MB per file)`,
    ),
  ];
  return {
    segment: {
      key: input.segmentKey,
      name: input.name,
      description: input.description ?? "",
      ...(input.extraTags?.length && { tags: input.extraTags.map(sanitizeTag) }),
      unbounded: true,
      unboundedContextKind: contextKind,
    },
    notes,
  };
}
