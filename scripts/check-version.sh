#!/usr/bin/env bash
#
# Shows the current version and whether it has been released (tagged).
# Usage: deno task version:show

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(jq -r .version deno.json)
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

echo "📦 LaunchDarkly Migration Scripts"
echo "=================================="
echo "Current version: $VERSION  (major $MAJOR, minor $MINOR, patch $PATCH)"

if git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1; then
  echo "Tag v$VERSION exists on origin: this version is released."
elif git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null 2>&1; then
  echo "Tag v$VERSION exists locally only."
else
  echo "Tag v$VERSION does not exist yet (it is created when the bump merges into main)."
fi

# Entries under [Unreleased]: non-blank lines between that heading and the next "## [".
UNRELEASED=$(awk '/^## \[Unreleased\]/ { f = 1; next } /^## \[/ { f = 0 } f && NF' CHANGELOG.md | wc -l | tr -d ' ')
if [ "$UNRELEASED" -gt 0 ]; then
  echo ""
  echo "📋 $UNRELEASED line(s) under [Unreleased] in CHANGELOG.md."
  echo "   A PR that changes behaviour releases them with: deno task version:bump:<patch|minor|major>"
fi
