# Split (Harness FME) → LaunchDarkly Migration

`source_from_split.ts` reads a Split workspace via the Split Admin API and
writes the same source-data directory that `source-from-ld` produces, so the
standard `migrate` step performs all LaunchDarkly writes. The extract is
read-only against Split: it never calls the LaunchDarkly API and only writes
local files.

## Step-by-step runbook

### 1. Prerequisites

- **Deno ≥ 2** installed.
- **Split Admin API key** — set the `SPLIT_API_KEY` environment variable
  (preferred), or add `split_api_key` to `config/api_keys.json`. See
  `config/api_keys.json.example`.
- **LaunchDarkly destination API key** — set `destination_account_api_key`
  in `config/api_keys.json`, with write access to the destination project.
- **Destination LaunchDarkly project must already exist** — the migrate
  script does not create projects and exits if the project is missing.
- **Destination environments must already exist** — source environments
  with no matching destination environment are skipped (with a warning).
  Use `--env-map` during extract or migrate to map Split environment names
  onto your existing LD environment keys.

### 2. Extract the Split workspace

```bash
export SPLIT_API_KEY=...

deno task source-from-split -w "My Workspace" -p split-workspace \
  -e "Prod-Default,Staging" \
  --env-map "Prod-Default:production,Staging:test"
```

⚠️ **Do not put `--` between the task name and the flags.** On modern Deno
(verified on 2.4.5), `deno task` forwards a literal `--` to the script and
argument parsing breaks. Write `deno task source-from-split -w ...`, not
`deno task source-from-split -- -w ...`.

Flags:

| Flag | Description |
|------|-------------|
| `-w, --workspace` | **Required.** Split workspace (project) ID or name |
| `-p, --projKey` | **Required.** Source project key to write under `data/launchdarkly-migrations/source/project/` |
| `-e, --environments` | Comma-separated Split environment names to extract (default: all, production-flagged environments first) |
| `--env-map` | Split env → LD env key mapping, e.g. `'Prod-Default:production,Staging:test'` (unmapped envs get a sanitized lowercase key) |
| `-t, --tag` | Only extract Split flags/segments with this tag — **see warning below** |
| `--split-base-url` | Split API host (default: `https://api.split.io`) |
| `--ld-tag` | Tag applied to everything imported (default: `imported-from-split`) |

⚠️ **The `-t` tag filter also filters segments — and segments cannot be
tagged in Split.** Using `-t` therefore silently drops **all** segments from
the extract. If you need to scope the migration, prefer a dedicated Split
workspace and no `-t`.

### 3. Review the fidelity report

The extract writes `split-fidelity-report.json` alongside the source data:

```bash
cat data/launchdarkly-migrations/source/project/split-workspace/split-fidelity-report.json
```

Every mapping decision is recorded as **FULL** (exact), **PARTIAL**
(migrated with a semantic difference), **MANUAL** (requires human
follow-up; includes the exact Split JSON fragment that could not be
translated), or **SKIPPED**. Resolve or acknowledge every MANUAL note
before migrating.

### 4. Migrate (dry-run first)

```bash
# Preview — no writes to LaunchDarkly
deno task migrate -p split-workspace -d my-ld-project -s --dry-run

# Real run
deno task migrate -p split-workspace -d my-ld-project -s --on-conflict prompt
```

(Same rule as above: no `--` after the task name.)

Segments are included by default (`-s` defaults to `true`; pass `-s false`
to skip them). Other relevant `migrate` flags:

| Flag | Description |
|------|-------------|
| `-p, --projKeySource` | Source project key (the `-p` you used during extract) |
| `-d, --projKeyDest` | Destination LaunchDarkly project key (must exist) |
| `--on-conflict` | What to do when a flag/segment key already exists: `prompt` (interactive), `skip`, `overwrite` (default), `prefix` (requires `-c`), `abort` |
| `-c, --conflictPrefix` | Prefix to use when resolving key conflicts (e.g. `imported-`) |
| `--dry-run` | Preview migration without making any changes |
| `-e, --environments` | Comma-separated list of environment keys to migrate |
| `--env-map` | Environment mapping `'source1:dest1,source2:dest2'` — mapped destination environments must exist |
| `-m, --assignMaintainerIds` | Assign maintainers (default: `false`) |
| `-v, --targetView` | View key to link all migrated flags to |
| `--include-flags` / `--exclude-flags` | Comma-separated flag keys to include/exclude |
| `--concurrency` | Max flags migrated in parallel (default: 10) |
| `--domain` | Destination LaunchDarkly domain (default: `app.launchdarkly.com`) |
| `-f, --config` | Path to YAML config file; CLI arguments override config values |

