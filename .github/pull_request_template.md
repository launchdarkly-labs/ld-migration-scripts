## What and why

<!-- What changes for a user of the scripts, and why. Link the issue if there is one. -->

## How it was tested

<!-- Unit tests added/updated? A rehearsal run against a test project? -->

## Checklist

See [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md).

- [ ] `deno task test`, `deno task lint` and `deno fmt --check` pass locally
- [ ] CHANGELOG.md entry written (code-voice, names the option/script, references this PR)
- [ ] Version bumped with `deno task version:bump:<patch|minor|major>` **or** this PR carries the `no-release` label (docs/CI/refactor only)
- [ ] `deno task release:check` passes (with `NO_RELEASE=true` for a no-release PR)
- [ ] README updated if an option, task or file format changed
