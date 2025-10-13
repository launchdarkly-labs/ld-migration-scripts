# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