### 5. Optional: run both steps as a workflow

```bash
SPLIT_API_KEY=... deno task workflow -f examples/workflow-split.yaml
```

The `split-extract` workflow step runs the extract, then the `migrate` step
performs the writes — see `examples/workflow-split.yaml` for the config
shape (again, no `--` after the task name).

## What's migrated

This migrates far more than the product Split import integration (which
only imports flag names, variations, default rules, and tags):

- Per-environment targeting rules (full matcher translation), percentage
  rollouts, and individual targets
- Standard, rule-based, and large segments (large segments are created empty
  — Split's API cannot export their members)
- Traffic types as context kinds
- Flag dependencies (`IN_SPLIT`) as prerequisites where expressible
- Per-treatment dynamic configurations as JSON variations
- Flag sets as `flagset.<name>` tags

See [docs/SPLIT-MAPPING.md](../../../docs/SPLIT-MAPPING.md) for the
complete mapping specification.

## Known limitations

- **No export API in Split** for experiments, metric definitions, or large
  segment membership — these are not migrated. Re-import large segment
  members from your source of truth.
- **`trafficAllocation < 100` is inexpressible in LaunchDarkly** — such
  flags are migrated at 100% allocation with a PARTIAL note.
- **Percentage rollouts re-bucket at cutover** — Split and LaunchDarkly
  hash differently, so users may switch treatments at identical
  percentages. Plan cutover accordingly.
- **Date matchers**: Split's docs say epoch milliseconds but real payloads
  are often seconds; the mapper normalizes values below 10^11 by ×1000.
- **`IN_SPLIT` → prerequisite** only for the strict shape (a single
  `IN_SPLIT` matcher targeting a specific treatment); anything else becomes
  a MANUAL note.

### Smoke-test coverage caveats

End-to-end testing was performed against a Split **trial-tier org**. A trial
org's plan limits and API behavior prevent the seed harness from creating
many of the higher-value objects, so the corresponding migration paths are
**exercised by unit tests only, not against live Split data**. Treat the list
below as untested end-to-end until you re-run against a paid/Enterprise org.

The authoritative per-run record of what was and wasn't exercised is the
seed harness's `check-report` output (its "Relaxed (probe not accepted)"
section). What a trial org could not seed in practice:

**Paywall-gated (Split returns `402 Forbidden by Paywalls`):**

- **Large segments → LaunchDarkly big segments** — large segments are
  Enterprise-gated (`largeSegments`), so big-segment creation and the CSV
  member-import path (`_importKeys`) is untested against real data.
- **Standard segments above 15,000 members → big-segment upgrade** — trial
  caps membership at 10,000 keys (`segmentKeys limit=10000`), so the automatic
  upgrade of oversized standard segments to unbounded LD segments is untested.
- **Multivariate flags with >2 treatments** (`splitTreatments limit=2`) — the
  3+ variation mapping path is not exercised.
- **`trafficAllocation` < 100** — the PARTIAL "migrated at 100%" path is not
  exercised.
- **Flag sets** (`402` on `/internal/api/v3/flag-sets`) — the
  `flagset.<name>` tagging path is not exercised.
- **Reserved-word traffic type `kind`** (`trafficTypes limit=2`) — the
  reserved-word context-kind PARTIAL path is not exercised.

**Rejected by the trial API (`400`), so also untested end-to-end:**

- **`IN_SPLIT` → prerequisite** — the in-split dependency matcher could not be
  seeded, so the prerequisite translation (and topological ordering at migrate
  time) is unexercised against real data.
- **semver and set matchers** — `EQUAL_SET`, `PART_OF_SET`, and
  semver-between/greater/less matchers could not be seeded.
