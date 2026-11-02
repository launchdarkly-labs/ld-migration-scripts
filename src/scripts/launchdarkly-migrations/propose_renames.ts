// deno-lint-ignore-file no-explicit-any
/**
 * Proposes new keys and names for a project's flags and writes them to an editable CSV.
 * Review and edit the file, then pass it to the migration with --rename-map. Segments are not renamed.
 *
 *   deno task propose-renames -p <source-project> [--out file.csv] [--namer module.ts] [--force]
 *
 * Reads the data extracted by source-from-ld; makes no API calls.
 */

import yargs from "https://deno.land/x/yargs@v17.7.2-deno/deno.ts";
import { stringify } from "https://deno.land/std@0.224.0/csv/mod.ts";
import { dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import {
  buildRenameMap,
  type RenameRow,
  validateRenameMapStatic,
} from "../../utils/renames.ts";
import {
  loadNamer,
  type RenameCandidate,
  type RenameProposal,
} from "../../utils/renames_namer.ts";
import {
  readExtractedFlag,
  readExtractedFlagKeys,
  sourceProjectPath,
} from "../../utils/source_data.ts";

const args: any = yargs(Deno.args)
  .alias("p", "project")
  .string("project")
  .demandOption("project")
  .string("out")
  .string("namer")
  .boolean("force")
  .describe(
    "project",
    "Source project key (its data must already be extracted)",
  )
  .describe(
    "out",
    "Output CSV (default data/launchdarkly-migrations/renames/<project>-renames.csv)",
  )
  .describe(
    "namer",
    "Module whose default export proposes names (default: <purpose>-<area>-<behavior>)",
  )
  .describe(
    "force",
    "Overwrite an existing output file (it may hold reviewers' edits)",
  )
  .parse();

const project: string = args.project;
const out: string = args.out ??
  `data/launchdarkly-migrations/renames/${project}-renames.csv`;

if (!args.force) {
  try {
    await Deno.stat(out);
    console.error(
      `${out} already exists and may hold reviewers' edits. Use --force to overwrite, or --out for a new file.`,
    );
    Deno.exit(1);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

const projPath = sourceProjectPath(project);
const namer = await loadNamer(args.namer);

const valueType = (flag: any): string | undefined => {
  if (flag.kind !== "multivariate") return undefined;
  const v = flag.variations?.[0]?.value;
  return v === null || typeof v === "object" ? "json" : typeof v;
};

interface Proposed {
  candidate: RenameCandidate;
  proposal: RenameProposal | null;
}

const proposed: Proposed[] = [];

const flagKeys = await readExtractedFlagKeys(projPath);
for (const [index, key] of flagKeys.entries()) {
  const flag = await readExtractedFlag(projPath, index, key);
  if (!flag) {
    console.warn(`  ⚠ No extracted data for flag ${key}; skipped`);
    continue;
  }
  const candidate: RenameCandidate = {
    type: "flag",
    key,
    name: flag.name ?? key,
    description: flag.description || undefined,
    tags: flag.tags ?? [],
    kind: flag.kind,
    valueType: valueType(flag),
  };
  proposed.push({ candidate, proposal: await namer(candidate, { project }) });
}

// Two proposals landing on one key would fail validation; number the later ones so reviewers decide
const used = new Set(flagKeys);
for (const p of proposed) {
  const newKey = p.proposal?.key;
  if (!newKey || newKey === p.candidate.key) continue;
  let candidate = newKey;
  for (let n = 2; used.has(candidate); n++) candidate = `${newKey}-${n}`;
  if (candidate !== newKey) {
    p.proposal = {
      ...p.proposal,
      key: candidate,
      note: [p.proposal?.note, `"${newKey}" was taken`].filter(Boolean).join(
        "; ",
      ),
    };
  }
  used.add(candidate);
}

// Validate the proposals the way the migration will, and put any problem next to its row
const rows: RenameRow[] = proposed.map((p, i) => ({
  type: p.candidate.type,
  key: p.candidate.key,
  newKey: p.proposal?.key && p.proposal.key !== p.candidate.key
    ? p.proposal.key
    : undefined,
  newName: p.proposal?.name && p.proposal.name !== p.candidate.name
    ? p.proposal.name
    : undefined,
  line: i + 2,
}));
const { map } = buildRenameMap(rows, out);
const issues = validateRenameMapStatic(map, { flagKeys });
const issuesByLine = new Map<number, string[]>();
for (const i of issues) {
  if (i.line) {
    issuesByLine.set(i.line, [...(issuesByLine.get(i.line) ?? []), i.message]);
  }
}

const csv = stringify(
  proposed.map((p, i) => ({
    type: p.candidate.type,
    key: p.candidate.key,
    new_key: rows[i].newKey ?? "",
    new_name: rows[i].newName ?? "",
    name: p.candidate.name,
    description: p.candidate.description ?? "",
    tags: p.candidate.tags.join("|"),
    note: p.proposal?.note ?? "",
    issues: (issuesByLine.get(i + 2) ?? []).join("; "),
  })),
  {
    columns: [
      "type",
      "key",
      "new_key",
      "new_name",
      "name",
      "description",
      "tags",
      "note",
      "issues",
    ],
  },
);

await Deno.mkdir(dirname(out), { recursive: true });
await Deno.writeTextFile(out, csv);

const renamed = rows.filter((r) => r.newKey).length;
const needReview = proposed.filter((p) => p.proposal?.note).length;
console.log(`Wrote ${proposed.length} row(s) to ${out}`);
console.log(
  `  ${renamed} new key(s) proposed, ${needReview} row(s) with notes to review, ${issues.length} validation issue(s)`,
);
console.log(
  "Review the file, then pass it to the migration with --rename-map.",
);
