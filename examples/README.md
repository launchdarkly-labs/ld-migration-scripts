# Examples

This folder contains template and example files for the LaunchDarkly Migration Scripts.

## Workflow Configuration Files (Recommended)

**Use these for complete, automated migrations.**

Workflow configs orchestrate entire migration workflows from a single file. They run multiple steps automatically and are the **recommended approach** for most migrations.

**Key benefit:** One command runs everything - extract → map → migrate

### `workflow-full.yaml`
**⭐ RECOMMENDED for most migrations**

Complete end-to-end migration workflow that runs all steps automatically:
1. Extract source project data
2. Map member IDs between instances
3. Migrate to destination

**Usage:**
```bash
deno task workflow -f examples/workflow-full.yaml
```

**Key feature:** If you don't specify `workflow.steps`, it runs the FULL workflow by default!

### `workflow-extract-only.yaml`
Extract source project data without running migration.

**Usage:**
```bash
deno task workflow -f examples/workflow-extract-only.yaml
```

### `workflow-migrate-only.yaml`
Run migration with pre-extracted data (skips extract and map steps).

**Usage:**
```bash
deno task workflow -f examples/workflow-migrate-only.yaml
```

### `workflow-third-party.yaml`
Import flags from external JSON/CSV files.

**Usage:**
```bash
deno task workflow -f examples/workflow-third-party.yaml
```

### `workflow-custom-steps.yaml`
Custom step combinations - run only the steps you need.

**Usage:**
```bash
deno task workflow -f examples/workflow-custom-steps.yaml
```

## Migration Configuration Files (Advanced)

**Use these only when you need to run the migrate step separately.**

These configs are for the individual `deno task migrate` command - **not** the workflow orchestrator. Use these when:
- You've already extracted source data manually
- You want fine-grained control over each step
- You're running steps in a custom CI/CD pipeline

**For most users:** Use workflow configs instead (see above).

### `migration-config.yaml`
Complete example showing all available migration options:
- Source and destination project keys
- Maintainer ID mapping
- Segment migration options
- Conflict resolution with prefixes
- View organization
- Environment filtering
- Environment key mapping

**Usage:**
```bash
deno task migrate -f examples/migration-config.yaml
```

### `migration-config-simple.yaml`
Minimal configuration for basic migrations - just source and destination projects with defaults.

**Usage:**
```bash
deno task migrate -f examples/migration-config-simple.yaml
```

### `migration-config-advanced.yaml`
Full-featured migration with all options enabled - great as a starting point for complex migrations.

**Usage:**
```bash
deno task migrate -f examples/migration-config-advanced.yaml
```

### `migration-config-env-mapping.yaml`
Focused on environment mapping for projects with different naming conventions (e.g., prod → production).

**Usage:**
```bash
deno task migrate -f examples/migration-config-env-mapping.yaml
```

## Flag Import Template Files

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

## Usage Examples

### Recommended: Using Workflow Configs

**For most migrations, use the workflow orchestrator:**

```bash
# 1. Copy and customize a workflow template
cp examples/workflow-full.yaml my-migration.yaml

# 2. Edit with your settings
# source.projectKey: your-source
# destination.projectKey: your-dest

# 3. Run complete migration with one command
deno task workflow -f my-migration.yaml
```

That's it! The workflow runs all steps automatically.

### Advanced: Using Migration Config Files

**Only if you need to run steps separately:**

1. **Manually extract source data first:**
   ```bash
   deno task source-from-ld -p my-source-project
   ```

2. **Then run migration with config:**
   ```bash
   cp examples/migration-config.yaml my-migration.yaml
   # Edit my-migration.yaml
   deno task migrate -f my-migration.yaml
   ```

3. **Override** config values with CLI arguments:
   ```bash
   deno task migrate -f my-migration.yaml -c "cli-prefix-"
   ```

### Using Flag Import Templates

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
- **Migration configs**: Create anywhere, reference with `-f` flag

## Quick Decision Guide

**Which config files should I use?**

| Use Case | Config Type | Example File |
|----------|-------------|--------------|
| **Complete migration (recommended)** | Workflow | `workflow-full.yaml` |
| Extract source data only | Workflow | `workflow-extract-only.yaml` |
| Third-party flag import | Workflow | `workflow-third-party.yaml` |
| Custom step combinations | Workflow | `workflow-custom-steps.yaml` |
| Already have extracted data | Migration | `migration-config.yaml` |
| Fine-grained CI/CD control | Migration | `migration-config-*.yaml` |

**Rule of thumb:** Use workflow configs unless you have a specific reason not to.

## Configuration File Benefits

✅ **Version control** - Store migration configs in git
✅ **Reproducible** - Run the same migration multiple times
✅ **Maintainable** - Manage complex migrations easily
✅ **Self-documenting** - YAML comments explain each option
✅ **Flexible** - CLI can override any config value
✅ **Automated** - Workflow configs run all steps automatically
