# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `migration.migrateViews` (`--migrate-views=false`, extraction `--extract-views=false`): opt out of recreating views and linking flags and segments to them; `targetView` still applies (#20)
- `scripts/verify-segments.ts --source-domain / --dest-domain / --env-map`: verify a cross-instance (US → EU) or environment-mapped migration; only mapped source environments are checked (#20)

### Changed

- The sync manifest is now cumulative: a `migrate` run keeps the entries of flags and segments outside its scope (include/exclude filters, `--since`, unselected environments, `migrateSegments: false`) or skipped by `--on-conflict skip` instead of dropping them, so it stays a complete inventory of migrated resources for revert and view linking. `migrate` loads the previous manifest before any destination write (project and environment creation included) and stops when it is unreadable or records another project pair; carried-forward entries are in place before view linking, so resources skipped this run link under their recorded destination keys. A run stopped by `--on-conflict abort` still writes the manifest, marked `incomplete`; revert refuses such a manifest until a run without flag-scope filters completes cleanly (no failed writes) and every destination resource the marker lists as untracked (found as a skipped or prefix-renamed conflict on a key without an entry) is mapped by an entry again, e.g. after overwriting it (#21)
- `migration.adoptUnresolved` (`--adopt-unresolved`): records the destination resources an incomplete sync manifest lists as untracked as this migration's copies (`extraDestKeys`), so the marker can clear and revert removes them; reruns always update the copy recorded in the manifest, so this is the explicit way to reconcile an untracked original (#21)
- Reconciliation checks the destination keys recorded in the sync manifest (flags and segments), so a prefixed copy updated by a rerun is no longer reported as missing under its source key (#21)
- Reruns with `conflictPrefix` update the destination copy recorded in the sync manifest (e.g. `imported-foo`) instead of creating another prefixed duplicate that would replace the first one in the manifest; a flag whose extracted data cannot be loaded is now counted as an error (#21)
- Sync manifest types and path moved to `src/utils/sync_manifest.ts`, shared by `migrate` and `revert`; `readSyncManifest` rejects a manifest whose recorded project pair differs from the requested one
- Workflow merge check (`destination.projectKeyMapping` merges): only resources the migrate step writes are compared (`includeFlags` / `excludeFlags`, `migrateSegments`, `environments`, `environmentMapping`; segments by destination environment), and the outcome follows the effective `onConflict` policy. `prefix` warns, and stops when a key is shared with two or more earlier sources or the prefixed key already exists (one prefix can only rename once); `skip` warns; `overwrite`, `prompt` and `abort` stop (#21)
- Same-account guard: also stops when a destination key is another listed source's key (chained mappings such as `a -> b`, `b -> c`), not only a project's own key (#21)
- `createEnvironments` also copies `requireComments` and `critical` from the source environment (#21)
- `migration.tags` are now reconciled on flags and segments that an `--incremental` run skips as unchanged (the tags are not part of the source version), with one destination read per skipped resource when tags are set (#22)
- The incremental fast path patches a flag under its manifest destination key, so a flag renamed by a conflict prefix is updated instead of its unprefixed namesake
- A dry run looks up each segment in the destination and previews conflict handling and the tag patch for segments that already exist, instead of reporting every segment as created (#22)
- A failed tag reconciliation on an existing segment (read or patch), and a failed lifecycle/tags reconciliation on a flag the incremental fast path skips, are now counted as errors (exit code `1`), like a failed flag-level update

### Fixed

- `revert_migration.ts`: the flag list for a source now comes from the sync manifest `migrate` wrote for that source and destination, so flags created with a conflict prefix are reverted under their destination key instead of matching another source's flag. Without a manifest, keys that a sibling source merged into the same destination also lists are left in place with a warning rather than guessed. The keep-the-view check for merged destinations uses the same keys (#21)
- `revert_migration.ts`: an unreadable sync manifest, or one that records another project pair, stops the revert instead of falling back to raw source keys. Without a manifest for the reverted source, raw-key deletion is only allowed when every sibling source merged into the same destination has a manifest (an extracted list does not name destination keys); otherwise the revert stops, and shared views are kept (#21)
- In approval-required environments, the `remove offVariation` patch (source serves the SDK fallback while off) is now listed under the approval's skipped fields instead of being dropped silently; semantic patches have no instruction for it (#20)
- `views.ts`: paging no longer stops after the first page when the beta views endpoints omit `totalCount` (#20)

### Documentation

- README: how existing destination tags are handled with and without `migration.tags`, and that a flag whose create returns 409 is updated in place like one found by the pre-check (#22)

## [3.3.0] - 2026-10-15

### Added

- **Migration tags** (`migration.tags` / `--tags`): merge configured tags into migrated flags and segments (#16)
- **Big segment members and views** for LD→LD migrations (`--extract-big-segments` / `migrateBigSegments`, views read from the views API and recreated/linked), a missing-prerequisite check for include/exclude filters, and `scripts/verify-segments.ts` (#18)
- **Multi-project workflows**, `migration.createProject` / `migration.createEnvironments`, and a same-account guard (#19)
- `source_from_ld.ts --include-archived` (`extraction.includeArchived`): also list archived flags, which the flags API omits by default
- `diff_payload.ts --base-url-a / --base-url-b` (or `LD_BASE_URL_A/B`, or `baseUrlA/baseUrlB` in the keys file): compare SDK payloads served by two different instances, e.g. US vs EU
- `migrate` reconciliation: after the run, flag keys and per-environment segment keys in the source data (minus flags `--since` skipped) are checked against the destination; missing resources, and a reconciliation that could not be completed, are reported as errors

### Changed

- `migrate` now exits with code `1` when any flag or segment failed to create/update or is missing from the destination. Failed creates are recorded (with the API response) and listed in the summary, segment failures get their own summary section, and the status line reports errors before pending approvals. A failed flag gets no sync-manifest entry, so the next `--incremental` run retries it.
- `rateLimitRequest` retries 5xx responses and network errors up to three times with exponential backoff for idempotent requests (GET/HEAD/OPTIONS/PUT/DELETE) and applies a 60 s per-request timeout; POST/PATCH are never replayed (the server may have committed the first attempt), they surface as errors and are repaired by an incremental re-run. 429 handling is unchanged. A thrown error in one flag no longer aborts the whole concurrent batch.
- The prerequisite check runs only with `includeFlags` / `excludeFlags`, as documented (an archived prerequisite no longer blocks a full-project run)
- `deno task test` runs with read/write permissions (the workflow config tests use temp directories)
- Page size for the flag list during extraction raised from 5 to 50

### Fixed

- `revert_migration.ts`: `archiveFlag` sends a semantic-patch body matching the content type it uses (#19)
- `createEnvironments` with many-to-one environment mappings no longer POSTs duplicates; the first-listed source environment supplies the settings
- Project-key mapping lookups use `Object.hasOwn`

## [3.2.0] - 2026-07-14

### Added

- **Split (Harness FME) → LaunchDarkly migration** (`source_from_split.ts`, `deno task source-from-split`, workflow step `split-extract`)
  - Extracts a Split workspace via the Split Admin API and writes the standard source-data directory, so the existing `migrate` step performs all LaunchDarkly writes
  - Migrates per-environment targeting rules (full 24-matcher translation table), percentage rollouts, individual targets, per-treatment dynamic configurations (as JSON variations), traffic types (as context kinds), standard/rule-based/large segments, flag sets (as `flagset.<name>` tags), and `IN_SPLIT` dependencies (as prerequisites where expressible)
  - Emits `split-fidelity-report.json` classifying every mapping decision as FULL/PARTIAL/MANUAL/SKIPPED; complete mapping spec in `docs/SPLIT-MAPPING.md`
  - Split API key via `SPLIT_API_KEY` env var or `split_api_key` in `config/api_keys.json`
- **Context kinds**: migrate creates context kinds from `contextKinds.json` (PUT `projects/{proj}/context-kinds/{key}`) before segments and flags
- **Big segments**: unbounded segments are now created instead of skipped; members provided by a source adapter (`_importKeys`) are loaded via the segment CSV import endpoint (chunked, replace-then-merge, status polling)
- **Prerequisites**: flags migrate in topological dependency levels so prerequisite flags exist before dependents; cycles are detected and reported
- **`--on-conflict prompt|skip|overwrite|prefix|abort`** (`migration.onConflict`): interactive per-conflict prompting with apply-to-all answers; defaults preserve existing behavior (prefix when `-c` is set, else overwrite)
- `deno task test` runs the unit test suite

## [3.1.0] - 2026-04-29

### Added

- **Include / exclude flags**: Migrate only specific flags or skip others
  - `migration.includeFlags` (YAML array or `--include-flags` comma-separated): only these flag keys are migrated
  - `migration.excludeFlags` (YAML array or `--exclude-flags` comma-separated): these flag keys are skipped
  - Supported in workflow YAMLs and in the migrate task (CLI and config file)
- **Parallel flag migration**: Migrate up to N flags at a time (default 10)
  - `migration.concurrency` in workflow YAML or `--concurrency N` for the migrate task
  - Speeds up migration by processing multiple flags concurrently; rate limiting still applies

### Fixed

- **Flag keys that differ only by case now migrate as separate flags**
  Extract now writes each flag's data to an index-prefixed file (`flags/0-my-flag.json`, `flags/1-other-flag.json`, ...) instead of using just the flag key as the filename. On case-insensitive filesystems (e.g. macOS default), keys like `Flag-one` and `flag-one` no longer overwrite the same file, while remaining human-browsable. Migrate tries the index-prefixed path first and falls back to pure index, SHA-based, and plain key paths, so existing extractions continue to work.

## [3.0.2] - 2025-12-09

### Fixed
- **Segment Pagination**: Fixed segment extraction being limited to 50 segments per environment
  - Previously relied on `_links.next` which wasn't consistently returned by the API
  - Now uses `totalCount` from API response to properly paginate through all segments
  - Improved progress logging to show actual fetched range (e.g., "Fetched segments 1 to 50 of 500")

### Changed
- **Smart Rate Limiting**: Enhanced rate limit handling using HTTP response headers
  - Reads `x-ratelimit-global-remaining`, `x-ratelimit-route-remaining`, and `x-ratelimit-reset` headers
  - Proactive throttling when remaining requests fall below threshold (avoids hitting 429s)
  - Intelligent delay calculation that spreads requests across the reset window
  - Proper backoff on 429 responses using `retry-after` or `x-ratelimit-reset` headers
  - Per-route rate limit tracking for more accurate throttling
  - Added jitter to prevent thundering herd issues

## [3.0.1] - 2025-01-14

### Changed
- **License**: Migrated from MIT License to Apache 2.0 License for LaunchDarkly Labs compliance
- **README**: Updated license badge and added LaunchDarkly Labs disclaimer
- **Repository**: Added comprehensive topics including migrations, migration-tools, and LaunchDarkly Labs tags

## [3.0.0] - 2025-10-13

### Added
- **Workflow Orchestrator**: Complete end-to-end migration automation from a single YAML config file
  - Runs full workflow (extract → map → migrate) by default when no steps specified
  - Selective step execution for custom workflows
  - Support for extract-only, migrate-only, and third-party import workflows
  - Revert workflow to undo migrations
- **Views Support**: Automatic extraction, creation, and linking of LaunchDarkly Views (Early Access feature)
  - Discovers and preserves view associations from source flags
  - Creates missing views in the destination project
  - Optional target view linkage for all migrated flags
- **YAML Configuration File Support**: Full YAML-based configuration for migrate task
  - Alternative to CLI arguments for better maintainability
  - Version control friendly
  - CLI arguments override config file values
  - Multiple example configs for different scenarios
- **Conflict Resolution**: Automatic handling of resource key conflicts
  - Configurable prefix for conflicting resources
  - Automatic retry with prefix on HTTP 409 conflicts
  - Detailed conflict resolution reporting
  - Applies to flags, segments, and other resources
- **Environment Mapping**: Map source environment keys to different destination keys
  - Support for projects with different naming conventions (e.g., prod → production)
  - Validation of mapped environments before migration
  - Works with both flags and segments
- **Environment Filtering**: Selective migration of specific environments
  - Comma-separated list of environments to migrate
  - Useful for testing and staged migrations
- **Multi-Region and Custom Instance Support**: Configure LaunchDarkly domains for different instances
  - US instance (app.launchdarkly.com) - default
  - EU instance (app.eu.launchdarkly.com)
  - Custom/on-premise instances
  - Domain configuration via CLI flags or YAML config
- **Revert Migration Capability**: Undo previously executed migrations
  - Delete migrated flags and segments
  - Optional view cleanup after unlinking
  - Dry-run mode for previewing changes
  - Selective revert of specific resources
- **Idempotent Migration Operations**: Safe re-running of migrations
  - Skips existing resources instead of failing
  - Creates approval requests when environments require them
  - Handles beta API endpoints gracefully
- **Approval Request Support**: Automatic creation of approval requests for protected environments
  - Detects environments that don't allow direct patching
  - Creates approval requests with proper variation IDs
  - Prevents duplicate approval requests

### Changed
- **Major refactoring** of migration script for improved maintainability and modularity
- Enhanced logging throughout workflow and migration processes
- Improved error handling and user feedback
- Better handling of beta API endpoints
- Segments are now only extracted when explicitly needed (via `extraction.includeSegments` or `migration.migrateSegments`)

### Fixed
- Dry-run mode now correctly validates without making changes
- Fixed handling of environments with approval requirements

## [2.1.0] - 2025-08-29

### Added
- Flag import from external sources (JSON/CSV) for thirt-party migrations

### Changed
- Script renaming for clarity (`source` → `source_from_ld`, etc.)
- Project reorganization into logical folders
- Enhanced environment pagination support

## [2.0.0] - 2025-08-05

### Added
- Core migration functionality between LaunchDarkly instances
- Member mapping between accounts
- Migration time estimation
- Project structure and documentation

### Features
- Source project data extraction
- Flag, segment, and environment migration
- Maintainer mapping and assignment
- Rate limiting and API compliance

## [1.0.0] - Forgotten date

### Added
- Initial version of this project
