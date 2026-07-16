# Split → LaunchDarkly Migration — Fix Plan

Remediation plan for issues found during an end-to-end smoke test of the
Split→LD migration (seed → extract → dry-run → wet-run → verify) run on
2026-07-14 against a **trial-tier Split org** and a fresh LD project
(`split-migration-test`).

The pipeline itself passed: 18 flags, 7 segments, 1 context kind, a 10k-member
segment, matcher translation, 1500-op batch chunking, prereq ordering, and 429
backoff all worked, with `check-report` green (13/13 asserted). The items below
are gaps in **documentation accuracy**, **failure-mode UX**, and the **seed
harness's ability to exercise high-risk paths on a trial org** — not defects in
the core migration writes.

## Branches

| Repo | Branch | Base |
|------|--------|------|
| `ld-migration-scripts` | `split-migration-fixes` | `split-migration` |
| `ps-seed-harness-split-account-with-data` | `trial-tier-coverage-fixes` | `main` |

---

## Fix 1 — Document the real trial-tier coverage gaps (docs)

**Repo:** `ld-migration-scripts` · **File:**
`src/scripts/third-party-migrations/split-readme.md` (§ "Smoke-test coverage
caveats", ~L146–162)

**Problem.** The section lists only **two** un-exercised paths (large segments,
oversized standard segments). The trial org actually could not seed *many* of
the highest-value translations, so they remain untested against live data:

- `IN_SPLIT` → **prerequisite** (in-split-matcher probe → `400`)
- **3-treatment multivariate** (`splitTreatments limit=2`)
- **`trafficAllocation` < 100** (`402`)
- **flag sets** (`402` on `/internal/api/v3/flag-sets`)
- **semver / set matchers** — `EQUAL_SET`, `PART_OF_SET`, semver-between (`400`)
- reserved-word **`kind` traffic type** (`trafficTypes limit=2`)
- **large segments** (`402`)

**Fix.** Replace the two-bullet caveat list with the full enumeration above,
grouped as "paywall-gated" vs "rejected by the trial API". State plainly that
prerequisite mapping, multivariate>2, semver/set matchers, traffic allocation,
flag sets, and large segments are **unit-tested only** and must be validated
against a paid/Enterprise Split org. Cross-link the `check-report` "relaxed"
output as the source of truth for what a given run did/didn't exercise.

**Verify.** Docs-only; re-read for accuracy against this run's `check-report`
output (11 relaxed expectations).

---

## Fix 2 — Distinguish paywall (402) from malformed (400) in seed probes

**Repo:** `ps-seed-harness-split-account-with-data`
**Files:** `src/seed.ts` (`isProbeRejection`, L79; probe recording ~L462),
`src/check_report.ts` (`probeAccepted`, L46–60), `src/split_client.ts`
(`SplitApiError`, already exposes `isPaywall`/`isConflict`, L48–65)

**Problem.** `isProbeRejection` treats *every* non-conflict 4xx identically, and
`check-report` relaxes any not-`accepted` probe the same way. So a genuine
`400 Invalid json structure` (e.g. `all-keys-matcher`, `semver-*`) — which
signals the harness may be sending a request shape the current Split API
rejects — is silently relaxed as if it were an expected plan limit. This masks
a potential real payload bug behind a "coverage caveat".

**Fix.**
1. In `seed.ts`, when recording a rejected probe, classify the reason using the
   already-available `SplitApiError` getters: `paywall:` (`isPaywall`),
   `malformed:` (status 400 && !isPaywall && !isConflict), else `error:`.
   Store that prefix in `manifest.probes[id]` (today it's a free-form
   `rejected: …` string — keep the detail, prepend the class).
2. In `check_report.ts`, keep auto-relaxing `paywall:`/`skipped` probes, but for
   `malformed:` probes print a **loud warning** ("probe X rejected with 400 —
   the seed payload may be stale vs the current Split API; investigate rather
   than assume a plan limit") and consider a non-zero exit under a
   `--strict` flag.

**Verify.** Re-run `deno task seed` then `deno task check-report`; confirm
paywall probes still relax quietly and the `400` probes (`all-keys-matcher`,
`semver-*`) now surface as warnings. Separately, re-check the `all-keys` and
`semver` request bodies against current Split Admin API docs — a `400` on the
most basic matcher is suspicious.

---

## Fix 3 — Correct the `deno task -- ` guidance mismatch

**Repo:** `ps-seed-harness-split-account-with-data`
**Files:** `src/main.ts:148` (printed "Next" hint), `README.md` (L26–49)

**Problem.** `main.ts:148` prints
`deno task source-from-split -- -w "…"` — but the migration repo's readme
correctly documents that a literal `--` breaks arg parsing on Deno ≥2.4.5
(confirmed on 2.6.0: running `source-from-split` *without* `--` parsed cleanly;
the `--` form would forward a literal `--` to the script). The seed repo hands
the user a command that fails.

**Fix.**
1. `main.ts:148`: drop the `--` from the printed `source-from-split` hint.
2. Add a one-line note in seed `README.md` that the seed repo's own tasks accept
   `--`, but `source-from-split` in `ld-migration-scripts` must be run
   **without** it.
3. (Optional hardening, `ld-migration-scripts`) have the source/migrate CLIs
   strip a single leading `--` token before yargs parsing, so both forms work
   and this class of confusion disappears.

**Verify.** Run the exact command `main.ts` prints; it should parse and extract
without error.

---

## Fix 4 — `migrate` preflight: fail fast on a bad destination key

**Repo:** `ld-migration-scripts`
**File:** `src/scripts/launchdarkly-migrations/migrate_between_ld_instances.ts`
(`checkProjectExists`, L180; members/me block, L332–345; project gate, L537–541)

**Problem.** `checkProjectExists` returns `false` for **any** non-200, so an
invalid/expired key (401) makes migrate report *"Destination project does not
exist"* even when it does — a misleading error. The `members/me` call at L333
is wrapped in try/catch and a non-200 is treated as "service token", so a dead
key is never surfaced as an auth failure. (Observed live: the key committed in
`config/api_keys.json` was stale and returned 401 on every endpoint.)

**Fix.**
1. Add an explicit preflight right after the key loads (before any writes):
   `GET members/me` → on 401/403, exit with
   *"Destination API key is invalid or lacks access — check
   `destination_account_api_key`."*
2. Make `checkProjectExists` distinguish `404` (missing project → current
   message) from `401/403` (auth → the message above), so the two failure modes
   never get conflated.

**Verify.** Run `migrate --dry-run` with (a) a bad key and (b) a valid key but
missing project; confirm each prints the correct, distinct message and exits
before attempting writes.

---

## Fix 5 — Emit a fidelity note when a flag maps to nothing

**Repo:** `ld-migration-scripts`
**File:** `src/scripts/third-party-migrations/source_from_split.ts`
(fidelity ledger ~L419–457; per-flag mapping loop)

**Problem.** `seed-prereq-strict` / `seed-prereq-dependency` produced empty LD
prerequisites with **zero** notes in `split-fidelity-report.json`. In this run
the Split source genuinely had no rules (the `IN_SPLIT` matcher never seeded, by
design of the trial gap), so "nothing to map" was correct — but a flag whose
Split definition *did* carry rules/dependencies that all got dropped would
disappear with no trace.

**Fix.** In the mapping loop, when a source flag/environment had ≥1 Split
rule/dependency but the resulting LD flag has none, record an `INFO`/`PARTIAL`
note ("Split flag had N rule(s)/dependency(ies); none were expressible in LD").
Leave the genuinely-empty case (no source rules) silent to avoid noise.

**Verify.** Craft a fixture flag with a rule that maps to nothing (unit test);
assert a note is emitted. Confirm this run's genuinely-empty prereq flags stay
note-free.

---

## Fix 6 (optional) — Hardcore 800-flag scale test

**Repo:** `ps-seed-harness-split-account-with-data` (dataset generation)

**Goal.** Stress the migrate path's throughput, 429 backoff, and 1500-op
chunking at scale by generating ~800 boolean flags in Split, then running a full
extract + migrate.

**Approach.** Add a `--bulk-flags <N>` option to the seed harness that appends N
minimal `seed-bulk-<i>` boolean flags (single env, no advanced matchers to dodge
trial paywalls), tagged `ld-mig-seed` so teardown still catches them. Re-run
extract → migrate → verify flag count == N + baseline. Watch wall-clock and
rate-limit waits (this run already hit proactive waits at 18 flags).

**Verify.** LD flag count matches; no failed writes; teardown removes all bulk
flags.

---

## Suggested sequencing

1. Fixes 1 & 3 (docs) — zero-risk, immediate accuracy wins.
2. Fix 4 (migrate preflight) — best UX payoff, self-contained.
3. Fix 2 (probe 400/402 classification) — unblocks trusting `check-report`.
4. Fix 5 (fidelity note) — small, needs a unit fixture.
5. Fix 6 (scale test) — optional, run once the above land.
