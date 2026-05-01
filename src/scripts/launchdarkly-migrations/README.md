# LaunchDarkly Migrations

This directory contains scripts for migrating LaunchDarkly projects between different LaunchDarkly instances (e.g., US to EU, account mergers, project splitting).

## Scripts

- **`workflow.ts`** - Workflow orchestrator: runs complete end-to-end migrations from a single YAML config file
- **`source_from_ld.ts`** - Downloads project data from a source LaunchDarkly instance
- **`map_members_between_ld_instances.ts`** - Creates member ID mappings between LaunchDarkly instances
- **`migrate_between_ld_instances.ts`** - Migrates projects between LaunchDarkly instances
- **`revert_migration.ts`** - Reverts a previously executed migration
- **`estimate_migration_time.ts`** - Estimates migration time based on project size and rate limits

## Data Structure

Data is stored in `data/launchdarkly-migrations/`:
- `source/` - Downloaded source project data
- `mappings/` - Member ID mappings between instances

Extracted flag data uses index-prefixed filenames (`flags/0-my-flag.json`, `flags/1-other-flag.json`, ...) to avoid case collisions on case-insensitive filesystems while keeping files human-browsable.

## Usage

```bash
# Run full workflow from a YAML config
deno task workflow examples/workflow-full.yaml

# Or use -f flag
deno task workflow -f examples/workflow-full.yaml

# Shortcut tasks
deno task workflow:full
deno task workflow:incremental

# Download source project data
deno task source-from-ld -p PROJECT_KEY

# Map members between instances
deno task map-members

# Estimate migration time
deno task estimate-migration-time -p SOURCE_PROJECT_KEY

# Migrate project
deno task migrate -p SOURCE_PROJECT_KEY -d DESTINATION_PROJECT_KEY

# Migrate with include/exclude flags and parallel concurrency
deno task migrate -p SOURCE -d DEST --include-flags "flag-a,flag-b" --concurrency 20

# Revert a migration
deno task revert -f examples/revert-migration-example.yaml --dry-run
```
