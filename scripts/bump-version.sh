#!/usr/bin/env bash
#
# Bumps the version for a release-per-PR workflow (see CONTRIBUTING.md).
# Usage: ./scripts/bump-version.sh [major|minor|patch]
#
# Rewrites "version" in deno.json and turns the [Unreleased] block of
# CHANGELOG.md into "## [X.Y.Z] - <today>", leaving an empty [Unreleased]
# heading on top. Write the changelog entries first; the script refuses to
# release an empty block. Commit the result in your PR: the tag and the
# GitHub Release are created automatically when the PR merges into main.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -eq 0 ]; then
  echo "Usage: $0 [major|minor|patch]"
  echo "Example: $0 patch"
  exit 1
fi

TYPE=$1
if [[ ! "$TYPE" =~ ^(major|minor|patch)$ ]]; then
  echo "Error: type must be major, minor, or patch"
  exit 1
fi

CURRENT_VERSION=$(jq -r .version deno.json)
echo "Current version: $CURRENT_VERSION"

# Refuse to release nothing: there must be entries under [Unreleased].
UNRELEASED=$(awk '/^## \[Unreleased\]/ { f = 1; next } /^## \[/ { f = 0 } f && NF' CHANGELOG.md | wc -l | tr -d ' ')
if [ "$UNRELEASED" -eq 0 ]; then
  echo "Error: CHANGELOG.md has no entries under [Unreleased]."
  echo "       Describe your change there first (### Added / Changed / Fixed), then bump."
  exit 1
fi

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
case $TYPE in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo "New version: $NEW_VERSION"

# deno.json: jq would reorder nothing but may change formatting, so use sed on the one line.
sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" deno.json
rm deno.json.bak

# CHANGELOG.md: insert the new heading right under [Unreleased] so the block
# moves under it. awk rather than sed: BSD sed does not expand \n in a replacement.
TODAY=$(date +%Y-%m-%d)
awk -v v="$NEW_VERSION" -v d="$TODAY" '
  !done && $0 == "## [Unreleased]" { print; print ""; print "## [" v "] - " d; done = 1; next }
  { print }
' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md

echo "✅ Version bumped to $NEW_VERSION; CHANGELOG.md has a [$NEW_VERSION] - $TODAY section."
echo ""
echo "Next steps:"
echo "  1. Review the [$NEW_VERSION] section in CHANGELOG.md"
echo "  2. git add deno.json CHANGELOG.md && git commit -m \"Release $NEW_VERSION\""
echo "  3. Push and open a PR. On merge, CI creates the tag v$NEW_VERSION and the GitHub Release."
echo "     (Do not create tags by hand.)"
echo ""
echo "Self-check against origin/main (skipped if offline):"
if git fetch -q origin main 2>/dev/null; then
  BASE_REF=FETCH_HEAD ./scripts/release-check.sh || true
else
  echo "  could not fetch origin/main; run 'deno task release:check' later"
fi
