# Split (Harness FME) → LaunchDarkly Mapping Reference

This document specifies how `source_from_split.ts` and
`src/utils/split/mapping.ts` translate Split objects into LaunchDarkly
objects, and exactly where fidelity is full, partial, or impossible.

Every transform emits a note at one of four levels, collected into
`split-fidelity-report.json` in the source-data directory:

| Level | Meaning |
|---|---|
| `FULL` | Semantics preserved exactly |
| `PARTIAL` | Migrated with a documented behavioral difference |
| `MANUAL` | Could not be migrated — the exact Split JSON fragment is included for a human to recreate |
| `SKIPPED` | Nothing to migrate (e.g. a flag never configured in any environment) |

## Split API surface used

Base: `https://api.split.io` with `Authorization: Bearer <Admin API key>`.
All shapes were verified against the OpenAPI definitions embedded in
docs.split.io reference pages.

| Data | Endpoint |
|---|---|
| Workspaces | `GET /internal/api/v2/workspaces` |
| Environments | `GET /internal/api/v2/environments/ws/{ws}` |
| Traffic types | `GET /internal/api/v2/trafficTypes/ws/{ws}` |
| Flags (metadata, tags) | `GET /internal/api/v2/splits/ws/{ws}` |
| Flag definitions (per env) | `GET /internal/api/v2/splits/ws/{ws}/environments/{env}` |
| Segments (metadata) | `GET /internal/api/v2/segments/ws/{ws}` |
| Segments in env | `GET /internal/api/v2/segments/ws/{ws}/environments/{env}` |
| Segment member keys | `GET /internal/api/v2/segments/{envId}/{name}/keys` |
| Rule-based segments | `GET /internal/api/v2/rule-based-segments/ws/{ws}/environments/{env}` |
| Large segments (metadata only) | `GET /internal/api/v2/large-segments/ws/{ws}/environments/{env}` |
| Flag sets | `GET /internal/api/v3/flag-sets?workspace_id={ws}` (note: v3) |

**Not available from the Split public Admin API** (and therefore not
migrated): experiment configurations, metric definitions, experiment
results, and **large segment membership**. The events ingestion API is
write-only.

## Keys, names, and tags

- LD keys allow `[A-Za-z0-9._-]`. Split names are sanitized to that charset;
  invalid characters become `-`. Flag keys preserve case (they are code
  identifiers); environment and context kind keys are lowercased.
- Sanitization collisions get `-2`, `-3`, … suffixes.
- The original Split name is kept as the LD `name`.
- LD tag names allow only letters, numbers, `.`, `_`, `-`. Split tags are
  sanitized accordingly. Flag sets become tags of the form
  `flagset.<sanitized-name>` (`:` is not allowed in LD tags).
- Everything imported also gets a configurable tag (default
  `imported-from-split`).

## Traffic types → context kinds

| Split | LaunchDarkly |
|---|---|
| `user` traffic type | Built-in `user` context kind |
| Any other traffic type | Custom context kind (`PUT /api/v2/projects/{proj}/context-kinds/{key}`), created by the migrate script from `contextKinds.json` |
| Traffic type named `kind` or `multi` | Suffixed `-context` (reserved words in LD) — PARTIAL |

The flag's traffic type determines the `contextKind` on every clause,
rollout, and individual target it produces.

## Treatments → variations

Decision, applied per flag across **all** extracted environments (Split
definitions are per-environment; LD variations are flag-global — treatments
are unioned by name):

1. Exactly two treatments named `on`/`off` and **zero** `configurations`
   anywhere → **boolean** flag (`on` → `true`).
2. Any treatment carries a `configurations` JSON string in any environment →
   **JSON variations** of `{"treatment": <name>, "config": <parsed|null>}`.
   This keeps variation values unique per treatment and lets migrated
   `getTreatmentWithConfig()` call sites read both halves. Call sites must
   be updated to read the `config` field.
3. Otherwise → **string variations** valued by treatment name (matches what
   `getTreatment()` returns).

