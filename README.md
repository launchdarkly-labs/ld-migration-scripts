# LaunchDarkly Migration Scripts

[![Version](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/launchdarkly-labs/ld-migration-scripts/main/deno.json&query=$.version&label=version&color=blue)](https://github.com/launchdarkly-labs/ld-migration-scripts)
[![Deno](https://img.shields.io/badge/deno-v2.x-blue.svg)](https://deno.land/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Set of scripts intended for migrating LaunchDarkly projects between different accounts, regions, or instances. The supported resources include: environments, flags, segments, and maintainer mappings.

## Overview

These scripts helps you migrate your LaunchDarkly projects across different scenarios:

- **Account Mergers**: Consolidating projects from multiple accounts into a single account
- **Project Splitting**: Breaking up large projects into smaller, more manageable ones
- **Region Migrations**: Moving projects between US-hosted (app.launchdarkly.com) and EU-hosted (app.eu.launchdarkly.com) accounts
- **Instance Migrations**: Moving projects between different LaunchDarkly instances
- **Environment Consolidation**: Merging environments across projects
- **Resource Reorganization**: Restructuring flags and segments across projects

Features that are currently supported:

- Project & environment configuration and settings
- Feature flags and their configurations
- Segments and targeting rules
- Maintainer mapping across different account instances
- **Views support**: Views are recreated with their name, description, tags and maintainer, and their linked flags and segments are re-linked
- **Conflict resolution**: Automatic handling of resource key conflicts with configurable prefixes
- **Include/exclude flags**: Migrate only specific flags or exclude certain flags from migration
- **Parallel flag migration**: Migrate multiple flags concurrently for faster migrations
- **Case-sensitive flag storage**: Flags that differ only by case are stored separately (index-prefixed filenames)
- **Split (Harness FME) migration**: Full-fidelity import of a Split workspace — targeting rules, segments (standard/rule-based/large), individual targets, traffic types as context kinds, flag dependencies as prerequisites — with a fidelity report (see [docs/SPLIT-MAPPING.md](docs/SPLIT-MAPPING.md))
- **Context kinds**: Created in the destination from `contextKinds.json` when a source adapter provides them
- **Big segments**: Created (not skipped) and members loaded via CSV import when the source data includes them. For LaunchDarkly sources, `migrateBigSegments: true` exports the members as CSV during extraction
- **Prerequisites**: Flags migrate in dependency order so prerequisite links land correctly. With `includeFlags`/`excludeFlags`, a real run stops before writing if a selected flag's prerequisite would be missing
- **Interactive conflict handling**: `--on-conflict prompt|skip|overwrite|prefix|abort`
- **Verification**: `scripts/verify-segments.ts` compares segments and views between source and destination after a migration

## Project Structure

```
root/
├── src/                  # Source code
│   ├── scripts/          # Scripts organized by purpose
│   │   ├── launchdarkly-migrations/    # LD-to-LD migration scripts
│   │   └── third-party-migrations/     # External-to-LD import scripts
│   ├── utils/            # Utility functions
│   └── types/            # TypeScript type definitions
├── config/               # Configuration files
├── examples/             # Template and example files
│   ├── flags_template.json   # JSON flag import template
│   └── flags_template.csv    # CSV flag import template
├── data/                 # Data directory organized by purpose
│   ├── launchdarkly-migrations/        # LD migration data
│   │   ├── source/       # Downloaded source project data
│   │   └── mappings/     # Mapping files (e.g., maintainer IDs)
│   └── third-party-migrations/         # External import data
│       ├── import-files/ # Template and import files
│       └── reports/      # Import operation reports
```

## Multi-Region and Custom Instance Support

All scripts support configurable LaunchDarkly domains to work with different instances and regions:

- **US Instance** (default): `app.launchdarkly.com`
- **EU Instance**: `app.eu.launchdarkly.com`
- **Custom instances**: Any custom LaunchDarkly domain

### How to Configure Domains

**Via YAML configuration files** (recommended):

```yaml
source:
  projectKey: my-project
  domain: app.launchdarkly.com # Default if not specified

destination:
  projectKey: eu-project
  domain: app.eu.launchdarkly.com # EU instance
```

**Via CLI flags**:

```bash
# Source extraction with custom domain
deno task source-from-ld -p my-project --domain app.launchdarkly.com

# Migration with different domains
deno task migrate -p us-project -d eu-project --domain app.eu.launchdarkly.com

# Map members between different instances
deno task map-members --source-domain app.launchdarkly.com --dest-domain app.eu.launchdarkly.com
```

**Use cases**:

- Migrating from US to EU instance
- Moving between different LaunchDarkly environments (production vs. sandbox)
- Working with custom or on-premise LaunchDarkly instances

## Prerequisites

- [Deno](https://deno.land/) **2.0.0 or higher** installed (CI uses the version in `.deno-version`)
  - If you use Homebrew: `brew install deno`
- LaunchDarkly API key with appropriate permissions
  - Source account API key with at least Reader access
  - Destination account API key with at least Writer access
- Access to both source and destination LaunchDarkly instances

## Configuration

1. Create a configuration file for your API keys:
   ```bash
   # Copy the example config file
   cp config/api_keys.json.example config/api_keys.json

   # Edit the file with your API keys
   # config/api_keys.json
   {
     "source_account_api_key": "your_source_api_key_here",
     "destination_account_api_key": "your_destination_api_key_here"
   }
   ```

   Note: The `config/api_keys.json` file is ignored by git to prevent accidental
   exposure of API keys.

## Quick Start

### Option 1: Workflow Orchestrator (Recommended)

Run the complete migration workflow from a single YAML config file:

```bash
# Run full workflow (extract → map → migrate) - the default
deno task workflow -f examples/workflow-full.yaml

# Or pass the YAML as a positional argument (no -f needed)
deno task workflow examples/workflow-full.yaml

# Shortcut tasks for common workflows
deno task workflow:full          # runs examples/workflow-full.yaml
deno task workflow:incremental   # runs examples/workflow-extract-migrate-incremental.yaml

# Or create your own config
cat > my-migration.yaml <<EOF
source:
  projectKey: my-source-project
destination:
  projectKey: my-dest-project
migration:
  assignMaintainerIds: true
  conflictPrefix: "imported-"
  targetView: "migration-2024"
EOF

deno task workflow -f my-migration.yaml
```

**Default behavior**: If you don't specify `workflow.steps`, it runs the **full workflow**:

1. Extract source project data
2. Map members between instances
3. Migrate to destination

### Option 2: Individual Steps

Or run migration steps individually:

1. **Download Source Project Data**

   Download source project data to `data/launchdarkly-migrations/source/project/SOURCE_PROJECT_KEY/`.

   ```bash
   # Using workflow config (extract only)
   deno task workflow -f examples/workflow-extract-only.yaml

   # Or using individual task
   deno task source-from-ld -p SOURCE_PROJECT_KEY
   ```

2. **Create Member ID Mapping**

   Automatically create a mapping between source and destination member IDs based on email
   addresses.

   ```bash
   # Using workflow (if part of your steps)
   # Included in default workflow

   # Or using individual task
   deno task map-members
   ```

   This will:
   - Fetch all members from both source and destination account instances
   - Match members based on their email addresses
   - Create a mapping file at `data/mappings/maintainer_mapping.json`
   - Show a summary of mapped and unmapped members

3. **(Optional) Estimate Migration Time**

   Before running the migration, you can estimate how long it will take:

   ```bash
   deno task estimate-migration-time -p SOURCE_PROJECT_KEY
   ```

4. **Migrate Project to the Destination account**

   ```bash
   # Using workflow (recommended)
   deno task workflow -f my-migration.yaml

   # Using individual migrate task with config
   deno task migrate -f examples/migration-config.yaml

   # Using CLI arguments
   deno task migrate -p SOURCE_PROJECT_KEY -d DESTINATION_PROJECT_KEY -m
   ```

For more information about using Deno tasks, see
[Using Deno Tasks](#using-deno-tasks) below.

## Workflow Orchestrator

The workflow orchestrator allows you to run complete end-to-end migrations from a single YAML config file. It supports:

- ✅ **Full workflow automation** - Extract → Map → Migrate in one command
- ✅ **Multi-project migrations** - Migrate many projects via `source.projectKeys` (same key on destination, or custom/merged keys via `destination.projectKeyMapping`)
- ✅ **Selective step execution** - Run only the steps you need
- ✅ **Third-party imports** - Import flags from external sources
- ✅ **Default behavior** - Runs full workflow if no steps specified

### Full Workflow (Default)

```yaml
# workflow-full.yaml
# No workflow.steps specified = runs ALL steps by default

source:
  projectKey: us-production

destination:
  projectKey: eu-production

migration:
  assignMaintainerIds: true
  conflictPrefix: "us-"
  targetView: "us-migration-2024"
  environments:
    - production
    - staging
  environmentMapping:
    production: production
    staging: staging
```

```bash
deno task workflow -f workflow-full.yaml
```

**This automatically runs:**

1. `extract-source` - Downloads all project data
2. `map-members` - Creates member ID mappings
3. `migrate` - Runs the migration

### Extract Source Data Only

```yaml
# workflow-extract-only.yaml
workflow:
  steps:
    - extract-source

source:
  projectKey: my-project
```

```bash
deno task workflow -f workflow-extract-only.yaml
```

### Migrate Only (Pre-extracted Data)

```yaml
# workflow-migrate-only.yaml
workflow:
  steps:
    - migrate

source:
  projectKey: my-source-project

destination:
  projectKey: my-dest-project

migration:
  assignMaintainerIds: false # No map-members step
  conflictPrefix: "imported-"
  targetView: "migration-2024"
```

```bash
deno task workflow -f workflow-migrate-only.yaml
```

### Multi-Project Workflow

Use `source.projectKeys` to migrate an explicit list of projects. Each source key is migrated to a destination project with the **same key** (typical account/region moves where project keys are preserved).

Account-level steps (`map-members`, `third-party-import`) run **once**, first. Project-level steps (`extract-source`, `migrate`, `revert`) then run **once per project**, in the order the steps are listed, for each key in list order. Duplicate keys are skipped.

With a single `source.projectKey`, steps run exactly in the order listed.

```yaml
workflow:
  steps:
    - map-members
    - extract-source
    - migrate

source:
  projectKeys:
    - payroll
    - benefits
  domain: app.launchdarkly.com

destination:
  domain: app.launchdarkly.us

migration:
  assignMaintainerIds: true
```

When `projectKeys` is set, `destination.projectKey` and `destination.projectName` are ignored (projects created with `migration.createProject` use each source project's name, unless `destination.projectNames` sets one). Use `source.projectKey` and `destination.projectKey` instead when migrating a single project to a different key. Project keys are trimmed, and numeric YAML values (e.g. `projectKey: 123`) are treated as strings.

#### Custom destination keys and merging projects

Add `destination.projectKeyMapping` (source key -> destination key) to send some projects to a different key. Keys not listed keep the same key. Several sources can map to the same destination, which merges them into one project:

```yaml
source:
  projectKeys:
    - ld-mfe-examples # -> ld-mfe-examples
    - njordan-cd-example # -> new-project
    - njordan-ld-migration-scripts-source # -> new-project
  domain: ld-stg.launchdarkly.com

destination:
  domain: app.launchdarkly.com
  projectKeyMapping:
    njordan-cd-example: new-project
    njordan-ld-migration-scripts-source: new-project
  projectNames: # Optional: destination key -> name, used only when createProject creates it
    new-project: "New Project"

migration:
  createProject: true
  createEnvironments: true
```

- Every mapping key must appear in `source.projectKeys`; a typo stops the workflow before any step runs. The mapping is ignored (with a warning) when only `source.projectKey` is set.
- The first source migrated into a merged destination creates it; later sources add their flags and segments to the existing project.
- **Merge check:** before each later source migrates into a merged destination, the workflow compares the flag keys and the segment keys (per destination environment) it is about to migrate with those of the earlier sources for that destination. Only resources that are actually migrated count: `includeFlags` / `excludeFlags`, `migrateSegments: false`, `environments` and `environmentMapping` are applied first. If any key overlaps, what happens depends on the effective conflict policy (`migration.onConflict`, which defaults to `prefix` when `conflictPrefix` is set and to `overwrite` otherwise):
  - `prefix`: the workflow replays the earlier sources' writes to know which keys they hold in the destination, including the prefixed copies of their own collisions, and warns that the overlapping keys will be created with the prefix. It stops instead when the prefix cannot resolve a key: when the prefixed key is taken as well, because two or more earlier sources already share the key (the second one took the prefixed key), or a source has the prefixed key itself. One prefix can only rename a key once. A segment present in two source environments that map to the same destination environment is written twice (the second time with the prefix) and is counted that way, in the order the environments are listed in the source project. The replay starts from an empty destination: keys that already exist in the destination project before the merge (an existing project, or an earlier run) are not known offline, so collisions with them are left to the migrate step's own 409 handling and are not reported here.
  - `skip`: the workflow warns; the later source's copies are not migrated and the earlier source's targeting is kept.
  - `overwrite`, `prompt` or `abort`: the workflow stops and lists the keys, because the later source would overwrite the earlier one's targeting (or, with `abort`, the migrate step would stop part-way).

  The check reads extracted data, so `extract-source` must have run for every merged source.
- `conflictPrefix` applies to any key that already exists in the destination and is not recorded in the [sync manifest](#sync-manifest). A rerun updates the copies recorded by the first run (`foo` migrated as `imported-foo` is updated as `imported-foo`), so prefixed duplicates only appear when there is no manifest for the pair (for example after a dry run only, or after deleting it).
- Environments are matched by key across all sources (`migration.environmentMapping` applies to every project).

#### Same-account guard

When the source and destination domains are the same, the workflow checks both API tokens with `GET /api/v2/caller-identity` before migrating. If they belong to the same account and any project would migrate onto a key that is also a source key, its own (for example `projectKeys` without a mapping) or another listed source's (`a: b` while `b` is itself a source), the workflow stops, since that would write into the source projects. Map those projects to new keys or use a destination token for another account. If the lookup fails (for example the token lacks access), the workflow warns and continues. Different domains skip the check.

### Third-Party Flag Import

```yaml
# workflow-third-party.yaml
workflow:
  steps:
    - third-party-import

thirdPartyImport:
  inputFile: data/third-party-migrations/import-files/my-flags.json
  targetProject: my-project
  dryRun: false
```

```bash
deno task workflow -f workflow-third-party.yaml
```

### Split (Harness FME) Migration

Migrates a Split workspace — flags with full targeting, segments, context
kinds, and prerequisites — into an existing LaunchDarkly project. Requires a
Split Admin API key (`SPLIT_API_KEY` env var or `split_api_key` in
`config/api_keys.json`).

```yaml
# workflow-split.yaml
workflow:
  steps:
    - split-extract
    - migrate

source:
  projectKey: split-workspace # local label for the extracted data

destination:
  projectKey: my-ld-project

splitExtract:
  workspace: Default # Split workspace ID or name
  environmentMapping:
    Prod-Default: production
    Staging: test

migration:
  dryRun: true # review, then flip to false
  onConflict: prompt
```

```bash
SPLIT_API_KEY=... deno task workflow -f examples/workflow-split.yaml
```

The extract step writes `split-fidelity-report.json` alongside the source
data, listing every mapping decision as FULL/PARTIAL/MANUAL/SKIPPED — review
it before the real run. For the full step-by-step runbook, CLI flags, known
limitations, and API quirks, see
[src/scripts/third-party-migrations/split-readme.md](src/scripts/third-party-migrations/split-readme.md);
mapping semantics are documented in
[docs/SPLIT-MAPPING.md](docs/SPLIT-MAPPING.md).

### Custom Step Combinations

```yaml
# workflow-custom.yaml
workflow:
  steps:
    - extract-source
    - migrate # Skip map-members

source:
  projectKey: source-project

destination:
  projectKey: dest-project

migration:
  assignMaintainerIds: false # Must be false when skipping map-members
  environmentMapping:
    prod: production
    dev: development
```

### Workflow Configuration Structure

```yaml
workflow: # Optional - defaults to full workflow
  steps: # Run in order; with projectKeys, account steps run once first, then project steps per key
    - extract-source # Download source project data (per project)
    - map-members # Map member IDs (account-level)
    - migrate # Run migration (per project)
    - third-party-import # Or import from external sources (account-level)

source: # Required: projectKey OR projectKeys
  projectKey: string # Single source project
  projectKeys: string[] # Multiple projects (same key on destination each, unless mapped)
  domain: string # Optional: Defaults to app.launchdarkly.com

destination: # Required for migrate step (per-project key set automatically when using projectKeys)
  projectKey: string # Destination project key (single-project mode)
  projectName: string # Optional: Name used only when migration.createProject creates the project
  projectKeyMapping: # Optional, projectKeys only: source key -> destination key (several may share one)
    sourceKey: destKey
  projectNames: # Optional, projectKeys only: destination key -> name used when the project is created
    destKey: "Display Name"
  domain: string # Optional: Defaults to app.launchdarkly.com

extraction: # Optional - controls what data to extract
  includeSegments: boolean # Set to true to extract segments (default: false)

memberMapping: # Optional - for map-members step
  outputFile: string # Where to save mapping file

migration: # Optional - for migrate step
  assignMaintainerIds: boolean
  migrateSegments: boolean
  tags: string[] | null # Optional tags added to migrated flags and segments
  migrateBigSegments: boolean # Copy big segment members via CSV export/import (default: false)
  migrateViews: boolean # Recreate views and link flags/segments to them (default: true)
  adoptUnresolved: boolean # Record resources an incomplete sync manifest lists as untracked as this migration's copies
  conflictPrefix: string
  targetView: string
  environments: string[]
  environmentMapping:
    sourceEnv: destEnv
  dryRun: boolean # Preview changes without applying (no destination writes, no sync manifest)
  includeFlags: string[] # Only migrate these flag keys (prerequisites must be included too)
  excludeFlags: string[] # Skip these flag keys
  concurrency: number # Parallel flag migrations (default: 10)
  createProject: boolean # Create the destination project if missing, with the migrated environments
  createEnvironments: boolean # Create destination environments that are missing, from source settings

thirdPartyImport: # Required for third-party-import step
  inputFile: string # JSON or CSV file path
  targetProject: string # Target LD project
  dryRun: boolean # Validation only
  reportOutput: string # Optional report path

revert: # Optional - for revert step
  dryRun: boolean # Preview revert without applying
  deleteViews: boolean # Whether to delete views after unlinking
  viewKeys: string[] # Specific views to process
```

### Available Steps

- **`extract-source`** - Downloads all data from source project
- **`split-extract`** - Extracts a Split (Harness FME) workspace via the Split Admin API into the same source-data format
- **`map-members`** - Creates member ID mappings between instances
- **`migrate`** - Migrates project to destination
- **`third-party-import`** - Imports flags from external JSON/CSV files
- **`revert`** - Reverts a previously executed migration

### Extracted Data Structure

When you run `extract-source`, data is organized as follows:

```
data/launchdarkly-migrations/source/project/{projectKey}/
├── project.json           # Project metadata and environments
├── flags.json            # List of all flag keys (ordered)
├── flags/                # Individual flag data (index-prefixed filenames)
│   ├── 0-my-flag.json    # First flag's data
│   ├── 1-other-flag.json # Second flag's data
│   └── ...
├── views.json            # Views with their linked flags and segments
└── segments/             # Segment data (only if includeSegments: true)
    ├── environment-1.json
    ├── environment-2.json
    ├── ...
    └── big/              # Big segment member CSVs (only if migrateBigSegments: true)
        └── environment-1/segment-key.csv
```

**Note:** Flag data files use index-prefixed filenames (`0-flag-key.json`, `1-flag-key.json`, ...) to avoid case collisions on case-insensitive filesystems (e.g. macOS) while remaining human-browsable. The migrate script also supports older SHA-based and key-based filenames for backward compatibility.

**Note:** Segments are only extracted if:

- `extraction.includeSegments` is explicitly set to `true` OR
- `migration.migrateSegments` is set to `true`

By default, segments are **not** extracted unless explicitly needed, preventing unnecessary API calls and storage.

**Note:** If the project response does not include environments (some LaunchDarkly instances omit them from `?expand=environments`), extraction falls back to the paginated `projects/{projectKey}/environments` endpoint so `project.json` always contains the full environment list.

### Workflow Examples Included

- `examples/workflow-full.yaml` - Complete workflow (default behavior)
- `examples/workflow-extract-only.yaml` - Extract source data only
- `examples/workflow-migrate-only.yaml` - Migrate with pre-extracted data
- `examples/workflow-extract-migrate-incremental.yaml` - Re-extract and sync only changes after the first migration
- `examples/workflow-third-party.yaml` - Third-party flag import
- `examples/workflow-split.yaml` - Split (Harness FME) → LaunchDarkly migration
- `examples/workflow-custom-steps.yaml` - Custom step combinations

## Configuration File Support (Individual Migrate Task)

**Note:** This section covers config files for the **individual** `migrate` task. For complete workflow automation (recommended), see the [Workflow Orchestrator](#workflow-orchestrator) section above.

For running the migrate step separately with a config file, you can use YAML instead of CLI arguments. This makes migrations more maintainable and allows you to version control your migration configurations.

### Creating a Migration Config File

**Note:** For most users, use workflow configs instead (see [Workflow Orchestrator](#workflow-orchestrator) section).

Create a YAML file for the individual migrate task (e.g., `migration-config.yaml`):

```yaml
# For use with: deno task migrate -f migration-config.yaml
# This assumes you've already extracted source data

source:
  projectKey: my-source-project
  domain: app.launchdarkly.com # Optional: Defaults to app.launchdarkly.com

destination:
  projectKey: my-destination-project
  domain: app.launchdarkly.com # Optional: Use app.eu.launchdarkly.com for EU

# Migration settings
migration:
  assignMaintainerIds: true
  migrateSegments: true
  tags:
    - imported-from-legacy
    - billing-team
  conflictPrefix: "imported-"
  targetView: "migration-2024"
  environments:
    - production
    - staging
  environmentMapping:
    prod: production
    dev: development
    stg: staging
```

### Using Config Files

```bash
# Use config file for all settings
deno task migrate -f migration-config.yaml

# Config file with CLI overrides (CLI takes precedence)
deno task migrate -f config.yaml -c "different-prefix-"

# Combine config file with additional CLI flags
deno task migrate -f config.yaml -v "additional-view"
```

### Example Config Files

The `examples/` directory includes several config file templates:

- **`migration-config.yaml`** - Full example with all options documented
- **`migration-config-simple.yaml`** - Minimal configuration
- **`migration-config-advanced.yaml`** - Complex migration with all features
- **`migration-config-env-mapping.yaml`** - Focus on environment mapping

### Config File Benefits

✅ **Version control** - Store migration configs in git
✅ **Reproducible** - Run the same migration configuration multiple times
✅ **Maintainable** - Easier to manage complex migrations
✅ **Documented** - Self-documenting with YAML comments
✅ **Flexible** - CLI args can override config file values

### Migration Config File Structure

For use with `deno task migrate -f` (not workflow orchestrator). Migration settings may be placed under either `migration:` or `options:`; if both are present, `options:` wins.

```yaml
source:
  projectKey: string # Required: Source project key
  domain: string # Optional: Defaults to app.launchdarkly.com

destination:
  projectKey: string # Required: Destination project key
  projectName: string # Optional: Name for a project created by createProject
  domain: string # Optional: Defaults to app.launchdarkly.com

migration: # Migration settings (also accepts "options:" as alias)
  assignMaintainerIds: boolean # Default: false
  migrateSegments: boolean # Default: true
  migrateBigSegments: boolean # Default: false; needs CSVs from extraction
  conflictPrefix: string # Optional
  targetView: string # Optional
  includeFlags: string[] # Optional
  excludeFlags: string[] # Optional
  dryRun: boolean # Default: false
  environments: string[] # Optional, list format
  environmentMapping: # Optional, key-value mapping
    sourceEnv: destEnv
      ...
  includeFlags: string[] # Optional: only migrate these flag keys
  excludeFlags: string[] # Optional: skip these flag keys
  tags: string[] # Optional: tags added to flags and segments
  migrateViews: boolean # Optional: recreate views and their links (default: true)
  propagateArchived: boolean # Optional: archive destination copies of flags archived in the source since (default: true)
  concurrency: number # Optional: parallel flags (default: 10)
```

**Note:** Config files accept either `migration:` or `options:` as the key for migration settings.

`migration.tags` is optional (or `null`). When provided, its values are added to the source tags for migrated flags and segments, and duplicates are removed. Direct `migrate` CLI usage also accepts comma-separated tags, for example `--tags imported-from-legacy,billing-team`.

How existing destination resources are handled depends on whether `migration.tags` is set:

- **With `migration.tags`**: the tags of an existing destination flag or segment are merged with the source tags and the migration tags, so no tag already on the destination is lost.
- **Without `migration.tags`**: an existing flag or segment that is overwritten gets the source tags, replacing whatever tags it had in the destination.

An existing segment also gets the source name and description. Flags and segments an `incremental` run skips as unchanged are checked too, at the cost of one read per skipped resource: the migration tags are not part of the source version, and the segment version may already be recorded by a run that did not sync these fields.

A dry run looks up each segment in the destination and previews the tag patch for the ones that already exist.

### Priority Order

When using both config files and CLI arguments:

1. **CLI arguments** (highest priority)
2. **Config file values**
3. **Default values** (lowest priority)

Example:

```bash
# Config file has: conflictPrefix: "config-"
# CLI override:
deno task migrate -f config.yaml -c "cli-"
# Result: Uses "cli-" (CLI takes precedence)
```

## Advanced Features

### Views Support

Views are read from the source project's views API during extraction (flags don't report which views they belong to) and recreated in the destination:

- **View details**: Name, description, tags and maintainer are copied. Member maintainers are mapped with `assignMaintainerIds`; if the maintainer doesn't exist in the destination, the view is created without one.
- **Linked flags and segments**: After flags and segments are migrated, they are linked to the same views in the destination. This also covers flags and segments that already existed there. Links honor `includeFlags`/`excludeFlags`, environment mapping and conflict-prefix renames.
- **Target view**: `-v`/`targetView` additionally links every migrated flag to one view, created if needed.
- **Dry run**: Reports the views it would create and the links it would add, without creating anything.

```bash
# Migrate flags and recreate their views
deno task migrate -p SOURCE_PROJECT -d DEST_PROJECT

# Also link all migrated flags to a specific view
deno task migrate -p SOURCE_PROJECT -d DEST_PROJECT -v my-target-view
```

**Notes:**

- Views are an Enterprise feature in LaunchDarkly.
- The source token needs `viewView`. Without it the views list silently comes back empty and no views are migrated; extraction prints a warning when it finds none.
- The destination token needs `createView`, `updateView`, `linkFlagToView` and `linkSegmentToView`. See [docs/launchdarkly-migration-role.md](docs/launchdarkly-migration-role.md).
- If a view already exists in the destination, it is reused and its details are not changed.
- Opt out with `migration.migrateViews: false` (`--migrate-views=false`): the workflow then skips view extraction (`--extract-views=false`, which also removes an earlier `views.json`), and the migrate step neither recreates views nor links flags or segments to them. `targetView` still applies.

### Big Segments (Larger List-Based Segments)

Big segments are always created in the destination with the same key and context kind. Their members aren't returned by the segments API, so for LaunchDarkly sources they are only copied when you opt in with `migrateBigSegments: true`:

1. **Extract** (`--extract-big-segments`): Each big segment's members are exported to `data/.../segments/big/<env>/<segment>.csv`.
2. **Migrate** (`--migrate-big-segments`): The members are imported with the big segment CSV importer (`replace`, then `merge` for each further 1M-row chunk). This runs before flags, so flag rules that reference the segment work.

Without `migrateBigSegments`, big segments are created empty with a warning.

**Notes:**

- Needs `createSegmentExport` on the source and `createSegment`/`updateIncluded` on the destination.
- Synced segments (fed by an external integration) have no exportable members; they are created empty. Reconnect the integration in the destination.
- Big segments with exported members are re-imported on every run, including `incremental` runs.
- Server-side SDKs need a persistent store integration in each destination environment to evaluate big segments.

### Prerequisite Check

Flags are migrated in prerequisite order, so prerequisite links land correctly. In addition, when `includeFlags` or `excludeFlags` is used, the migrate step checks every selected flag's prerequisites in the migrated environments. A prerequisite that is neither selected nor already in the destination is reported with the flag that needs it:

- **Dry run**: Prints a warning and continues.
- **Real run**: Stops before writing anything, and lists the flag keys to add to `includeFlags`.

### Verifying a Migration

`scripts/verify-segments.ts` compares the source and destination after a migration:

```bash
deno run --allow-net --allow-read scripts/verify-segments.ts SOURCE_PROJECT DEST_PROJECT [keyPrefix] \
  [--source-domain app.launchdarkly.com] [--dest-domain app.eu.launchdarkly.com] \
  [--env-map prod:production,dev:development]
```

The projects may live on different instances (`--source-domain` / `--dest-domain`, both default to `app.launchdarkly.com`), and destination environment keys may differ (`--env-map`, same format as the migrate option). With `--env-map`, only the mapped source environments are checked, as in the migration.

- **Segments** (per environment): name, description, tags, included/excluded targets and rules, ignoring IDs, versions and dates.
- **Big segments**: every key from the extracted CSV is checked for membership in the destination.
- **Views**: name, description, tags, maintainer (by email) and linked flags and segments.
- **Percentage rollout rules** in segments are listed separately: the segment salt isn't exposed by the API, so bucketing can't be compared.

It exits non-zero if anything differs. The optional `keyPrefix` limits the check to segments and views whose keys start with it.

### Conflict Resolution

When migrating into an existing project, you may encounter resource key conflicts (e.g., a flag with the same key already exists). The conflict resolution feature handles this automatically:

- **Automatic retry**: First attempts to create without prefix, then retries with prefix on conflict (409)
- **Applies to all resources**: Flags, segments, and other resources
- **Detailed tracking**: Logs all conflict resolutions with a summary report
- **Preserves relationships**: Updates all references to use the prefixed keys

**Usage examples:**

```bash
# Migrate with conflict resolution using 'imported-' prefix
deno task migrate -p SOURCE_PROJECT -d DEST_PROJECT -c "imported-"

# Example output when conflicts are detected:
# ⚠ Flag "my-flag" already exists, retrying with prefix...
# Creating flag: imported-my-flag in Project: DEST_PROJECT
# Flag created

# At the end of migration, you'll see a report:
# ============================================================
# CONFLICT RESOLUTION REPORT
# ============================================================
# Total conflicts resolved: 3
#
# Conflicts by resource type:
#   - flag: 2
#   - segment: 1
#
# Conflict resolutions:
#   - flag: "my-flag" → "imported-my-flag"
#   - flag: "feature-x" → "imported-feature-x"
#   - segment: "users-segment" → "imported-users-segment"
# ============================================================
```

**Notes:**

- Only applies when a conflict (HTTP 409) is detected
- Resources recorded in the [sync manifest](#sync-manifest) from an earlier run are updated under their recorded key, whatever the conflict policy; the policy applies to resources the manifest does not know
- With `--on-conflict abort`, the run stops at the first existing key after writing the sync manifest marked incomplete (see [Sync Manifest](#sync-manifest))
- Without a prefix, a flag that already exists is updated in place: flag-level properties (name, description, tags, variations, lifecycle state, ...) that differ from the source are patched, then its environments. This is the case both when the pre-check finds the flag and when the create itself returns 409 (the flag appeared in between, or the pre-check failed)
- The prefix is applied to both the resource key and name
- All related patches and configurations use the prefixed key
- Use a descriptive prefix to easily identify migrated resources (e.g., `migrated-`, `v2-`, `imported-`)

### Environment Mapping

When migrating between projects with **different environment naming conventions**, you can map source environment keys to destination environment keys using the `--env-map` flag:

**Usage examples:**

```bash
# Map prod → production, dev → development
deno task migrate \
  -p source-project \
  -d dest-project \
  --env-map "prod:production,dev:development"

# Map multiple environments with different names
deno task migrate \
  -p legacy-project \
  -d new-project \
  --env-map "prod:production,stg:staging,qa:test"

# Combine with other features
deno task migrate \
  -p source-project \
  -d dest-project \
  --env-map "prod:production" \
  -c "migrated-" \
  -v "legacy-flags"
```

**Example output:**

```
=== Environment Mapping ===
Source → Destination:
  prod → production
  dev → development
  stg → staging
Migrating 3 mapped environment(s)

Reading flag 1 of 50 : my-feature
  Creating flag: my-feature in Project: dest-project
  Flag created
  Finished patching flag my-feature for env production
  Finished patching flag my-feature for env development
  Finished patching flag my-feature for env staging
```

**How it works:**

1. Reads flag configurations from **source** environments (e.g., `prod`, `dev`)
2. Creates/patches flags in **destination** environments (e.g., `production`, `development`)
3. Applies to both flags and segments automatically
4. Validates that destination environments exist before starting

**Notes:**

- Only mapped source environments will be migrated
- Several source environments may map to one destination environment. A segment key present in more than one of them is then written more than once into that environment: the later write replaces the earlier one, or with `onConflict: prefix` is created with the prefix
- Destination environments must already exist in the target project, unless `migration.createEnvironments: true` (`--create-environments`) is set, in which case missing mapped environments are created from the source settings
- If a mapped destination environment doesn't exist (and `createEnvironments` is off), migration will abort with error
- The [sync manifest](#sync-manifest) records each migrated segment's destination environment; a rerun whose mapping sends a source environment elsewhere stops before writing
- Environment keys are case-sensitive
- Can be combined with `-e` flag for additional filtering

**Error handling:**

```bash
# If destination environment doesn't exist:
Error: The following mapped destination environments don't exist in target project:
  prod → production (destination "production" not found)
Available destination environments: dev, staging, test
```

### Environment Filtering

By default, the migration script migrates **all environments** from the source project. You can selectively migrate only specific environments using the `-e` flag:

**Usage examples:**

```bash
# Migrate only production environment
deno task migrate -p SOURCE_PROJECT -d DEST_PROJECT -e "production"

# Migrate only non-production environments
deno task migrate -p SOURCE_PROJECT -d DEST_PROJECT -e "development,staging,test"

# Test migration with just one environment
deno task migrate -p SOURCE_PROJECT -d test-project -e "development" -c "test-"
```

**Example output:**

```
=== Environment Filtering ===
Requested environments: production, staging
Matched environments: production, staging
Migrating 2 of 5 environments

Segment migration is enabled
Getting Segments for environment: production
Getting Segments for environment: staging

Reading flag 1 of 50 : my-feature
  Creating flag: my-feature in Project: DEST_PROJECT
  Finished patching flag my-feature for env production
  Finished patching flag my-feature for env staging
```

**Notes:**

- Only the specified environments will be migrated for both flags and segments
- If an environment doesn't exist in the source, you'll see a warning
- If none of the requested environments exist, the migration will abort
- Environment keys must match exactly (case-sensitive)

### Include / Exclude Flags

Migrate only specific flags or exclude certain flags from migration:

**Via YAML config:**

```yaml
migration:
  # Only migrate these flags
  includeFlags:
    - feature-one
    - feature-two

  # Or exclude specific flags
  excludeFlags:
    - deprecated-flag
    - experimental-feature
```

**Via CLI:**

```bash
# Only migrate specific flags
deno task migrate -p SOURCE -d DEST --include-flags "feature-one,feature-two"

# Exclude specific flags
deno task migrate -p SOURCE -d DEST --exclude-flags "deprecated-flag,experimental-feature"
```

Omit both to migrate all extracted flags. If `includeFlags` is set, only those flags are migrated. `excludeFlags` is applied after `includeFlags`.

### Parallel Flag Migration

By default, up to 10 flags are migrated concurrently. Adjust with `--concurrency`:

```bash
# Migrate 20 flags in parallel
deno task migrate -p SOURCE -d DEST --concurrency 20

# Sequential migration (1 at a time)
deno task migrate -p SOURCE -d DEST --concurrency 1
```

**Via YAML config:**

```yaml
migration:
  concurrency: 20
```

Rate limiting still applies per-request, so higher concurrency speeds up migrations with many flags that have few environments.

### Combining Features

You can combine all features for powerful migration workflows:

```bash
# Full-featured migration with environment mapping
deno task migrate \
  -p legacy-project \
  -d modern-project \
  --env-map "prod:production,stg:staging" \
  -c "legacy-" \
  -v "legacy-migration" \
  -m

# This will:
# 1. Map legacy env names (prod → production, stg → staging)
# 2. Migrate flags/segments with environment mapping applied
# 3. Handle conflicts by prefixing with "legacy-"
# 4. Link all flags to "legacy-migration" view
# 5. Map maintainer IDs from source to destination

# Or combine environment filtering with mapping
deno task migrate \
  -p SOURCE_PROJECT \
  -d EXISTING_PROJECT \
  -e "prod,dev" \
  --env-map "prod:production,dev:development" \
  -c "v2-" \
  -v "migration-batch-1" \
  -m

# This will:
# 1. Only migrate prod and dev environments from source
# 2. Map them to production and development in destination
# 3. Handle any conflicts by prefixing with "v2-"
# 4. Link all flags to "migration-batch-1" view
# 5. Map maintainer IDs
```

## Sync Manifest

After every real run, `migrate` writes `data/launchdarkly-migrations/sync-manifest-<source>-<dest>.json`: the inventory of what the migration wrote, used by `--incremental`, by view linking and by `revert`.

- **What it records.** For every migrated flag and segment, the source version (so `--incremental` can skip unchanged resources) and the destination key when it differs from the source key (conflict prefix). Segments also record their destination environment. The file records the destination domain and account it was written for.
- **Cumulative.** A run rewrites the entries of the resources it attempted and keeps the others (`includeFlags` / `excludeFlags`, `--since`, unselected environments, `migrateSegments: false`). A resource whose write failed keeps its entry with its versions cleared, so the next `--incremental` run retries it.
- **Flags archived or deleted in the source.** The flags API omits archived flags unless `extraction.includeArchived` is set, so a flag archived in the source after it was migrated drops out of the extracted flag list. The extraction always records the source's archived keys (`archived-flags.json`), and every run checks the recorded flags that are no longer in the flag list: one archived in the source is archived in the destination too (`propagateArchived`, default true; with `--propagate-archived=false` the copies are left as they are and only listed); one that is neither live nor archived in the source was deleted there, and its destination copy is kept and listed in the summary whatever the option says (nothing is ever deleted). A flag `since` skipped is left alone, adopted copies included. `includeFlags` / `excludeFlags` scope this step as well. Flags that were archived before the first run and never migrated are not touched. A dry run previews the patches.
- **Reruns update recorded copies.** A flag or segment with an entry is updated under its recorded destination key, whatever `--on-conflict` says; `conflictPrefix` and the conflict policy apply only to resources the manifest does not know. A rerun with a prefix therefore does not create a second prefixed copy.
- **Trusted only for its destination.** `migrate` and `revert` refuse a manifest that records another project pair, destination domain or account; migrating the same projects to another destination needs its own working directory. A rerun whose `environmentMapping` sends a source environment elsewhere than recorded stops before writing. Manifests written by older versions carry neither identity nor segment environments: they are accepted with a warning and stamped by the next run, and their segment entries are looked up in the destination first (found ones are kept, missing ones dropped).
- **Incomplete marker.** A run stopped by `--on-conflict abort` or an unexpected error, or whose failed writes left resources with an unknown outcome (a create the API rejected outright is not one), writes the manifest marked `incomplete`, listing the destination keys that may exist untracked (segments with the destination environment they were written to, so a later run with another mapping cannot close the gap). `revert` refuses such a manifest. The marker clears when a run without `includeFlags`, `excludeFlags` or `--since` completes with no failed writes and every listed key is mapped by an entry again. While the marker is set, resources the aborted run created surface in later runs as conflicts on keys without an entry; a skip or prefix rename leaves them untracked, so they are added to the list (conflicts met by a run that is not recovering from an incomplete manifest are ordinary foreign resources and are never listed). Once you have verified they were created by the aborted run, run `migrate` once with `--adopt-unresolved` (`migration.adoptUnresolved: true`): they are recorded as further copies of the matching source resource, the marker clears, and `revert` removes them too.
- **Revert keeps it current.** `revert` removes the entries of the flags it deleted and of recorded flags the destination confirms are already gone (entries whose deletion failed keep their surviving copies; a flag that cannot be read stops the revert), so a later rerun treats a flag another source creates under the same key as a conflict.
- **Destination edits are never overwritten.** Each entry also records the state the run left the destination copy in (`dest`: version, lastModified and a fingerprint of the fields `migrate` writes, at flag level and per destination environment; for segments per copy). Before writing an existing copy, the next run compares it with that record. What was edited in the destination since is left as it is: an edited flag environment keeps its targeting; a flag with edited flag-level fields, or with any edited environment, keeps its name, description, tags, variations and lifecycle state; an edited segment is not patched; a recorded copy deleted in the destination is not recreated and not reported missing (and if someone recreates it there, it is left alone entirely). Environments outside the run's mapping, for example one already cut over and removed from `environmentMapping`, are checked too: an edit there keeps the shared flag-level fields, although the environment itself is not written either way. While the flag-level fields are protected and the source variations differ from the destination's, no environment's targeting is written (it refers to variations by index) and the flag is reported as a conflict. A recorded copy whose existence cannot be checked is not written, so a copy deleted in the destination is never recreated by a transient error. The entry is then marked `targetOwned` (per environment for flags, `"edited"` or `"deleted"` for segments), so later runs leave it alone even if the edit is undone. This applies to `--incremental` and full runs alike; the source is never written. The summary lists these copies under "Destination edits left as they are", separating conflicts (the source changed too, so the source change was not applied; resolve them in the destination) from copies whose source is unchanged, and the [run record](#run-records) lists them under `protected` and `conflicts`. Fingerprints ignore generated IDs and version bumps that change nothing `migrate` writes. An environment with an approval request from the migration is exempt while the request is open and re-baselined by the first run after it is applied or closed, so applying it does not count as an edit; an unrelated edit made in that environment while the request is open is taken as part of it. Prerequisites that point at a flag whose variations diverged that way are still copied with the source's variation indices, so the dependent flag can require a different variation until the conflict is resolved. Big segment membership is not part of the fingerprint (the API does not return it), so membership edits in the destination are not detected; only the segment's other fields are. Entries written before 3.6.0 have no `dest` record: for them a destination environment or segment counts as edited when it was modified after the last run on an older version ended (kept as `legacyEditCutoff` until every entry has a record), and flag-level edits are only detected once a run on 3.6.0 or later has recorded a fingerprint. Adopted copies (`extraDestKeys`) carry no record; one modified after the previous run ended is not archived when its source flag is. To hand a resource back to the migration, remove its `targetOwned` field (and `dest`) from the manifest.
- **Run times.** `lastSyncTimestamp` is when the writing run finished, `lastRunStartedAt` when it started.
- A dry run never writes the manifest.

## Run Records

Every `migrate` run that gets past its setup checks (dry runs and aborted runs included) writes a run record to `data/launchdarkly-migrations/runs/<startedAt>-<source>-<dest>.json` and a copy of the newest one to `runs/latest-<source>-<dest>.json`. Where the sync manifest is the cumulative inventory, a run record describes one run, for people and for tools such as the [project sync check](https://github.com/launchdarkly-labs/ld-project-sync-check):

- `schemaVersion` (currently 1), `startedAt`, `finishedAt`, `toolVersion`, `configFile`, `dryRun`, and `incomplete` with the reason when the run stopped early
- `mode`: `full`, `incremental`, `targeted` (`includeFlags` / `excludeFlags`), `since` or `dry-run`
- `source`, `destination` (project keys and destination domain), `envMap` (source to destination environment for the environments migrated) and `filters`
- `counts`: flags in scope, flags / environments / segments skipped as unchanged, flags archived because they were archived in the source, protected destination edits, conflicts, flag and segment errors, approval requests
- `protected` and `conflicts`: the destination edits left alone (see [Sync Manifest](#sync-manifest)), each `{kind, key, destKey, scope, env?, sourceChanged}` with `scope` one of `flag`, `environment`, `deleted`; `conflicts` is the subset where `sourceChanged` is true
- `errors` (flags with details, segments, reconciliation), `reconciliation` (expected and destination key counts, missing and extra keys; `null` on dry runs), `exitCode`, `manifestPath` and `manifestWritten`

## Reverting Migrations

If you need to undo a migration (e.g., after a failed or partial migration), you can use the revert functionality to clean up migrated resources.

### Revert Methods

**Via Workflow (Recommended):**

```bash
# Preview what will be reverted (dry-run)
deno task workflow -f examples/workflow-revert-and-migrate.yaml

# Execute the revert
# Edit the config to set dryRun: false, then run again
```

**Via Individual Revert Task:**

```bash
# Preview revert with config file
deno task revert -f examples/revert-migration-example.yaml --dry-run

# Execute revert
deno task revert -f examples/revert-migration-example.yaml

# Or use CLI arguments
deno task revert -p DEST_PROJECT -s SOURCE_PROJECT -v "migration-view" --dry-run
```

### What Gets Reverted

The revert process:

1. **Identifies migrated flags** - Uses the sync manifest written by `migrate` (destination keys, including conflict-prefixed ones), or the extracted source data when there is no manifest, to know exactly which flags were migrated (smart mode)
2. **Deletes approval requests** - Removes any pending approval requests for migrated flags
3. **Unlinks from views** - Removes flags from the target view
4. **Archives flags** - Archives migrated flags before deletion
5. **Deletes flags** - Permanently removes migrated flags from destination
6. **Cleans up segments** - Removes migrated segments (if they were migrated)
7. **Optionally deletes views** - Can remove the view itself (with `--delete-views` flag)

### Revert Configuration

**YAML Config Example:**

```yaml
source:
  projectKey: source-project

destination:
  projectKey: dest-project

migration:
  targetView: "migration-2024" # View to clean up

revert:
  dryRun: true # Preview first (recommended)
  deleteViews: false # Set to true to also delete views
  # viewKeys:                     # Optional: Only revert specific views
  #   - migration-view-1
```

The `revert:` block applies both in the workflow orchestrator and when running `deno task revert -f <config>` directly. Command-line flags override it: `--dry-run` / `--no-dry-run` override `revert.dryRun` (so `--no-dry-run` performs a real revert even when `revert.dryRun: true`), and `--delete-views` / `--no-delete-views` override `revert.deleteViews`. View keys are taken from `-v` first, then `revert.viewKeys`, then `migration.targetView`.

**Multiple projects:** When `source.projectKeys` is set, `deno task revert -f <config>` reverts every listed project in order, using its destination key (from `destination.projectKeyMapping`, else the same key). Pass `-p` (and optionally `-s`) to revert only one project; `-s` on its own is ignored when several projects are listed. In the workflow orchestrator, the `revert` step already runs once per project.

**Merged destinations:** Revert removes only the flags that came from each source, so other sources' flags in the same destination are untouched. The flag list comes from the source's [sync manifest](#sync-manifest), which names the destination key of every migrated flag, including conflict-prefixed ones. Without a manifest for the reverted source (for example after a dry run only), its extracted flag list is used, but only when every other source merged into the same destination has a manifest: an extracted list says nothing about destination keys, since a conflict prefix may have renamed them. Keys those sibling manifests hold are left in place with a warning, and the reverted source's own prefixed copies are not detected; if a sibling has no manifest, the revert stops rather than guess. `-p new-project` reverts every source mapped to `new-project`; add `-s njordan-cd-example` to revert just one. With `deleteViews`, a view in a merged destination is kept while flags from its other sources (per their manifests) still exist there, or while a sibling has no manifest to check against, and is deleted by the revert that removes the last of them. Flags you created by hand in that view are not detected.

### CLI Options

- `-p, --project`: Destination project key (where flags will be deleted)
- `-s, --source-project`: Source project key (identifies which flags to revert)
- `-d, --domain`: LaunchDarkly domain (default: app.launchdarkly.com)
- `-v, --views`: Comma-separated view keys containing migrated flags
- `--dry-run` / `--no-dry-run`: Preview the revert without making changes, or force a real revert (overrides `revert.dryRun`)
- `--delete-views`: Also delete the view after unlinking all flags (overrides `revert.deleteViews`)
- `--no-use-source-data`: Disable smart mode (scan all destination flags instead)
- `-f, --config`: Path to YAML configuration file

### Revert Workflow Examples

**Revert and Re-migrate Pattern:**

```yaml
# workflow-revert-and-migrate.yaml
workflow:
  steps:
    - revert # Clean up previous migration
    - migrate # Run migration again with corrected settings

source:
  projectKey: source-project

destination:
  projectKey: dest-project

revert:
  dryRun: true # Change to false after previewing

migration:
  assignMaintainerIds: true
  targetView: "migration-2024"
  dryRun: true # Change to false after previewing
```

**Best Practices:**

1. **Always use `--dry-run` first** to preview what will be deleted
2. **Use smart mode** (default) - leverages source data for faster, more accurate reverts
3. **Back up critical flags** if you're unsure about the revert scope
4. **Preview the re-migration** with dry-run before executing

### Example Revert Output

```
=== REVERT MIGRATION (DRY RUN) ===
Source project: source-project
Destination project: dest-project
Target view: migration-2024

Found 50 flags in source data
Checking which flags exist in destination...

Would revert the following resources:
  - flag: my-feature-1
  - flag: my-feature-2
  - flag: feature-x
  ... (47 more)

Would delete 3 pending approval requests
Would unlink 50 flags from view "migration-2024"
Would delete 50 flags
Would delete 5 segments

Set dryRun to false to execute the revert.
```

## Using Deno Tasks

The project includes predefined Deno tasks for easier execution. These tasks are
configured in `deno.json` and include all necessary permissions.

### Available Tasks

The task definitions live in `deno.json`; the ones above the line are the migration scripts, the ones below are for working on the repository (see [CONTRIBUTING.md](CONTRIBUTING.md)).

| Task                                | Purpose                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `deno task workflow`                | Run a migration workflow from a YAML file (`-f`); see Workflow Orchestrator                                      |
| `deno task workflow:full`           | `workflow -f examples/workflow-full.yaml`                                                                        |
| `deno task workflow:incremental`    | `workflow -f examples/workflow-extract-migrate-incremental.yaml`                                                 |
| `deno task source-from-ld`          | Extract flags, segments, environments (and optionally views, big segments, archived flags) from a source project |
| `deno task map-members`             | Map member IDs between source and destination accounts by email                                                  |
| `deno task migrate`                 | Create/update segments, flags and views in the destination project                                               |
| `deno task revert`                  | Remove what a migration created in the destination (uses the sync manifest)                                      |
| `deno task estimate-migration-time` | Estimate how long a migration will take from resource counts and rate limits                                     |
| `deno task import-flags`            | Bulk-import flags from a JSON or CSV file (third-party migrations)                                               |
| `deno task source-from-split`       | Extract and map a Split.io workspace into the extraction format                                                  |
| `deno task diff`                    | Compare the SDK payloads two environments or instances serve                                                     |
| `deno task test`                    | Unit tests                                                                                                       |
| `deno task check`                   | Type-check `src/` and `scripts/`                                                                                 |
| `deno task lint`                    | `deno lint`                                                                                                      |
| `deno task fmt`                     | Format the repository                                                                                            |
| `deno task fmt:check`               | Verify formatting (what CI runs)                                                                                 |
| `deno task version:show`            | Current version, whether it is tagged, pending changelog entries                                                 |
| `deno task version:bump:patch`      | Bump the patch version and roll the changelog (see CONTRIBUTING.md)                                              |
| `deno task version:bump:minor`      | Bump the minor version                                                                                           |
| `deno task version:bump:major`      | Bump the major version                                                                                           |
| `deno task release:check`           | The release gate CI runs on a PR                                                                                 |

Options after the task name go straight to the script, for example `deno task workflow -f my-workflow.yaml`.

### Task Descriptions

1. **source-from-ld**: Downloads all project data (flags, segments, environments) from
   the source LaunchDarkly project
   - Requires network access for API calls
   - Requires file system access to save downloaded data
   - Creates directory structure in `data/launchdarkly-migrations/source/project/`

2. **map-members**: Creates a mapping between member IDs in the source & destination LaunchDarkly accounts
   - Fetches members from both source and destination account instances
   - Matches members based on their email addresses
   - Creates a mapping file in `data/launchdarkly-migrations/mappings/maintainer_mapping.json`
   - Shows a summary of mapped and unmapped members

3. **migrate**: Migrates into an existing destination project
   - Requires network access for API calls
   - Requires file system access to read source data
   - The destination project and its environments must already exist, unless `migration.createProject` / `migration.createEnvironments` are set
   - Verifies environment compatibility; source environments missing from the destination are skipped
   - Creates segments (including big segments if enabled), flags and views, then links flags and segments to views
   - Can optionally map source maintainer IDs to destination maintainer IDs if the mapping
     was done (step 2) maintainers if mapping was done

4. **estimate-migration-time**: (Optional) Estimates the time needed for migration
   - Analyzes source project to count resources
   - Tests rate limits in target account
   - Calculates estimated time based on resource counts and rate limits
   - Shows detailed breakdown of the estimate
   - Helps plan migration timing and resource allocation

5. **import-flags**: Bulk import feature flags from JSON or CSV files
   - Supports multiple flag types (boolean, string, number, JSON)
   - Comprehensive validation before import
   - Dry-run mode for safe testing
   - Rate limiting and error handling
   - Detailed reporting and optional JSON output

6. **revert**: Removes the flags, segments and views a migration created in the destination
   - Reads the sync manifest `migrate` wrote, so prefixed/renamed copies are found under their destination key
   - Dry run by default in the workflow; see "Reverting Migrations"

7. **source-from-split**: Extracts a Split.io workspace and maps it into the extraction format
   - Requires `--allow-env` for the Split Admin API key; see `docs/SPLIT-MAPPING.md`

8. **diff**: Compares the SDK payloads served by two environments or two instances (for example US vs EU)
   - Useful as a post-migration check; see `src/scripts/diff-payload/`

The `test`, `check`, `lint`, `fmt*`, `version:*` and `release:check` tasks are development tasks, described in [CONTRIBUTING.md](CONTRIBUTING.md).

### Task Permissions

Each task includes the necessary permissions:

- `--allow-net`: Required for API calls to LaunchDarkly
- `--allow-read`: Required for reading local files
- `--allow-write`: Required for writing downloaded data
- `--allow-env`: Required for reading environment variables (used by import-flags)

These permissions are automatically included in the task definitions, so you
don't need to specify them manually.

## Command Line Arguments

### source.ts

- `-p, --projKey`: Source project key
- `--domain`: (Optional) LaunchDarkly domain, defaults to `app.launchdarkly.com`. Use `app.eu.launchdarkly.com` for EU instances.
- `--extract-segments`: (Optional) Extract segment data, defaults to false.
- `--extract-big-segments`: (Optional) Also export big segment members as CSV, defaults to false.
- `--include-archived`: (Optional) Also list archived flags (the flags API omits them by default), defaults to false. In workflow YAML: `extraction.includeArchived: true`.

### map_members.ts

- `-o, --output`: (Optional) Output file path, defaults to
  "data/mappings/maintainer_mapping.json"
- `-s, --source-domain`: (Optional) Source LaunchDarkly domain, defaults to `app.launchdarkly.com`
- `-d, --dest-domain`: (Optional) Destination LaunchDarkly domain, defaults to `app.launchdarkly.com`

### migrate.ts

- `-p, --projKeySource`: Source project key
- `-d, --projKeyDest`: Destination project key
- `-m, --assignMaintainerIds`: (Optional) Whether to assign maintainer IDs from
  source project, defaults to false. Requires maintainer mapping to be done
  first.
- `-s, --migrateSegments`: (Optional) Whether to migrate segments, defaults to
  true. Set to false to skip segment migration.
- `-c, --conflictPrefix`: (Optional) Prefix to use when resolving key conflicts
  (e.g., 'imported-'). When a resource with a conflicting key is detected, it
  will be created with this prefix automatically. A rerun updates the copies
  recorded in the sync manifest of the earlier run instead of creating further
  prefixed copies; without a manifest, a flag from an earlier run counts as a
  conflict too.
- `-v, --targetView`: (Optional) View key to link all migrated flags to. This
  will link all flags to the specified view in addition to any views they were
  already linked to in the source project.
- `-e, --environments`: (Optional) Comma-separated list of environment keys to
  migrate (e.g., 'production,staging'). If not specified, all environments will
  be migrated. Useful for selective environment migration or testing.
- `--env-map`: (Optional) Environment mapping in format 'source1:dest1,source2:dest2'
  (e.g., 'prod:production,dev:development'). Maps source environment keys to different
  destination environment keys. Useful when migrating between projects with different
  environment naming conventions.
- `--create-project`: (Optional) Create the destination project if it doesn't
  exist, with the environments being migrated (mapped keys when `--env-map` is
  set). Without it, a missing destination project is an error.
- `--dest-project-name`: (Optional) Name for a project created by
  `--create-project` (config: `destination.projectName`). Without it, the
  destination key is used when it differs from the source key, so two projects
  in one account don't share a name; otherwise the source project's name is
  kept. Ignored when the destination project already exists (it is not
  renamed). Quote names with spaces, e.g.
  `--dest-project-name "NR Import Staging (test dest)"`; in YAML, quoting is
  recommended (`projectName: "NR Import Staging (test dest)"`).
- `--create-environments`: (Optional) Create destination environments that are
  missing, copying name, color, TTL, and other settings from the source. Without
  it, missing environments are skipped (or are an error with `--env-map`).
- `--domain`: (Optional) Destination LaunchDarkly domain, defaults to `app.launchdarkly.com`. Use `app.eu.launchdarkly.com` for EU instances.
- `-f, --config`: (Optional) Path to YAML configuration file. All migration settings
  can be specified in the config file. CLI arguments override config file values.
- `--include-flags`: (Optional) Comma-separated list of flag keys to migrate. Only
  these flags will be migrated. Cannot be combined with `--exclude-flags` meaningfully
  (include is applied first, then exclude). Their prerequisites must be included too
  or already exist in the destination.
- `--exclude-flags`: (Optional) Comma-separated list of flag keys to exclude from
  migration. These flags will be skipped.
- `--concurrency`: (Optional) Max number of flags to migrate in parallel. Defaults
  to 10. Speeds up large migrations while rate limiting still applies.
- `--migrate-big-segments`: (Optional) Import big segment members from the CSVs exported
  during extraction (`--extract-big-segments`).
- `--migrate-views=false`: (Optional) Do not recreate the source project's views or link
  flags and segments to them (config: `migration.migrateViews`). `-v` still applies.
- `--adopt-unresolved`: (Optional) Record the destination resources an incomplete sync manifest
  lists as untracked as this migration's copies (config: `migration.adoptUnresolved`). Only after
  checking by hand that the aborted run created them; see the revert section on merged destinations.
- `--dry-run`: (Optional) Preview without writing to the destination or the sync manifest.

**Exit code.** After the summary, `migrate` reconciles the flag keys (and segment keys per mapped environment) in the source data against the destination and exits with code `1` when any flag or segment failed to create or update, is missing from the destination, or when the reconciliation itself could not be completed (flags skipped by `--since` are out of scope). The workflow runner stops at that step. Exit code `0` means every resource in scope is present in the destination; use `scripts/verify-segments.ts` or an external field-level comparison for content parity.

### estimate_time.ts

- `-p, --projKeySource`: Source project key
- `-r, --rateLimit`: (Optional) Custom rate limit (requests per 10 seconds), defaults to 5

### import_flags.ts

- `-f, --file`: Input file path (JSON or CSV format)
- `-p, --project`: Target LaunchDarkly project key
- `-d, --dry-run`: (Optional) Validate only, no changes made
- `-o, --output`: (Optional) JSON report output file path
- `--domain`: (Optional) LaunchDarkly domain, defaults to `app.launchdarkly.com`. Use `app.eu.launchdarkly.com` for EU instances.

## Notes for the use of the scripts

- The migration process is one-way and cannot be reversed automatically
- Flag Maintainer IDs are different between the account instances and must be mapped
  using the `map-members` script before migration
- Environment keys must match between source and destination projects when migrating
  to an existing project, unless `--env-map` maps them
- The destination project and its environments must exist before migrating, unless
  `--create-project` / `--create-environments` create them; otherwise only environments
  that exist in both projects are migrated
- Segment migration can be skipped using the `-s=false` flag if needed
- Big (unbounded) segments are created in the destination; their members are only
  copied from LaunchDarkly sources when `migrateBigSegments` is enabled
- Context kinds are only created when a source adapter provides `contextKinds.json`
  (e.g. Split). LaunchDarkly extraction doesn't write it yet, so context kind display
  names and settings must be recreated manually
- The tool uses a fixed API version (20240415) which may need to be updated for
  future LaunchDarkly API changes
- The tool includes rate limiting to comply with LaunchDarkly API limits. This
  means it can take some time before the migration script finishes executing if
  there is a large number of resources to be migrated. You can use the
  `estimate` task to get an estimate of how long the migration will take.

## Pre-Migration Checklist

1. **Data Assessment**
   - What flags and segments need to be migrated?
   - Can you use this as an opportunity to clean up unused resources?
   - Experiments, guarded or randomised (percentage-based) rollouts can't be
     migrated while maintaining consistent variation bucketing. These types of
     releases should ideally be completed before the migration takes place.

2. **Access and Permissions**
   - Do you have API access to both source and destination account instances?
   - Have you created the necessary API keys? A least-privilege custom role is described in
     [docs/launchdarkly-migration-role.md](docs/launchdarkly-migration-role.md)
   - Have you created the destination project and its environments?
   - If you use views or big segments, does the token have the view and segment export
     permissions?

3. **Maintainer Mapping**
   - Have all the members who are set as maintainers in the source account been
     added to the destination instance?
   - Are the member emails matching across the account instances?
   - Have you created the maintainer ID mapping file?

4. **Timing and Execution**
   - When is the best time to perform the migration?
   - How will you handle ongoing changes during migration?
   - Do you need to maintain consistent state between source and destination account
     instances after the migration? If so, for how long?

## Known Issues

- TypeScript types are loose due to API client limitations, particularly in
  handling API responses. The tool uses `any` type in several places due to
  LaunchDarkly API response structure variations
- Custom integrations and webhooks need to be manually reconfigured for the new
  account instance after the migration
- The tool does not support the migration of experiments or percentage-based
  rollouts while maintaining consistent variation assignment pre- &
  post-migration. This also applies to percentage rollout rules in segments: the
  segment salt isn't exposed by the API, so it can't be copied

## Flag Import From 3rd Party Sources

The project includes a **Flag Import Tool** that allows you to bulk create feature flags in LaunchDarkly using JSON or CSV files. This is particularly useful for:

- Setting up new projects with predefined flags
- Migrating flags from other systems
- Standardizing flag configurations across projects
- Bulk flag creation for development/testing

### Quick Start

1. **Use the provided template files**:
   ```bash
   # Copy the template files to get started
   cp examples/flags_template.json my_flags.json
   cp examples/flags_template.csv my_flags.csv

   # Edit the copied files with your flag definitions
   # Or create your own files in the import-files directory
   ```

2. **Ensure your API keys are configured**:
   ```bash
   # The import-flags script uses the same API key configuration as other scripts
   # Make sure config/api_keys.json contains your destination account API key
   cp config/api_keys.json.example config/api_keys.json
   # Edit config/api_keys.json with your API keys
   ```

3. **Import flags**:
   ```bash
   # Using deno task (recommended)
   # The script automatically looks in data/third-party-migrations/import-files/
   deno task import-flags -f my_flags.json -p PROJECT_KEY

   # Or using deno run directly
   deno run --allow-net --allow-read --allow-write src/scripts/third-party-migrations/import_flags_from_external.ts -f my_flags.json -p PROJECT_KEY
   ```

### File Formats

#### JSON Format

```json
[
  {
    "key": "flag-key",
    "name": "Flag Name",
    "description": "Flag description",
    "kind": "boolean",
    "variations": [true, false],
    "defaultOnVariation": true,
    "defaultOffVariation": false,
    "tags": ["tag1", "tag2"]
  }
]
```

#### CSV Format

```csv
key,name,description,kind,variations,defaultOnVariation,defaultOffVariation,tags
flag-key,Flag Name,Flag description,boolean,"true,false",true,false,"tag1,tag2"
```

⚠️ **Important**: CSV import is only suitable for non-JSON flag types (boolean, string, number). For flags with JSON variations or complex nested structures, use the JSON format instead.

### Supported Flag Types

- **boolean**: Simple on/off flags with true/false variations
- **string**: Text-based flags with multiple string options
- **number**: Numeric flags with number variations
- **json**: Complex configuration flags with JSON object variations

### Features

- **Validation**: Comprehensive input validation before import
- **Dry-run mode**: Test your configuration without creating flags
- **Rate limiting**: Automatic rate limiting to comply with LaunchDarkly API limits
- **Detailed reporting**: Success/failure summary with optional JSON report
- **Error handling**: Clear error messages for troubleshooting

### Requirements

- **Target project must exist**: The LaunchDarkly project specified with `-p PROJECT_KEY` must already exist in your account
- **API key with write permissions**: Your `destination_account_api_key` in `config/api_keys.json` must have permission to create flags in the target project
- **Consistent with other scripts**: Uses the same API key configuration as LD-to-LD migration scripts

### Examples

```bash
# Dry run to validate configuration
deno task import-flags -f flags.json -p myproject -d

# Import with detailed report
deno task import-flags -f flags.json -p myproject -o import_report.json

# Import from CSV file
deno task import-flags -f flags.csv -p myproject

# Use template files from examples folder
deno task import-flags -f examples/flags_template.json -p myproject -d
```

## Contributing and Releases

Versions follow [Semantic Versioning](https://semver.org/); `deno.json` holds the version and
[CHANGELOG.md](CHANGELOG.md) the notes. Every pull request that changes behaviour bumps the version
(`deno task version:bump:<patch|minor|major>`) and, when it merges, CI creates the tag and a
[GitHub Release](https://github.com/launchdarkly-labs/ld-migration-scripts/releases) from the changelog.
How to set up, what a PR needs and how the release gate works: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache 2.0 - see LICENSE file

## LaunchDarkly Labs Disclaimer

This repository is maintained by LaunchDarkly Labs. While we try to keep it
up to date, it is not officially supported by LaunchDarkly. For officially
supported SDKs and tools, visit https://launchdarkly.com

## Support

If you came across any issues while using these migration scripts or if you have
suggestions for additional enhancements, please create an issue in this
repository. Pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
