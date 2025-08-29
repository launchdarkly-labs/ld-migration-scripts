# Examples

This folder contains template and example files for the LaunchDarkly Migration Scripts.

## Template Files

### `flags_template.json`
JSON template for importing flags from external sources. Supports all flag types:
- **boolean**: Simple on/off flags
- **string**: Text-based flags with multiple options
- **number**: Numeric flags with number variations
- **json**: Complex configuration flags with JSON objects

### `flags_template.csv`
CSV template for importing simple flags. Best for:
- **boolean**: True/false variations
- **string**: Text variations
- **number**: Numeric variations

⚠️ **Note**: CSV import is not suitable for JSON flag types. Use the JSON template for complex flags.

## Usage

1. **Copy templates** to get started:
   ```bash
   cp examples/flags_template.json my_flags.json
   cp examples/flags_template.csv my_flags.csv
   ```

2. **Edit the files** with your flag definitions

3. **Import flags** using the migration scripts:
   ```bash
   deno task import-flags -f my_flags.json -p PROJECT_KEY
   ```

## File Locations

- **Templates**: `examples/` (included in repository)
- **Working files**: `data/third-party-migrations/import-files/` (gitignored)
- **Reports**: `data/third-party-migrations/reports/` (gitignored)