- **Rule-based-segment operator dialect** — one RBS operator shape was
  rejected.

Note that a `400` (as opposed to a `402`) may indicate the seed harness is
sending a request shape the current Split API no longer accepts, rather than a
plan limit — see the seed harness's `check-report`, which now flags `400`s
distinctly from paywalls.

Validate **all** of the above against a paid/Enterprise Split org before
relying on them for a production migration.

## API quirks encountered in the field

Verified live behaviors you may hit against the Split Admin API:

- **Env-scoped segment list can return a raw 500** ("Error listing segments
  for environment"). The extractor automatically falls back to probing
  every workspace segment's keys endpoint (a 404 there means the segment is
  not active in that environment) and logs progress as it goes.
- **Rule-based-segments-in-environment returns a bare JSON array** instead
  of the documented `objects`/`offset`/`limit`/`totalCount` envelope — the
  client handles both shapes.
- **Intermittent 5xx responses** are retried automatically (with backoff)
  before surfacing an error.
- **Requests time out after 60s** — hangs were observed against Split;
  timeouts are retried like 5xx errors, then surfaced.
- **Free-tier paywalls**: accounts behind a paywall can get 402 "Forbidden
  by Paywalls" on features their plan doesn't include — observed gating
  traffic types, treatments, `trafficAllocation`, and large segments.

## Differences from LD Split Import Integration

LaunchDarkly's product Split flag-import integration is deliberately
minimal: its client hits exactly two endpoints — list splits in a workspace
and list flag definitions in **one** environment (via Split's *internal*
API, `api.split.io/internal/api/v2/...`) — and captures only flag
name/description/tags, treatment names, per-treatment individually-targeted
keys, and the default rule/default treatment. This tool uses the public
Admin API and extracts the entire workspace:

| Capability | Product integration | This tool |
|------|------|------|
| Flag names, descriptions, tags | ✅ | ✅ |
| Variations | String treatment names only | Typed boolean/JSON/string variations, incl. per-treatment dynamic configurations |
| Default rule / default treatment | ✅ | ✅ (off + fallthrough) |
| Individual targets | Per-treatment `keys` | ✅ |
| Per-environment targeting rules | ❌ | Full 24-matcher translation, De Morgan OR-expansion of negations, percentage rollouts |
| Environments per run | One | Any subset (`-e`), with `--env-map` renaming and production-first tie-breaking |
| Segments | ❌ | Standard (with member keys), rule-based, and large (metadata only) |
| Traffic types → context kinds | ❌ | ✅ (`contextKinds.json`) |
| Flag dependencies | ❌ | `IN_SPLIT` → prerequisites (strict shape), topologically ordered at migrate time |
| Flag sets | ❌ | `flagset.<name>` tags |
| Key sanitization | Assumes names are valid LD keys | Deterministic `KeyRegistry` sanitization with collision handling |
| Fidelity accounting | None | FULL/PARTIAL/MANUAL/SKIPPED ledger + `split-fidelity-report.json` |
| API resilience | Basic pagination | 429/5xx retry with backoff, 60s timeouts, envelope-shape quirks, env-segment-list 500 fallback |
| Experiment configurations | ❌ *Split API cannot export* | ❌ *Split API cannot export* |
| Metric definitions | ❌ *Split API cannot export* | ❌ *Split API cannot export* |
| Experiment results | ❌ *Split API cannot export* | ❌ *Split API cannot export* |
| Large segment members | ❌ *Split API cannot export* | ❌ *Split API cannot export* — segment created empty (metadata only) |
| Historical events | ❌ *Split events API is write-only* | ❌ *Split events API is write-only* |

The last five rows are hard limits of the Split public Admin API — **no**
migration tooling can export them, regardless of implementation. Re-create
metrics and experiments in LaunchDarkly by hand, and re-import large
segment membership from your source of truth.

The architecture also differs: the product integration writes flags
directly into LaunchDarkly, while this tool is a **source adapter** — it
only writes the local source-data directory, and the standard `migrate`
script performs all LaunchDarkly writes (conflict handling, prerequisite
ordering, big-segment member import).
