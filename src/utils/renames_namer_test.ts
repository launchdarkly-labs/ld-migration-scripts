import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  keepUnchanged,
  loadNamer,
  purposeAreaBehavior,
  type RenameCandidate,
  words,
} from "./renames_namer.ts";

const flag = (over: Partial<RenameCandidate>): RenameCandidate => ({
  type: "flag",
  key: "x",
  name: "x",
  tags: [],
  ...over,
});
const propose = (c: RenameCandidate) =>
  purposeAreaBehavior(c, { project: "p" }) as {
    key?: string;
    name?: string;
    note?: string;
  };

Deno.test("words splits keys, camelCase and sentences", () => {
  assertEquals(words("enableAdvancedStats"), ["enable", "advanced", "stats"]);
  assertEquals(words("Release: Checkout - Web"), [
    "release",
    "checkout",
    "web",
  ]);
  assertEquals(words("included/excluded"), ["included", "excluded"]);
});

Deno.test("purposeAreaBehavior builds <purpose>-<area>-<behavior> with a Title Case name", () => {
  assertEquals(
    propose(
      flag({
        key: "release-checkout-web",
        name: "Release: Checkout - Web",
        tags: ["checkout", "frontend", "release"],
      }),
    ),
    {
      key: "Release-checkout-web",
      name: "Release Checkout Web",
      note: undefined,
    },
  );
  assertEquals(
    propose(flag({ key: "enableAdvancedStats", name: "Enable Advanced Stats" }))
      .key,
    "Enable-advanced-stats",
  );
});

Deno.test("purposeAreaBehavior picks the first matching purpose and falls back to the description", () => {
  const p = propose(flag({
    key: "disable-payments",
    name: "disable-payments",
    description:
      "Operational kill switch used to immediately disable payment processing",
  }));
  assertEquals(p.key, "Kill-payments-processing");
  assertEquals(p.note, "behavior taken from description");
});

Deno.test("purposeAreaBehavior marks unclear flags for review", () => {
  assertEquals(
    propose(flag({ key: "flag-1", name: "flag-1" })).key,
    "Review-flag-1",
  );
  assertEquals(
    propose(flag({ key: "widget-test", name: "widget-test" })).note,
    "purpose unclear; behavior missing",
  );
});

Deno.test("purposeAreaBehavior never puts a tag in the key", () => {
  const c = flag({
    key: "freeformComponent",
    name: "freeformComponent",
    tags: ["ocean", "team-rocket"],
  });
  assertEquals(propose(c).key, "Review-freeform-component");
  assertEquals(
    propose(flag({
      key: "show-new-visual-feature",
      name: "Show New Visual Feature",
      tags: ["payments"],
    })).key,
    "Show-visual",
  );
});

Deno.test("purposeAreaBehavior: the flag's own words pick the purpose; tags only when they give none", () => {
  // "ui" (Show) is checked before "enable" in the purpose list, but the key's own word wins
  assertEquals(
    propose(flag({
      key: "enable-sftp-locations-upload-selection",
      name: "enable-sftp-locations-upload-selection",
      tags: ["ui"],
    })).key,
    "Enable-sftp-locations-upload-selection",
  );
  // Nothing in the key, name or description: the tag names the purpose (never the area)
  const tagged = propose(flag({
    key: "FLAG-SALESFORCE-SYNC",
    name: "FLAG-SALESFORCE-SYNC",
    tags: ["automation", "ui"],
  }));
  assertEquals(tagged.key, "Show-salesforce-sync");
  assertEquals(tagged.note, undefined);
});

Deno.test("purposeAreaBehavior: a non-boolean multivariate flag with no match is Config", () => {
  assertEquals(
    propose(
      flag({
        key: "string-flag",
        name: "string-flag",
        kind: "multivariate",
        valueType: "string",
      }),
    ).key,
    "Config-string",
  );
});

Deno.test("loadNamer: default namer, module exports, and a module without one", async () => {
  assertEquals(await loadNamer(), purposeAreaBehavior);
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/named.ts`,
    "export const namer = () => ({ key: 'k' });",
  );
  assertEquals(
    (await loadNamer(`${dir}/named.ts`))(flag({}), { project: "p" }),
    { key: "k" },
  );
  await Deno.writeTextFile(`${dir}/none.ts`, "export const other = 1;");
  await assertRejects(() => loadNamer(`${dir}/none.ts`));
  assertEquals(keepUnchanged(flag({}), { project: "p" }), null);
  await Deno.remove(dir, { recursive: true });
});