If the same treatment has *different* configurations in different
environments, the priority environment's value wins (PARTIAL note). The
priority environment is the first one listed in `-e`/`environments`, or the
production-flagged environment when unspecified.

## Flag state

| Split | LaunchDarkly |
|---|---|
| `killed: true` | Flag toggled **off** |
| `defaultTreatment` | **Off variation** (served when the flag is off) |
| `defaultRule` buckets | **Fallthrough**: single 100% bucket → fixed variation; otherwise a percentage rollout (weight = size × 1000, LD weights are thousandths of a percent) |
| Bucket sizes not summing to 100 | Normalized onto the default treatment's bucket — PARTIAL |
| No definition in an environment | Environment omitted; flag falls back to LD flag defaults (off) |
| `trafficAllocation < 100` | **Inexpressible.** Split sends unallocated traffic to the default treatment *before* rules run; LD has no equivalent. Migrated as 100% allocation with a prominent PARTIAL note — more users will match rules than in Split. Alternative: leave targeting off and reconstruct manually. |
| `baselineTreatment`, rollout status | Not migrated (experimentation metadata) |

**Re-bucketing warning (applies to every percentage rollout):** Split and
LaunchDarkly hash differently, so at cutover users are re-bucketed. Even at
identical percentages, individual users may switch treatments.

## Individual targeting

- `treatments[].keys` → LD individual targets (`targets` for the user kind,
  `contextTargets` for custom kinds). A key listed under two treatments is
  kept on the first (LD allows one variation per key) — PARTIAL.
- `treatments[].segments` → prepended rules `segmentMatch(<segment>)` →
  serve that treatment (Split evaluates whitelists before rules, and LD
  rules are ordered, so prepending preserves precedence).

## Targeting rules

Split conditions AND their matchers; LD rules AND their clauses; both
evaluate rules top-down first-match-wins — structurally isomorphic. Rule
buckets become a fixed variation (single 100% bucket) or a per-rule rollout.

### Matcher table

`attr` = the matcher's attribute, or the context **key** when unset.
All clauses carry the flag's context kind.

| Split matcher | LD clause(s) | Fidelity |
|---|---|---|
| `ALL_KEYS` | `kind in [<contextKind>]` (all-contexts idiom) | FULL |
| `IN_LIST_STRING` | `attr in [strings]` | FULL |
| `STARTS_WITH_STRING` | `attr startsWith [strings]` | FULL |
| `ENDS_WITH_STRING` | `attr endsWith [strings]` | FULL |
| `CONTAINS_STRING` | `attr contains [strings]` | FULL |
| `MATCHES_STRING` | `attr matches [regex]` | PARTIAL — regex dialects differ (Java vs SDK-native); verify patterns |
| `BOOLEAN` | `attr in [bool]` | FULL |
| `EQUAL_NUMBER` | `attr in [number]` | FULL |
| `LESS_THAN_OR_EQUAL_NUMBER` | `attr lessThanOrEqual [n]` | FULL |
| `GREATER_THAN_OR_EQUAL_NUMBER` | `attr greaterThanOrEqual [n]` | FULL |
| `BETWEEN_NUMBER` | two clauses: `≥ from` AND `≤ to` | FULL |
| `ANY_OF_SET` | `attr in [strings]` (LD array-attribute semantics: any element matches) | FULL |
| `ALL_OF_SET` | N AND'd clauses `attr in [s]`, one per element | FULL |
| `EQUAL_SET` | — | **MANUAL** — set equality has no LD operator |
| `PART_OF_SET` | — | **MANUAL** — subset-of has no LD operator |
| `ON_DATE` | `[UTC day start, next day)` window via two `before` clauses | PARTIAL — timezone semantics |
| `ON_OR_AFTER_DATE` | `NOT before <minute>` (negated clause) | FULL at minute granularity |
| `ON_OR_BEFORE_DATE` | `before <minute + 1min>` | FULL at minute granularity |
| `BETWEEN_DATE` | the two clauses above AND'd | FULL at minute granularity |
| `EQUAL_TO_SEMVER` | `semVerEqual [v]` | FULL |
| `GREATER_THAN_OR_EQUAL_TO_SEMVER` | `semVerLessThan [v]` + `negate: true` (LD-documented idiom) | FULL |
| `LESS_THAN_OR_EQUAL_TO_SEMVER` | `semVerGreaterThan [v]` + `negate: true` | FULL |
| `BETWEEN_SEMVER` | the two above AND'd | FULL |
| `IN_LIST_SEMVER` | `semVerEqual [list]` | FULL |
| `IN_SEGMENT` | `segmentMatch [<segment key>]` | FULL (flag rules only — LD segment rules may not contain `segmentMatch`) |
| `IN_SPLIT` | Prerequisite (strict shape only, below) | Conditional |

