# Third-Party Migrations

This directory contains scripts for importing data from external sources into LaunchDarkly (e.g., CSV files, JSON files, other systems).

## Scripts

- **`import_flags_from_external.ts`** - Imports feature flags from JSON or CSV files
- **`source_from_split.ts`** - Extracts a Split (Harness FME) workspace into the LD-to-LD source-data format for full-fidelity migration

## Split (Harness FME) Migration

`source_from_split.ts` reads a Split workspace via the Split Admin API and
writes the same source-data directory that `source-from-ld` produces, so the
standard `migrate` step performs all LaunchDarkly writes. This migrates far
more than the product Split import integration (which only imports flag
names, variations, default rules, and tags):

- Per-environment targeting rules (full matcher translation), percentage
  rollouts, and individual targets
- Standard, rule-based, and large segments (large segments are created empty
  — Split's API cannot export their members)
- Traffic types as context kinds
- Flag dependencies (`IN_SPLIT`) as prerequisites where expressible
- Per-treatment dynamic configurations as JSON variations
- Flag sets as `flagset.<name>` tags

Not migratable (no Split export API): experiments, metric definitions, and
large segment membership. See [docs/SPLIT-MAPPING.md](../../../docs/SPLIT-MAPPING.md)
for the complete mapping specification.

```bash
# API key from env (or split_api_key in config/api_keys.json)
export SPLIT_API_KEY=...

# Extract a workspace (read-only against Split; writes local files only)
deno task source-from-split -- -w "My Workspace" -p split-workspace \
  --env-map "Prod-Default:production,Staging:test"

# Review the fidelity report
cat data/launchdarkly-migrations/source/project/split-workspace/split-fidelity-report.json

# Dry-run the migration into an existing LD project, then run for real
deno task migrate -- -p split-workspace -d my-ld-project --dry-run
deno task migrate -- -p split-workspace -d my-ld-project --on-conflict prompt
```

Or run both steps from one config: `deno task workflow -- -f examples/workflow-split.yaml`

## Data Structure

Data is stored in `data/third-party-migrations/`:
- `import-files/` - Template files and user-provided import files
- `reports/` - Import operation reports and logs

## Usage

```bash
# Import flags from JSON file
deno task import-flags -f flags.json -p PROJECT_KEY

# Import flags from CSV file
deno task import-flags -f flags.csv -p PROJECT_KEY

# Dry run to validate
deno task import-flags -f flags.json -p PROJECT_KEY -d

# Import with detailed report
deno task import-flags -f flags.json -p PROJECT_KEY -o report.json

# Use template files (automatically found in import-files directory)
deno task import-flags -f flags_template.json -p PROJECT_KEY -d
```

## Important Notes

- **Target project must exist**: The LaunchDarkly project specified with `-p PROJECT_KEY` must already exist
- **API key configuration**: Uses `destination_account_api_key` from `config/api_keys.json`
- **API key permissions**: Your `destination_account_api_key` must have permission to create flags in the target project

## File Location

The script automatically looks for import files in the `data/third-party-migrations/import-files/` directory. You can:

- **Use just the filename**: `deno task import-flags -f my_flags.json -p PROJECT_KEY`
- **Provide a full path**: `deno task import-flags -f /path/to/my_flags.json -p PROJECT_KEY`

Place your import files in the designated directory for the best experience.

## Template Files

Template files are provided in the `examples/` folder:
- `examples/flags_template.json` - JSON template with examples of different flag types
- `examples/flags_template.csv` - CSV template with examples of different flag types

⚠️ **Important**: CSV import is only suitable for non-JSON flag types (boolean, string, number). For flags with JSON variations or complex nested structures, use the JSON format instead.

## Supported Formats

- **JSON**: Native JSON arrays of flag objects
- **CSV**: Comma-separated values with headers
- **Flag Types**: boolean, string, number, JSON
