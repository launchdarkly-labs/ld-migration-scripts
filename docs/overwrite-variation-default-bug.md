# Bug: overwrite of an existing flag fails on `Cannot delete the default on variation`

**Status:** documented, not yet fixed.
**Branch:** `fix-overwrite-variation-default-patch` (cut from `main`).
**Scope:** `main` and every branch cut from it (LD→LD *and* third-party
migrations). This is core migrate logic, upstream of any Split-specific code.

---

## Summary (plain language)

Re-running a migration into a project where the flags **already exist** fails
to update those flags. The first migration into an empty project works fine —
the flags are *created* in one shot. The failure only appears on the second
run, when the tool tries to *update* a flag that's already there.

For each already-existing flag whose variations differ from the source, the
run logs:

```
⚠ Flag-level update failed (400): {"code":"invalid_request","message":"Cannot delete the default on variation"}
```

The flags are **not** corrupted or deleted — they simply don't get updated.

## Root cause

`src/scripts/launchdarkly-migrations/migrate_between_ld_instances.ts`, in the
"flag already existed" branch (`if (flagAlreadyExisted && destinationFlag)`,
~L1570), builds a **plain JSON Patch** with two independent ops when variations
changed (~L1597–1602):

```ts
if (newVariations?.length > 0 && changed(newVariations, destVarsClean)) {
  flagLevelPatches.push(buildPatch("variations", "replace", newVariations)); // op 1
  if (flag.defaults) flagLevelPatches.push(buildPatch("defaults", "replace", flag.defaults)); // op 2
}
```

LaunchDarkly applies JSON-Patch ops **sequentially, validating each in order**.
When op 1 replaces the whole `/variations` array, the flag's existing
`defaults.onVariation` (and the per-environment on/off/fallthrough variations)
still reference the *old* default variation that the replace would remove. LD
rejects op 1 with `Cannot delete the default on variation` — and never reaches
op 2, which was intended to repoint `/defaults`. The inline comment
("Variations and defaults must be patched together to avoid index conflicts")
shows the coupling was known, but a plain JSON Patch does not apply the two ops
atomically the way the author assumed.

Two contributing factors:

1. **No atomicity.** `defaults` can only be safely changed *before or together
   with* removing the variation it points at; sequential JSON-Patch ops can't
   guarantee that ordering against LD's validator.
2. **Over-eager change detection.** `changed()` (~L1572) is a `JSON.stringify`
   inequality. Source vs destination variations differ in incidental ways
   (field ordering, an optional `name`, value serialization), so the guard
   reports "changed" and triggers the variations replace even when the
   variations are semantically identical — meaning the risky patch fires far
   more often than it needs to.

## Reproduction

1. Migrate any source into an empty destination project → succeeds (flags
   created via POST).
2. Run the *same* migration again with `--on-conflict overwrite` → every flag
   whose variations "changed" fails with the 400 above.

Observed live on 2026-07-14 migrating `split-seed` into `split-migration-test`
a second time: all 18 flags failed the flag-level update; flag count stayed 18
(intact, just not re-updated).

## Fix options (to be decided — see open question below)

1. **Semantic patch (preferred).** Send the variation/defaults change as a
   LaunchDarkly *semantic* patch
   (`Content-Type: application/json; domain-model=launchdarkly.semanticpatch`)
   using the appropriate instructions (e.g. `updateVariations` / add/remove/
   reorder + set default), which LD applies atomically. The file already has a
   `convertToSemanticPatch` helper (~L1417) used for env-level patches, so the
   machinery exists to build on.
2. **Reorder the plain-patch ops / update defaults first.** Point `/defaults`
   (and any env on/off/fallthrough references) at a variation index that will
   survive *before* replacing `/variations`. Fiddly and easy to get wrong when
   the variation set shrinks.
3. **Tighten `changed()` so identical variations don't trigger a replace.**
   Compare normalized variations (sorted keys, coerced value types). This alone
   reduces how often the bug fires but does **not** fix the genuine case where
   variations really did change — so it's a complement, not a standalone fix.

Recommended: (1) as the real fix, with (3) as a cheap guard to avoid
unnecessary patches. Add a regression test that migrates a flag, changes its
variations/defaults in the source, and re-migrates with `--on-conflict
overwrite`, asserting the update succeeds.

## ⚠️ Open question — confirm expected behavior before implementing

We need to decide/confirm what an overwrite **should** do to a flag whose
variations changed, because there is real product nuance here:

- **Is changing an existing flag's variation set even desirable on re-migrate?**
  Removing/reordering variations on a *live* flag can silently repoint
  targeting rules, rollouts, prerequisites, and the off variation. "Make it
  match the source" may not be what an operator wants on a second run.
- **What should happen when the source has fewer variations than the
  destination** (a variation currently serving traffic would be removed)? Fail
  loudly? Skip with a warning? Require an explicit `--force-variations` flag?
- **Should variation changes be in scope for `overwrite` at all**, or should
  `overwrite` only reconcile targeting/rules and leave the variation *shape*
  alone (treating a changed variation set as a MANUAL follow-up)?
- **Idempotency expectation:** re-running an unchanged migration should be a
  clean no-op. Fixing `changed()` (option 3) is required for that regardless of
  the larger decision.

Resolve these before writing the fix — the safest implementation depends on
which behavior we intend, not just on making the 400 go away.
