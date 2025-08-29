#!/bin/bash

# Simple version checker
echo "📦 LaunchDarkly Migration Scripts"
echo "=================================="

# Get version from deno.json
VERSION=$(grep '"version"' deno.json | sed 's/.*"version": "\([^"]*\)".*/\1/')
echo "Current version: $VERSION"

# Parse and display components
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"
echo "   Major: $MAJOR"
echo "   Minor: $MINOR"
echo "   Patch: $PATCH"

# Check if there are unreleased changes
if grep -q "## \[Unreleased\]" CHANGELOG.md; then
    echo ""
    echo "📋 Unreleased changes found in CHANGELOG.md"
    echo "   Consider bumping version before release"
fi
