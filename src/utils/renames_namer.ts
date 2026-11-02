/**
 * Namers propose new flag keys and names for `propose-renames`. A proposal is only a suggestion: people review
 * and edit the CSV before the migration reads it.
 *
 * The default namer follows the convention <purpose>-<area>-<behavior>, e.g. Allow-blueprint-seamless-learning.
 * Swap it with `--namer <module>`: a module whose default (or `namer`) export is a Namer.
 */

import { resolve, toFileUrl } from "https://deno.land/std@0.224.0/path/mod.ts";
import type { RenameType } from "./renames.ts";

export interface RenameCandidate {
  type: RenameType;
  key: string;
  name: string;
  description?: string;
  tags: string[];
  /** Flags: "boolean" | "multivariate" */
  kind?: string;
  /** Flags: the variation values' type when not boolean, e.g. "string", "json", "number" */
  valueType?: string;
}

export interface RenameProposal {
  key?: string;
  name?: string;
  /** Why a proposal needs a person's attention; several notes are joined with "; " */
  note?: string;
}

export type Namer = (
  item: RenameCandidate,
  ctx: { project: string },
) => RenameProposal | null | Promise<RenameProposal | null>;

export const keepUnchanged: Namer = () => null;

export async function loadNamer(path?: string): Promise<Namer> {
  if (!path) return purposeAreaBehavior;
  const mod = await import(toFileUrl(resolve(path)).href);
  const namer = mod.default ?? mod.namer;
  if (typeof namer !== "function") {
    throw new Error(
      `${path} must export a namer function as its default export or as "namer"`,
    );
  }
  return namer as Namer;
}

// ==================== <purpose>-<area>-<behavior> ====================

interface PurposeRule {
  purpose: string;
  /** Matched against the words (and adjacent word pairs) of key, name, description and tags */
  words: string[];
}

/** Checked in order; the first match wins (a kill switch described as "disable" is Kill, not Enable). */
const FLAG_PURPOSES: PurposeRule[] = [
  {
    purpose: "Kill",
    words: [
      "kill",
      "killswitch",
      "kill switch",
      "circuit breaker",
      "disable",
      "disabled",
      "turn off",
    ],
  },
  {
    purpose: "Experiment",
    words: [
      "experiment",
      "experiments",
      "a b",
      "ab test",
      "variant",
      "variants",
      "bucketing",
      "bucket",
    ],
  },
  {
    purpose: "Release",
    words: ["release", "releases", "rollout", "roll out", "launch", "gate"],
  },
  {
    purpose: "Allow",
    words: [
      "allow",
      "allowed",
      "access",
      "permit",
      "permission",
      "entitle",
      "entitlement",
      "beta",
      "early access",
    ],
  },
  { purpose: "Show", words: ["show", "hide", "display", "visual", "ui"] },
  { purpose: "Enable", words: ["enable", "enabled", "turn on", "advanced"] },
  {
    purpose: "Config",
    words: [
      "config",
      "configuration",
      "setting",
      "settings",
      "limit",
      "limits",
    ],
  },
];

/** Words that never make a good area or behavior */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "of",
  "for",
  "to",
  "in",
  "on",
  "by",
  "with",
  "is",
  "are",
  "be",
  "this",
  "that",
  "it",
  "flag",
  "flags",
  "feature",
  "features",
  "new",
  "test",
  "tests",
  "testing",
  "demo",
  "temp",
  "tmp",
  "used",
  "use",
  "server",
  "side",
  "client",
  "only",
  "when",
  "via",
  "how",
  "from",
  "all",
  "its",
  "can",
  "will",
  "should",
  "ld",
  "launchdarkly",
  "showing",
  "switch",
  "operational",
  "immediately",
  "overall",
  "full",
  "stack",
  "portion",
  "depends",
  "control",
  "controls",
  "controlling",
  "served",
  "true",
  "false",
  "during",
  "holds",
]);

/** Purpose words that are the verb itself and so are dropped from area/behavior; descriptive matches (premium, beta, visual, advanced, bucketing) stay */
const PURPOSE_VERBS = new Set([
  "kill",
  "killswitch",
  "disable",
  "disabled",
  "release",
  "releases",
  "rollout",
  "launch",
  "experiment",
  "experiments",
  "allow",
  "allowed",
  "permit",
  "show",
  "hide",
  "display",
  "enable",
  "enabled",
  "config",
  "configuration",
  "block",
  "blocked",
  "exclude",
  "excluded",
  "deny",
]);

