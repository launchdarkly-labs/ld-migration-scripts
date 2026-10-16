# Contributing

Thanks for helping with the LaunchDarkly migration scripts. This page covers the
mechanics: how to set up, what a PR needs, and how versions and releases work.
It is short on purpose; the README documents the scripts themselves.

## Setup

- Install [Deno](https://deno.land/). CI uses the version in `.deno-version`;
  anything from Deno 2.0 works locally.
- Copy `config/api_keys.json.example` to `config/api_keys.json` for live runs
  (the unit tests need no keys and no network beyond fetching dependencies).

Useful tasks (all defined in `deno.json`):

| Task                                           | What it does                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `deno task test`                               | Unit tests (`src/**/*_test.ts`)                                  |
| `deno task check`                              | Type-check `src/` and `scripts/`                                 |
| `deno task lint`                               | `deno lint` with the project's rule set                          |
| `deno task fmt` / `deno task fmt:check`        | Format / verify formatting                                       |
| `deno task version:show`                       | Current version, whether it is tagged, pending changelog entries |
| `deno task version:bump:<patch\|minor\|major>` | Bump the version and roll the changelog (see below)              |
| `deno task release:check`                      | The same gate CI runs on a PR                                    |

CI runs `fmt:check`, `lint`, `check` and `test` on every PR, with `--frozen`:
if `deno.lock` would change, the build fails. Run `deno task check` locally and
commit the refreshed `deno.lock` when you add or change a dependency.

## Branches and pull requests

- Branch from `main`; open the PR against `main`. External contributors work
  from a fork, which works the same way.
- Keep the branch current by merging `main` into it (that is what the history
  does; rebasing is fine too if you prefer).
- PRs are merged with a merge commit once both required checks, `checks` and
  `release-gate`, are green.
- The PR template has the checklist. Commit subjects follow the existing
  style: `area: what changed` (for example `migrate: stop patching deprecatedDate`).

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Every change a user can notice gets an entry under `## [Unreleased]`, in a
`### Added`, `### Changed`, `### Fixed` or `### Documentation` subsection.

Write entries the way the existing ones are written:

- Name the thing: the task, script, option or config key, in backticks
  (`migrate`, `--incremental`, `migration.tags`, `source_from_ld.ts`).
- Say what the user sees now and, for fixes, what went wrong before.
- One line per bullet (the formatter keeps line breaks as you write them), and
  end with the PR number: `(#32)`.

## Versioning and releases

The version in `deno.json` is the only source of truth. Versions follow
[Semantic Versioning](https://semver.org/):

| Bump      | When                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **major** | A user has to change something to keep working: CLI flags or tasks removed or renamed, workflow YAML / keys file / sync manifest / extraction format changed incompatibly |
| **minor** | New option, task, script or capability; existing behaviour unchanged                                                                                                      |
| **patch** | Fixes and behaviour corrections                                                                                                                                           |

**Every PR releases.** The rule that keeps the changelog honest and `main`
always at a tagged version:

1. Write your changelog entries under `[Unreleased]`.
2. Run `deno task version:bump:<patch|minor|major>`. It bumps `deno.json`,
   turns the `[Unreleased]` block into `## [X.Y.Z] - <today>` and leaves an
   empty `[Unreleased]` heading on top. Commit the result in your PR
   (`Release X.Y.Z` as a separate commit reads well).
3. `deno task release:check` tells you whether the PR will pass the gate.
4. When the PR merges, the **Release** workflow creates the tag `vX.Y.Z` and a
   GitHub Release whose notes are your changelog section. Nobody creates tags
   by hand; please do not either.

**PRs that change nothing for users** (documentation, CI, refactors, tests)
get the `no-release` label instead of a bump. The gate then only checks that
the version is unchanged. If such a PR still has something worth noting, put
it under `[Unreleased]`: the next releasing PR sweeps it up, because the bump
script moves everything under that heading.

The gate (`release-gate` check, `scripts/release-check.sh`) fails with a hint
when:

- the version did not change and the PR has no `no-release` label, or did
  change and the PR has the label;
- the new version is not higher than the one on `main`, or is already tagged
  (another PR released it first; see below);
- `CHANGELOG.md` has no `## [X.Y.Z] - YYYY-MM-DD` heading for the new version,
  that section is empty, or `[Unreleased]` still has entries.

**Someone released first.** Two open PRs may both bump 3.4.0 to 3.4.1. The
first one to merge wins the version. The second PR cannot merge until it is up
to date with `main` (the ruleset requires it); merging `main` conflicts on the
version line and the changelog heading. Resolve by taking `main`'s side, then
run the bump again so your entries land under 3.4.2, and push. The gate
re-runs on the push.

**A release went wrong.** Ship a new patch version with the fix. Tags and
GitHub Releases are never deleted or moved; the compare links in the Releases
page depend on them.

## Code style

`deno fmt` and `deno lint` are enforced in CI. Two lint rules are excluded in
`deno.json` until their cleanups happen, both welcome as `no-release` PRs:

- `no-import-prefix`: the code imports `https://deno.land/std@...` modules
  (three different std versions); the fix is moving them to `jsr:@std/...`.
- `no-explicit-any`: the API payload handling uses `any` in many places.

Please do not add new `any`s or new `https://` imports where a `jsr:` one
exists.

## For maintainers

- **Labels**: `no-release` is the only one the gate reads. Apply it to docs/CI
  PRs, including PRs from forks whose authors cannot set labels. Dependabot's
  action-update PRs come pre-labelled.
- **Required checks** on `main` are `checks` (CI) and `release-gate`, with
  "require branches to be up to date" on, configured in the repository
  ruleset. The ruleset has no bypass, so nothing is pushed to `main`
  directly; disable it temporarily if that is ever needed.
- **Release workflow failed** (for example a transient GitHub error after the
  merge): re-run it from the Actions tab, or trigger it manually
  (`workflow_dispatch`). It is safe to re-run: with the tag already present
  and the version unchanged since the previous main commit, it does nothing.
- **Release workflow failed with "already tagged"**: two PRs bumped to the same
  version and both merged. The second one's changes are on `main` but
  unreleased. Open a PR that bumps to the next version and moves the second
  PR's entries under it (edit the changelog by hand in this case).
