# LaunchDarkly Migration Scripts

[![Version](https://img.shields.io/badge/version-2.1.0-blue.svg)](https://github.com/your-username/ld-migration-scripts)
[![Deno](https://img.shields.io/badge/deno-v2.x-blue.svg)](https://deno.land/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
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
- **Views support**: Automatic extraction and creation of views with flag linkage
- **Conflict resolution**: Automatic handling of resource key conflicts with configurable prefixes

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
  domain: app.launchdarkly.com  # Default if not specified

destination:
  projectKey: eu-project
  domain: app.eu.launchdarkly.com  # EU instance
```

**Via CLI flags**:
```bash
# Source extraction with custom domain
deno task source -p my-project --domain app.launchdarkly.com

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

- [Deno](https://deno.land/) **2.0.0 or higher** installed
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
  assignMaintainerIds: false  # No map-members step
  conflictPrefix: "imported-"
  targetView: "migration-2024"
```

```bash
deno task workflow -f workflow-migrate-only.yaml
```

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

### Custom Step Combinations

```yaml
# workflow-custom.yaml
workflow:
  steps:
    - extract-source
    - migrate  # Skip map-members

source:
  projectKey: source-project

destination:
  projectKey: dest-project

migration:
  assignMaintainerIds: false  # Must be false when skipping map-members
  environmentMapping:
    prod: production
    dev: development
```

### Workflow Configuration Structure

```yaml
workflow:                    # Optional - defaults to full workflow
  steps:                     # List of steps to execute in order
    - extract-source         # Download source project data
    - map-members           # Map member IDs
    - migrate               # Run migration
    - third-party-import    # Or import from external sources

source:                      # Required
  projectKey: string         # Source project key
  domain: string            # Optional: Defaults to app.launchdarkly.com

destination:                 # Required for migrate step
  projectKey: string         # Destination project key
  domain: string            # Optional: Defaults to app.launchdarkly.com

memberMapping:               # Optional - for map-members step
  outputFile: string         # Where to save mapping file

migration:                   # Optional - for migrate step
  assignMaintainerIds: boolean
  migrateSegments: boolean
  conflictPrefix: string
  targetView: string
  environments: string[]
  environmentMapping:
    sourceEnv: destEnv

thirdPartyImport:           # Required for third-party-import step
  inputFile: string          # JSON or CSV file path
  targetProject: string      # Target LD project
  dryRun: boolean           # Validation only
  reportOutput: string      # Optional report path
```

### Available Steps

- **`extract-source`** - Downloads all data from source project
- **`map-members`** - Creates member ID mappings between instances
- **`migrate`** - Migrates project to destination
- **`third-party-import`** - Imports flags from external JSON/CSV files

### Workflow Examples Included

- `examples/workflow-full.yaml` - Complete workflow (default behavior)
- `examples/workflow-extract-only.yaml` - Extract source data only
- `examples/workflow-migrate-only.yaml` - Migrate with pre-extracted data
- `examples/workflow-third-party.yaml` - Third-party flag import
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
  domain: app.launchdarkly.com  # Optional: Defaults to app.launchdarkly.com

destination:
  projectKey: my-destination-project
  domain: app.launchdarkly.com  # Optional: Use app.eu.launchdarkly.com for EU

# Migration settings
migration:
  assignMaintainerIds: true
  migrateSegments: true
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

For use with `deno task migrate -f` (not workflow orchestrator):

```yaml
source:
  projectKey: string         # Required: Source project key
  domain: string             # Optional: Defaults to app.launchdarkly.com

destination:
  projectKey: string         # Required: Destination project key
  domain: string             # Optional: Defaults to app.launchdarkly.com

migration:                   # Migration settings
  assignMaintainerIds: boolean          # Default: false
  migrateSegments: boolean              # Default: true
  conflictPrefix: string                # Optional
  targetView: string                    # Optional
  environments: string[]                # Optional, list format
  environmentMapping:                   # Optional, key-value mapping
    sourceEnv: destEnv
    ...
```

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

The migration script automatically handles LaunchDarkly Views (Early Access feature):

- **Automatic extraction**: Discovers all view associations from source flags
- **View creation**: Creates views in the destination project if they don't exist
- **View linking**: Preserves view associations when creating flags
- **Target view**: Optionally link all migrated flags to a specific view

**Usage examples:**

```bash
# Migrate flags and preserve their view associations
deno task migrate -p SOURCE_PROJECT -d DEST_PROJECT

# Link all migrated flags to a specific view (in addition to source views)
deno task migrate -p SOURCE_PROJECT -d DEST_PROJECT -v my-target-view

# The script will automatically:
# 1. Extract view keys from source flags
# 2. Create missing views in destination
# 3. Link flags to views during creation
```

**Notes:**
- Views are an Early Access feature in LaunchDarkly
- If a view already exists in the destination, it will be reused
- View associations are preserved from the source project
- The `-v` flag adds an additional view linkage (doesn't replace existing ones)

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
- Destination environments must already exist in the target project
- If a mapped destination environment doesn't exist, migration will abort with error
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

## Using Deno Tasks

The project includes predefined Deno tasks for easier execution. These tasks are
configured in `deno.json` and include all necessary permissions.

### Available Tasks

```json
{
  "tasks": {
    "source-from-ld": "deno run --allow-net --allow-read --allow-write src/scripts/launchdarkly-migrations/source_from_ld.ts",
    "map-members": "deno run --allow-net --allow-read --allow-write src/scripts/launchdarkly-migrations/map_members_between_ld_instances.ts",
    "migrate": "deno run --allow-net --allow-read --allow-write src/scripts/launchdarkly-migrations/migrate_between_ld_instances.ts",
    "estimate-migration-time": "deno run --allow-net --allow-read --allow-write src/scripts/launchdarkly-migrations/estimate_migration_time.ts",
    "import-flags": "deno run --allow-net --allow-read --allow-write src/scripts/third-party-migrations/import_flags_from_external.ts"
  }
}
```

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

3. **migrate**: Creates a new project or migrates into an existing project
   - Requires network access for API calls
   - Requires file system access to read source data
   - Can create a new project or use an existing one
   - Verifies environment compatibility when using existing projects
   - Creates flags, segments, and environments (if creating new project)
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
  will be created with this prefix automatically.
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
- `--domain`: (Optional) Destination LaunchDarkly domain, defaults to `app.launchdarkly.com`. Use `app.eu.launchdarkly.com` for EU instances.
- `-f, --config`: (Optional) Path to YAML configuration file. All migration settings
  can be specified in the config file. CLI arguments override config file values.

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
- Environment names and keys must match between source and destination projects
  when migrating to an existing project
- The destination project can either be new or existing:
  - For new projects: All environments will be created automatically
  - For existing projects: Only environments that exist in both projects will be migrated
- Segment migration can be skipped using the `-s=false` flag if needed
- Unbounded (big) segments are automatically skipped during migration
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
   - Have you created the necessary API keys?
   - Do you have sufficient access to create projects in the destination account?

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
  post-migration

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

## Version Management

This project uses [Semantic Versioning](https://semver.org/) and maintains a [CHANGELOG.md](CHANGELOG.md) for tracking changes.

### Quick Version Commands

```bash
# Check current version
deno task version:show

# Bump version (patch, minor, or major)
deno task version:bump:patch    # 1.0.0 → 1.0.1
deno task version:bump:minor    # 1.0.0 → 1.1.0
deno task version:bump:major    # 1.0.0 → 2.0.0
```

### Manual Version Management

You can also manage versions manually:
- **deno.json**: Update the `version` field
- **README.md**: Update the version badge
- **CHANGELOG.md**: Move items from `[Unreleased]` to a new version section

## Support

If you came across any issues while using these migration scripts or if you have
suggestions for additional enhancements, please create an issue in this
repository.