const MAX_BEHAVIOR_WORDS = 4;
const MAX_KEY_LENGTH = 60;

/** Splits keys, names and sentences into lowercase words: "enableAdvancedStats" → enable, advanced, stats */
export function words(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

function matchPurpose(
  rules: PurposeRule[],
  text: string[],
): { rule: PurposeRule; matched: string[] } | undefined {
  const pairs = text.slice(0, -1).map((w, i) => `${w} ${text[i + 1]}`);
  const all = new Set([...text, ...pairs]);
  for (const rule of rules) {
    const matched = rule.words.filter((w) => all.has(w));
    if (matched.length > 0) {
      return {
        rule,
        matched: matched.flatMap((w) => w.split(" ")),
      };
    }
  }
  return undefined;
}

const capitalize = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const cleanWord = (w: string) => w.replace(/[^a-z0-9]/g, "");

/**
 * The default namer, <purpose>-<area>-<behavior>:
 * - purpose: from the key and name, then the description, then (multivariate) Config, and only then the
 *   tags; a tag never overrides a purpose the flag's own words give
 * - area and behavior: from the name (or key); tags never become part of the key
 */
export const purposeAreaBehavior: Namer = (item) => {
  const notes: string[] = [];
  const nameWords = [...new Set([...words(item.name), ...words(item.key)])];
  const descWords = words(item.description);
  const tagWords = item.tags.flatMap((t) => words(t));

  // Purpose: the flag's own words first; tags only when nothing else names one
  let found = matchPurpose(FLAG_PURPOSES, nameWords) ??
    matchPurpose(FLAG_PURPOSES, descWords);
  let purpose = found?.rule.purpose;
  if (
    !purpose && item.kind === "multivariate" &&
    item.valueType && item.valueType !== "boolean"
  ) {
    purpose = "Config";
  }
  if (!purpose) {
    found = matchPurpose(FLAG_PURPOSES, tagWords);
    purpose = found?.rule.purpose;
  }
  if (!purpose) {
    purpose = "Review";
    notes.push("purpose unclear");
  }
  const purposeWords = new Set([
    ...(found?.matched ?? []).filter((w) => PURPOSE_VERBS.has(w)),
    purpose.toLowerCase(),
  ]);
  const meaningful = (ws: string[]) =>
    ws.map(cleanWord).filter((w) =>
      w.length > 1 && !STOPWORDS.has(w) && !purposeWords.has(w) &&
      !/^\d+$/.test(w)
    );

  // Area: the first meaningful word of the name (tags are migrated as they are, never put in the key)
  const nameMeaningful = meaningful(
    words(item.name).length > 0 ? words(item.name) : words(item.key),
  );
  const area: string | undefined = nameMeaningful[0];

  // Behavior: the rest of the name, else the description; words that repeat the area (payment/payments) are dropped
  const notArea = (w: string) =>
    !area || (!area.startsWith(w) && !w.startsWith(area));
  let behavior = [...new Set(nameMeaningful.filter(notArea))].slice(
    0,
    MAX_BEHAVIOR_WORDS,
  );
  if (behavior.length === 0) {
    behavior = [...new Set(meaningful(descWords).filter(notArea))].slice(
      0,
      2,
    );
    if (behavior.length > 0) notes.push("behavior taken from description");
  }

  if (!area && behavior.length === 0) {
    return {
      key: `Review-${item.key}`,
      name: item.name,
      note: "needs a name: key and description say too little",
    };
  }
  if (behavior.length === 0) notes.push("behavior missing");

  const parts = [purpose, area, ...behavior].filter((p): p is string => !!p);
  const key = [capitalize(parts[0]), ...parts.slice(1)].join("-").slice(
    0,
    MAX_KEY_LENGTH,
  ).replace(/-+$/, "");
  const name = parts.map((p) => p.split("-").map(capitalize).join(" ")).join(
    " ",
  );
  return { key, name, note: notes.length > 0 ? notes.join("; ") : undefined };
};