Split epoch values are documented as milliseconds but appear as seconds in
docs examples; values `< 10^11` are normalized ×1000.

### Negation

Split `negate` on a single-clause matcher flips the LD clause's `negate`.
A negated **multi-clause** matcher (BETWEEN, ALL_OF_SET, ON_DATE) requires
OR logic, which an LD rule cannot express — the rule is expanded into
adjacent LD rules serving the same outcome (De Morgan), labeled
`(OR expansion i/N)`. Expansions are capped at 8 rules; beyond that the
rule is MANUAL.

### IN_SPLIT → prerequisites

An LD clause cannot reference another flag, but LD **prerequisites** cover
the common gating shape. `IN_SPLIT` maps to a prerequisite only when *all*
hold:

- it is the sole matcher of the flag's sole rule,
- not negated, no attribute override,
- the default rule serves 100% default treatment,
- the dependency flag is part of the same migration.

Then: prerequisite = `{key: <dep flag>, variation: <required treatment>}`,
fallthrough = the rule's buckets, off variation = default treatment. The
migrate script orders flags topologically so prerequisites exist before
dependents. Any other `IN_SPLIT` usage is MANUAL.

## Segments

| Split type | LaunchDarkly | Notes |
|---|---|---|
| Standard segment | Segment with individual targets (`included` / `includedContexts` per kind) | FULL. Over 15,000 keys (LD's standard-segment cap): auto-upgraded to a big segment, members loaded via the CSV import endpoint — PARTIAL |
| Rule-based segment | Segment with rules | Both observed matcher dialects handled (`attribute/operator/value` and flag-style matchers). `excludedKeys` → excluded targets. `excludedSegments` → inlined as a point-in-time key snapshot when the referenced segment's members are available (PARTIAL — future changes don't flow), else MANUAL, because LD segment rules cannot contain `segmentMatch`. |
| Large segment | Big (unbounded) segment, created empty | **MANUAL** — the Split public Admin API cannot export large segment members. Re-import from your source-of-truth CSV (LD import: no header row, ≤1M rows / 40MB per file). |

Segments are per-environment in both systems; each extracted environment
gets its own `segments/{env}.json`.

## Not migrated (report-only)

- **Experiments, metrics, experiment results** — no Split export API exists.
- **Large segment membership** — no export API.
- **`trafficAllocation < 100`** — inexpressible (see Flag state).
- **`baselineTreatment` / rollout statuses** — experimentation metadata.
- API keys, SDK keys, webhooks, integrations, and Split user/group
  permissions.

## Known caveats to verify per engagement

- Split date matcher values: the ms-vs-seconds normalization heuristic
  assumes no legitimate epoch values before ~1973 (`< 10^11` ms).
- `MATCHES_STRING` regex dialect differences.
- LD `before`/`after` boundary strictness at exact minute boundaries (±1
  minute worst case, given Split's minute truncation).
- Rule-based segment matcher wire format: the RBS docs example shows
  `attribute/operator/value`; if a workspace returns flag-style matchers,
  those are handled too, but unrecognized operators surface as MANUAL.
- Duplicate keys across treatment whitelists: LD rejects one key targeting
  two variations; the mapper dedupes first-wins.
