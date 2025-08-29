# LaunchDarkly Migrations

This directory contains scripts for migrating LaunchDarkly projects between different LaunchDarkly instances (e.g., US to EU, account mergers, project splitting).

## Scripts

- **`source_from_ld.ts`** - Downloads project data from a source LaunchDarkly instance
- **`map_members_between_ld_instances.ts`** - Creates member ID mappings between LaunchDarkly instances
- **`migrate_between_ld_instances.ts`** - Migrates projects between LaunchDarkly instances
- **`estimate_migration_time.ts`** - Estimates migration time based on project size and rate limits

## Data Structure

Data is stored in `data/launchdarkly-migrations/`:
- `source/` - Downloaded source project data
- `mappings/` - Member ID mappings between instances

## Usage

```bash
# Download source project data
deno task source-from-ld -p PROJECT_KEY

# Map members between instances
deno task map-members

# Estimate migration time
deno task estimate-migration-time -p SOURCE_PROJECT_KEY

# Migrate project
deno task migrate -p SOURCE_PROJECT_KEY -d DESTINATION_PROJECT_KEY
```
