/**
 * Split (Harness FME) Admin API types.
 *
 * Wire formats verified against the OpenAPI definitions embedded in
 * docs.split.io reference pages (each page has a `.md` variant), 2026-07-13:
 *   - feature-flag-definition, treatment, rule, condition-1, bucket, matcher
 *   - list-feature-flags, list-feature-flag-definitions-in-environment
 *   - list-segments, list-segments-in-environment, get-segment-keys-in-environment
 *   - listlargesegments, listlargesegmentsinenvironment
 *   - rule-based segment endpoints (updaterbsdefinition for the rules shape)
 *   - get-environments, get-traffic-types, get-workspaces, list-flag-sets
 */

/** Common {id, name} reference used for environments, traffic types, etc. */
export interface SplitRef {
  id: string;
  name: string;
}

export interface SplitTag {
  name: string;
}

/** Paginated list envelope used by most Split Admin API list endpoints. */
export interface SplitPage<T> {
  objects: T[];
  offset: number;
  limit: number;
  totalCount: number;
}

/** Error body returned by the Split Admin API. */
export interface SplitApiErrorBody {
  code: number;
  message: string;
  transactionId?: string;
}

// ==================== Workspaces / Environments / Traffic Types ====================

/** GET /internal/api/v2/workspaces */
export interface SplitWorkspace {
  id: string;
  name: string;
  type?: string;
  organizationIdentifier?: string;
  projectIdentifier?: string;
  requiresTitleAndComments?: boolean;
}

/** GET /internal/api/v2/environments/ws/{workspace-id} — returns a plain array. */
export interface SplitEnvironment {
  id: string;
  name: string;
  production?: boolean;
}

/** GET /internal/api/v2/trafficTypes/ws/{workspace-id} — returns a plain array. */
export interface SplitTrafficType {
  id: string;
  name: string;
  displayAttributeId?: string;
}

// ==================== Feature Flags ====================

/** Flag metadata from GET /internal/api/v2/splits/ws/{workspace-id} */
export interface SplitFlag {
  id: string;
  name: string;
  description?: string;
  trafficType: SplitRef;
  creationTime?: number;
  tags?: SplitTag[] | null;
  rolloutStatus?: SplitRef;
  rolloutStatusTimestamp?: number;
  owners?: Array<{ id: string; type: string }>;
}

/**
 * A treatment (variation). `configurations` is a JSON string when dynamic
 * configuration is attached. `keys`/`segments` are individual-target lists.
 */
export interface SplitTreatment {
  name: string;
  description?: string;
  configurations?: string;
  keys?: string[];
  segments?: string[];
}

/**
 * A targeting matcher. Which value field is populated depends on `type`
 * (e.g. `strings` for IN_LIST_STRING, `date` for ON/BEFORE/AFTER, `between`
 * for BETWEEN, `depends` for IN_SPLIT).
 */
export interface SplitMatcher {
  type: string;
  negate?: boolean;
  attribute?: string | null;
  string?: string;
  bool?: boolean;
  strings?: string[];
  number?: number;
  date?: number;
  between?: { from: number; to: number };
  depends?: { splitName: string; treatment: string };
}

/** All matchers in a condition are AND'd; Split only supports the AND combiner. */
export interface SplitCondition {
  combiner?: string;
  matchers: SplitMatcher[];
}

/** A percentage bucket: serve `treatment` to `size` percent (integer 0-100). */
export interface SplitBucket {
  treatment: string;
  size: number;
}

export interface SplitRule {
  condition: SplitCondition;
  buckets: SplitBucket[];
}

/**
 * Per-environment flag definition from
 * GET /internal/api/v2/splits/ws/{ws}/environments/{env}
 */
export interface SplitFlagDefinition {
  name: string;
  environment?: SplitRef;
  trafficType?: SplitRef;
  killed?: boolean;
  treatments: SplitTreatment[];
  defaultTreatment: string;
  trafficAllocation?: number;
  rules?: SplitRule[];
  defaultRule?: SplitBucket[];
  baselineTreatment?: string;
  creationTime?: number;
  lastUpdateTime?: number;
  lastTrafficReceivedAt?: number;
  flagSets?: Array<{ id: string; name?: string }>;
}

// ==================== Segments ====================

/** Segment metadata from GET /internal/api/v2/segments/ws/{workspace-id} */
export interface SplitSegment {
  name: string;
  description?: string | null;
  trafficType?: SplitRef;
  creationTime?: number;
  tags?: SplitTag[] | null;
}

/** Segment-in-environment from GET /internal/api/v2/segments/ws/{ws}/environments/{env} */
export interface SplitSegmentInEnvironment {
  name: string;
  environment?: SplitRef;
  trafficType?: SplitRef;
  creationTime?: number;
}

/**
 * GET /internal/api/v2/segments/{environment-id}/{segment-name}/keys
 * NOTE: this endpoint's envelope differs from SplitPage — members live in
 * `keys` and the total is `count`.
 */
export interface SplitSegmentKeysPage {
  keys: Array<{ key: string }>;
  count: number;
  offset: number;
  limit: number;
}

/**
 * Large segment metadata (GET /internal/api/v2/large-segments/...).
 * The public Admin API exposes metadata only — there is no endpoint that
 * lists or exports large segment members.
 */
export interface SplitLargeSegment {
  name: string;
  description?: string | null;
  trafficType?: SplitRef;
  environment?: SplitRef;
  creationTime?: number;
  [key: string]: unknown;
}

// ==================== Rule-based Segments ====================

/**
 * Rule-based segment matcher. The RBS API uses an attribute/operator/value
 * dialect (verified via the Update Rule-based Segment Definition request
 * body), which differs from the flag SplitMatcher shape. Responses observed
 * in the wild sometimes use the flag-matcher shape instead, so all fields
 * are optional and consumers must handle both.
 */
export interface SplitRbsMatcher {
  attribute?: string;
  operator?: string;
  value?: unknown;
  // Flag-matcher dialect fallbacks:
  type?: string;
  negate?: boolean;
  string?: string;
  strings?: string[];
  number?: number;
  date?: number;
  between?: { from: number; to: number };
  [key: string]: unknown;
}

export interface SplitRbsRule {
  condition?: { combiner?: string; matchers?: SplitRbsMatcher[] };
  // Some responses may inline a single matcher at the rule level:
  attribute?: string;
  operator?: string;
  value?: unknown;
  [key: string]: unknown;
}

/**
 * Rule-based segment definition in an environment, from
 * GET /internal/api/v2/rule-based-segments/ws/{ws}/environments/{env}
 */
export interface SplitRuleBasedSegment {
  id?: string;
  name: string;
  description?: string | null;
  trafficType?: SplitRef;
  environment?: SplitRef;
  rules?: SplitRbsRule[];
  excludedKeys?: string[];
  excludedSegments?: Array<{ name: string; type: string }>;
  creationTime?: number;
  [key: string]: unknown;
}

// ==================== Flag Sets ====================

/** GET /internal/api/v3/flag-sets?workspace_id= (note: v3, not v2) */
export interface SplitFlagSet {
  id: string;
  name: string;
  description?: string;
  workspaceId?: string;
  [key: string]: unknown;
}

/** v3 flag-sets list envelope. */
export interface SplitFlagSetsPage {
  data?: SplitFlagSet[];
  objects?: SplitFlagSet[];
  totalCount?: number;
  [key: string]: unknown;
}
