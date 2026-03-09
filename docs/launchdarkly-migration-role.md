# Custom LaunchDarkly role for migration (read source, write destination)

Use a **custom role** when you want a single API key (or member) to have:

- **Read-only** access to a **source project** (flags, segments, etc.)
- **Write** access to a **destination project** (create/update flags, segments)

This policy uses only [valid role-actions](https://launchdarkly.com/docs/home/account/roles/role-actions). It does not grant listing or viewing members (no such action exists in the Member actions reference); for **map-members** or **migrate**’s `members/me` fallback, use a token that also has a preset role (e.g. Reader) or accept limited behavior.

This is useful for same-account migrations or when you prefer one token with least-privilege scoping instead of separate Reader and Writer keys.

## Overview

LaunchDarkly custom roles are defined by **policies**: JSON arrays of statements with `effect`, `actions`, and `resources`. The policy below covers everything the **ld-migration-scripts** workflow uses:

| Workflow step / script | Source | Destination / account |
|------------------------|--------|------------------------|
| **extract-source** | Project, environments, flags, segments (read) | — |
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

Replace `SOURCE_PROJECT` and `DEST_PROJECT` with your actual project keys.

**Docs on roles and role actions:** The [role-actions reference](https://launchdarkly.com/docs/home/account/roles/role-actions) see more info on common roles and role-actions

```json
[
  {
    "resources": [
      "proj/${SOURCE_PROJECT}"
    ],
    "actions": [
      "viewProject"
    ],
    "effect": "allow"
  },
  {
    "resources": [
      "proj/${DEST_PROJECT}:env/*:flag/*"
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
    ],
    "effect": "allow"
  },
  {
    "resources": [
      "proj/${DEST_PROJECT}:env/*:segment/*"
    ],
    "actions": [
      "createSegment",
      "updateName",
      "updateDescription",
      "updateTags",
      "updateIncluded",
      "createApprovalRequest",
      "updateExcluded",
      "updateRules",
      "updateExpiringTargets",
      "updateScheduledChanges",
      "createSegmentExport",
      "deleteSegment"
    ],
    "effect": "allow"
  },
  {
    "resources": [
      "proj/${DEST_PROJECT}"
    ],
    "actions": [
      "viewProject"
    ],
    "effect": "allow"
  }
]
```

- **Each statement:** One resource kind only (env, flag, approvalRequest, segment, or view), so the policy satisfies “same kind of resource” per statement. Only destination project is granted; replace `DEST_PROJECT_KEY` with your destination project key.
- **Source:** This custom role does not grant source read (no valid view actions in one-resource-kind form for many instances). Use a preset Reader role or a separate source key for **extract-source**.
- **Destination:** Create/update environments, flags and segments, and allow deletion of flags and segments for revert feature.


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
