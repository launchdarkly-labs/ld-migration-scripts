# Third-Party Migrations

This directory contains scripts for importing data from external sources into LaunchDarkly (e.g., CSV files, JSON files, other systems).

## Scripts

- **`import_flags_from_external.ts`** - Imports feature flags from JSON or CSV files

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

Template files are provided in `data/third-party-migrations/import-files/`:
- `flags_template.json` - JSON template with examples of different flag types
- `flags_template.csv` - CSV template with examples of different flag types

⚠️ **Important**: CSV import is only suitable for non-JSON flag types (boolean, string, number). For flags with JSON variations or complex nested structures, use the JSON format instead.

## Supported Formats

- **JSON**: Native JSON arrays of flag objects
- **CSV**: Comma-separated values with headers
- **Flag Types**: boolean, string, number, JSON
