# Custom LaunchDarkly role for migration (read source, write destination)

Use a **custom role** when you want a single API key (or member) to have:

- **Read-only** access to a **source project** (flags, segments, etc.)
- **Write** access to a **destination project** (create/update flags, segments)

This policy uses only [valid role-actions](https://launchdarkly.com/docs/home/account/roles/role-actions). There is no member-read action, but reading the member list (used by **map-members**) worked with this role in testing.

This is useful for same-account migrations or when you prefer one token with least-privilege scoping instead of separate Reader and Writer keys.

## Overview

LaunchDarkly custom roles are defined by **policies**: JSON arrays of statements with `effect`, `actions`, and `resources`. The policy below covers everything the **ld-migration-scripts** workflow uses:

| Workflow step / script | Source | Destination / account |
|------------------------|--------|------------------------|
| **extract-source** | Project, environments, flags, segments, views (read); big segment export (`migrateBigSegments`) | — |
| **map-members** | Members (read) | Members (read) |
| **migrate** | — | Project, environments, flags, segments, **views**, **approval-requests** (read + write) |
| **revert** | — | Flags, views, approval-requests (read, patch, delete) |

Resource specifiers are hierarchical, e.g. `proj/<projectKey>:env/<envKey>:flag/<flagKey>`. Use `*` for “all” at any level.

## 1. Create the custom role

**Finding your project keys:** In LaunchDarkly, open the **source** and **destination** projects. The project key is in the browser URL (e.g. `https://app.launchdarkly.com/my-org/projects/my-project-key/...`) or in **Project settings** (gear or **Settings** in the project sidebar). You need both the source and destination project keys for the policy in section 2.

1. In LaunchDarkly: **Account settings** → **Team** → **Roles** → **Create role**.
2. Name it (e.g. `Migration: read source, write destination`).
3. Add policies via **Advanced editor** (or the policy builder) using the JSON below.

## 2. Policy JSON

The policy is in [`examples/roles/migration-role.json`](../examples/roles/migration-role.json). Replace `SOURCE_PROJECT_KEY` and `DEST_PROJECT_KEY` with your project keys, for example:

```bash
sed -e 's/SOURCE_PROJECT_KEY/my-source-project/g' -e 's/DEST_PROJECT_KEY/my-dest-project/g' examples/roles/migration-role.json
```

Paste the output into the role's **Advanced editor**. **Docs on roles and role actions:** see the [role-actions reference](https://launchdarkly.com/docs/home/account/roles/role-actions).

```json
[
  {
    "effect": "allow",
    "resources": [
      "proj/SOURCE_PROJECT_KEY"
    ],
    "actions": [
      "viewProject"
    ]
  },
  {
    "effect": "allow",
    "resources": [
      "proj/SOURCE_PROJECT_KEY:env/*:segment/*"
    ],
    "actions": [
      "createSegmentExport"
    ]
  },
  {
    "effect": "allow",
    "resources": [
      "proj/SOURCE_PROJECT_KEY:view/*"
    ],
    "actions": [
      "viewView"
    ]
  },
  {
    "effect": "allow",
    "resources": [
      "proj/DEST_PROJECT_KEY"
    ],
    "actions": [
      "viewProject"
    ]
  },
  {
    "effect": "allow",
    "resources": [
      "proj/DEST_PROJECT_KEY:env/*:flag/*"
    ],
    "actions": [
      "createFlag",
      "updateName",
      "updateOn",
      "updateDescription",
      "updateIncludeInSnippet",
      "updateClientSideFlagAvailability",
      "updateTemporary",
      "updateTags",
      "updateDeprecated",
      "updatePrerequisites",
      "updateTargets",
      "updateRules",
      "updateFlagRuleDescription",
      "updateFallthrough",
      "updateFlagVariations",
      "updateFlagDefaultVariations",
      "updateOffVariation",
      "updateMaintainer",
      "updateAttachedGoals",
      "updateExperimentActive",
      "updateExperimentBaseline",
      "updateFlagCustomProperties",
      "updateFlagSalt",
      "updateTrackEvents",
      "updateFlagFallthroughTrackEvents",
      "updateGlobalArchived",
      "updateExpiringTargets",
      "updateFeatureWorkflows",
      "updateScheduledChanges",
      "updateTriggers",
      "updateApprovalRequest",
      "updateFlagLink",
      "updateFlagCodeReferences",
      "updateReleasePhaseCompleted",
      "updateReleasePhaseStatus",
      "updateFlagConfigMigrationSettings",
      "updateMeasuredRolloutConfiguration",
      "updateFallthroughWithMeasuredRollout",
      "updateRulesWithMeasuredRollout",
      "createExperiment",
      "createTriggers",
      "createApprovalRequest",
      "createFlagLink",
      "deleteFlag",
      "deleteFlagLink",
      "deleteTriggers",
      "removeReleasePipeline",
      "deleteFlagAttachedGoalResults"
    ]
  },
  {
    "effect": "allow",
    "resources": [
      "proj/DEST_PROJECT_KEY:env/*:segment/*"
    ],
    "actions": [
      "createSegment",
      "updateName",
      "updateDescription",
      "updateTags",
      "updateIncluded",
      "updateExcluded",
      "updateRules",
      "createApprovalRequest",
      "updateExpiringTargets",
      "updateScheduledChanges",
      "deleteSegment"
    ]
  },
  {
    "effect": "allow",
    "resources": [
      "proj/DEST_PROJECT_KEY:view/*"
    ],
    "actions": [
      "viewView",
      "createView",
      "updateView",
      "linkFlagToView",
      "linkSegmentToView"
    ]
  }
]
```

| Statement | Grants |
|-----------|--------|
| `proj/SOURCE_PROJECT_KEY` → `viewProject` | Read the source project, its flags and segments |
| `proj/SOURCE_PROJECT_KEY:env/*:segment/*` → `createSegmentExport` | Export big segment members as CSV (`migrateBigSegments`). Starts an export job; does not change the segment. Drop it if you don't migrate big segments. |
| `proj/SOURCE_PROJECT_KEY:view/*` → `viewView` | Read views. Without it the views list silently returns 0 and no views are migrated. |
| `proj/DEST_PROJECT_KEY` → `viewProject` | Read the destination project |
| `proj/DEST_PROJECT_KEY:env/*:flag/*` | Create and update flags (and delete, for **revert**) |
| `proj/DEST_PROJECT_KEY:env/*:segment/*` | Create and update segments, including big segment imports (`updateIncluded`) |
| `proj/DEST_PROJECT_KEY:view/*` | Create views and link flags and segments to them |

- **Each statement** covers one resource kind only, so the policy satisfies LaunchDarkly's "same kind of resource" rule per statement.
- **Source access is read-only**, apart from `createSegmentExport`. All writes are scoped to the destination project.
- **Not covered:** creating projects or environments. Create the destination project and its environments before migrating.

## 3. Assign the role

- **API access token:** Create an access token and assign this custom role to it (e.g. under **Account settings** → **Authorization** → **Access tokens**). Use that token as the API key for both source and destination in this repo’s config when migrating within one account. Use role custom, and the named role to apply to this specific key.

## 4. For use with [launchdarkly-labs/ld-migration-scripts](https://github.com/launchdarkly-labs/ld-migration-scripts)

- **Same-account migration:** In `config/api_keys.json`, set both `source_account_api_key` and `destination_account_api_key` to the same token that has this custom role (with `SOURCE_PROJECT_KEY` and `DEST_PROJECT_KEY` set as above).
- **Two accounts:** Keep using two keys (source = Reader or custom read-only, destination = Writer or custom write-only). You can still use a custom role on each account that matches the same read vs write pattern per project.

## References

- [Custom roles](https://launchdarkly.com/docs/home/account/custom-roles)
- [Creating roles and policies](https://launchdarkly.com/docs/home/account/roles/role-create)
- [Role actions](https://launchdarkly.com/docs/home/account/roles/role-actions)
- [Role resources](https://launchdarkly.com/docs/home/account/role-resources)
