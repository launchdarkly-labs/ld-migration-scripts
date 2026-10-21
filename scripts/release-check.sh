#!/usr/bin/env bash
#
# Release gate: checks that a branch is ready to merge into main under the
# release-per-PR policy (see CONTRIBUTING.md, "Versioning and releases").
#
# Usage:
#   scripts/release-check.sh                  # compare against origin/main
#   BASE_REF=FETCH_HEAD scripts/release-check.sh
#   NO_RELEASE=true scripts/release-check.sh  # for a PR carrying the no-release label
#
# Environment:
#   BASE_REF    git ref holding the base deno.json (default: origin/main)
#   NO_RELEASE  "true" when the PR is labelled no-release (default: false)
#
# Exit code 0 when every check passes; 1 with a hint on the first failure.
# Runs on macOS (BSD) and Linux (GNU) tools; needs git, jq, awk, grep, sort.

set -euo pipefail
cd "$(dirname "$0")/.."

BASE_REF="${BASE_REF:-origin/main}"
NO_RELEASE="${NO_RELEASE:-false}"
DOC="CONTRIBUTING.md (Versioning and releases)"

fail() {
  echo "::error::release-check: $1"
  echo "  hint: $2"
  echo "  see:  $DOC"
  exit 1
}

head_version=$(jq -r .version deno.json)
base_version=$(git show "$BASE_REF:deno.json" 2>/dev/null | jq -r .version) ||
  fail "cannot read deno.json from $BASE_REF" \
    "run 'git fetch origin main' first, or set BASE_REF to a ref that exists"

echo "release-check: base $base_version ($BASE_REF), head $head_version, no-release=$NO_RELEASE"

# Body of a changelog section: the lines after its heading up to the next
# "## [" heading. Only non-blank lines are printed.
section_body() {
  awk -v h="$1" '
    $0 ~ "^## \\[" h "\\]" { f = 1; next }
    /^## \[/ { f = 0 }
    f && NF
  ' CHANGELOG.md
}

if [ "$NO_RELEASE" = "true" ]; then
  [ "$head_version" = "$base_version" ] ||
    fail "version changed ($base_version -> $head_version) on a PR labelled no-release" \
      "either drop the label (this PR is a release) or revert the version bump"
  echo "release-check: no-release PR, version unchanged: OK"
  exit 0
fi

[[ "$head_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  fail "version '$head_version' in deno.json is not X.Y.Z" \
    "use plain semantic versions, e.g. 3.4.1"

if [ "$head_version" = "$base_version" ]; then
  fail "version is still $base_version; this PR does not bump it" \
    "run 'deno task version:bump:<patch|minor|major>', or add the 'no-release' label for a docs/CI/refactor-only PR"
fi

lowest=$(printf '%s\n' "$base_version" "$head_version" | sort -V | head -1)
[ "$lowest" = "$base_version" ] ||
  fail "version $head_version is lower than $base_version on $BASE_REF" \
    "merge main into this branch and re-run the bump"

if git ls-remote --exit-code --tags origin "refs/tags/v$head_version" >/dev/null 2>&1; then
  fail "tag v$head_version already exists; another PR released this version first" \
    "merge main into this branch, then re-run 'deno task version:bump:<type>' so the version moves past $head_version"
fi

grep -qE "^## \[${head_version//./\\.}\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$" CHANGELOG.md ||
  fail "CHANGELOG.md has no '## [$head_version] - YYYY-MM-DD' heading" \
    "the bump script adds it; if you edited by hand, add the heading with today's date"

[ -n "$(section_body "$head_version")" ] ||
  fail "the [$head_version] changelog section is empty" \
    "describe the change under ### Added / Changed / Fixed in that section"

[ -z "$(section_body "Unreleased")" ] ||
  fail "CHANGELOG.md still has entries under [Unreleased]" \
    "move them into the [$head_version] section (the bump script does this when run after the entries are written)"

echo "release-check: $base_version -> $head_version, changelog section present, Unreleased empty: OK"
