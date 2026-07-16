# Migrate findings surfaced by the 600+ flag hardcore scale test

**Status:** documented, not yet fixed.
**Branch:** `migrate-scale-findings` (off `main`).
**Context:** a hardcore seed (619 Split flags) → extract (618 mapped) → migrate
into an empty LD project (2026-07-16). 617 flags landed on the first pass; two
migrate behaviors only visible at scale caused the gap and made recovery
awkward.

---

## Finding 1 — a failed flag *create* is dropped silently; summary still says success

**File:** `src/scripts/launchdarkly-migrations/migrate_between_ld_instances.ts`

**What happened.** One flag (`seed-bulk-0118`) hit a transient LaunchDarkly
`500` on its create POST, exhausted retries, and was never created. The run
still printed:

```
📊 MIGRATION SUMMARY
No conflicts encountered during migration.
✓ Migration complete successfully
```

617 of 618 flags landed, but nothing in the output said a flag was missing —
it was only found by diffing the destination flag count against the source.

**Root cause.** The flag-create path logs the error and breaks *without*
recording the flag:

```ts
} else {
  // Real error
  console.log(Colors.red(`\t✗ Error ${flagResp.status}`));   // ~L1531
  const errorText = await flagResp.text();
  console.log(Colors.red(`\t  ${errorText}`));
  break; // Exit loop on non-conflict errors
}
```

`flagCreated` stays `false`, so the env-patching block (`if (flagCreated)`) is
skipped and the flag silently vanishes. Contrast the flag-level *update* path,
which **does** record failures (`flagsWithErrors.add(createdFlagKey)`, ~L1614)
so `printErrorsSection` (~L1795) surfaces them. The create path never calls
`flagsWithErrors.add(...)`, so a create failure is invisible to both the
"FLAGS WITH ERRORS" section and the final status.

**Impact.** At small scale you'd likely notice; at 600+ flags under heavy
throttling, a single transient `5xx` drops a flag with a green "complete
successfully". Silent data loss.

**Fix options.**
1. In the create-error branch, `flagsWithErrors.add(flagKey)` before `break`,
   so the existing error section + status reporting pick it up.
2. Make the final status/exit code reflect `flagsWithErrors.size` (non-zero →
   non-zero exit, or at least a loud "N flag(s) failed to create" line).
3. Add a post-migration reconciliation: compare source flag count vs
   destination and report any missing keys.

Recommend 1 + 2 (cheap, uses existing machinery), with 3 as a belt-and-braces
check for large migrations.

---

## Finding 2 — `--include-flags <key>` can't locate `<index>-<key>.json` source files

**Files:** migrate flag-file resolver + `source_from_split.ts` file naming
(the Split extract writes `data/.../flags/<index>-<key>.json`).

**What happened.** To recover the one dropped flag without re-running the whole
migration (and tripping the overwrite bug on the other 617), I ran:

```
deno task migrate -p split-hardcore -d split-hardcore -s false \
  --include-flags seed-bulk-0118
```

It failed to find the source file, probing only:

```
flags/0-seed-bulk-0118.json           # index guessed as 0
flags/0.json
flags/seed-bulk-0118-<sha256>.json     # sha-suffixed name
flags/seed-bulk-0118.json              # plain key
```

The actual file is `flags/481-seed-bulk-0118.json` (index 481 in
`flags.json`). The resolver tries index `0`, a SHA-suffixed name, and the plain
key — but **not the flag's real index** from `flags.json`. So targeted
re-migration of a single flag by key is effectively broken whenever the flag
isn't at index 0.

**Workaround used.** Copied `481-seed-bulk-0118.json` → `seed-bulk-0118.json`
(the plain-key name the resolver *does* try), re-ran `--include-flags`, got the
flag created, then removed the copy. Final count: 618/618.

**Fix options.**
1. When resolving `--include-flags <key>`, look the key up in `flags.json` to
   get its real index, then read `<index>-<key>.json` directly.
2. Or index the flags directory once (map key → filename) instead of guessing
   name permutations.

Recommend 1 — `flags.json` already carries the ordered key list the filenames
are derived from.

---

## Not bugs (expected, already known)

- `seed-acct-segment` migrated with 0 members — its 5 keys failed to seed in
  Split (custom-traffic-type `uploadKeys` 404); faithful to source.
- Prerequisites absent — Split rejected the `IN_SPLIT` writes on the trial org
  (`400`), so none existed to import.
- 1,931 rate-limit waits were all absorbed by the client's backoff — no
  failures from throttling. The single `500` was a server-side blip, unrelated.

## What worked well at scale

All 600 bulk flags mapped to FULL/PARTIAL (zero MANUAL), the 10k big-segment
chunked into 1500-op batches, and the create path into an empty project stayed
free of the overwrite bug — the migration handled the volume correctly apart
from the two gaps above.
