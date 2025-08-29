#!/bin/bash

# Simple version bumper for LaunchDarkly Migration Scripts
# Usage: ./scripts/bump-version.sh [major|minor|patch]

set -e

if [ $# -eq 0 ]; then
    echo "Usage: $0 [major|minor|patch]"
    echo "Example: $0 patch"
    exit 1
fi

TYPE=$1
if [[ ! "$TYPE" =~ ^(major|minor|patch)$ ]]; then
    echo "Error: Type must be major, minor, or patch"
    exit 1
fi

# Get current version from deno.json
CURRENT_VERSION=$(grep '"version"' deno.json | sed 's/.*"version": "\([^"]*\)".*/\1/')
echo "Current version: $CURRENT_VERSION"

# Parse version components
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Bump version
case $TYPE in
    major)
        MAJOR=$((MAJOR + 1))
        MINOR=0
        PATCH=0
        ;;
    minor)
        MINOR=$((MINOR + 1))
        PATCH=0
        ;;
    patch)
        PATCH=$((PATCH + 1))
        ;;
esac

NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo "New version: $NEW_VERSION"

# Update deno.json
sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" deno.json
rm deno.json.bak

# Update README badge
sed -i.bak "s/version-[^-]*-blue/version-$NEW_VERSION-blue/" README.md
rm README.md.bak

# Update CHANGELOG.md
TODAY=$(date +%Y-%m-%d)
sed -i.bak "s/## \[Unreleased\]/## [$NEW_VERSION] - $TODAY\n\n## [Unreleased]/" CHANGELOG.md
rm CHANGELOG.md.bak

echo "✅ Version bumped to $NEW_VERSION"
echo ""
echo "Next steps:"
echo "  1. git add ."
echo "  2. git commit -m \"Bump version to $NEW_VERSION\""
echo "  3. git tag v$NEW_VERSION"
echo "  4. git push && git push --tags"
