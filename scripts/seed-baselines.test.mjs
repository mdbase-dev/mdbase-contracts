import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import matter from "gray-matter";
import { baselines, compareVersions, publishedProvisions, seedTypes } from "./pack-versions.mjs";

// A seed type's upgrade_from (mdbase spec 05A) lists the starters it upgrades.
// A collection seeded by any earlier version of a pack may install the offered
// version, so the offered pack must list every starter an earlier version ever
// shipped at the same target: an unlisted starter is never upgraded.

const dist = new URL("../dist/", import.meta.url);
const catalog = JSON.parse(await readFile(new URL("catalog.json", dist), "utf8"));
const sha256 = (document) => `sha256:${createHash("sha256").update(document).digest("hex")}`;

test("SemVer precedence orders TaskNotes release candidates numerically", () => {
  assert.ok(compareVersions("0.3.0-rc.9", "0.3.0-rc.12") < 0);
  assert.ok(compareVersions("0.3.0-rc.18", "0.3.0") < 0);
  assert.ok(compareVersions("1.4.0", "1.3.0") > 0);
});

const all = await publishedProvisions();
const offered = catalog.packs.filter(({ installation }) => installation.visibility !== "hidden");

for (const entry of offered) {
  const offeredProvision = all.get(entry.id).find(({ manifest }) => manifest.version === entry.version);
  for (const resource of seedTypes(offeredProvision)) {
    test(`${entry.id} ${entry.version} upgrades every earlier starter at ${resource.target}`, () => {
      const listed = new Set(baselines(resource).map(({ digest }) => digest));
      const missing = [];
      for (const earlier of all.get(entry.id)) {
        if (compareVersions(earlier.manifest.version, entry.version) >= 0) continue;
        for (const shipped of seedTypes(earlier)) {
          if (shipped.target !== resource.target || shipped.digest === resource.digest) continue;
          if (!listed.has(shipped.digest)) missing.push(`${shipped.source} (${earlier.manifest.version})`);
        }
      }
      assert.deepEqual(missing, [], `${resource.target} upgrade_from must also list ${missing.join(", ")}`);
    });
  }
}

for (const [id, versions] of all) {
  for (const provision of versions) {
    for (const resource of provision.manifest.resources.filter((r) => r.upgrade_from !== undefined)) {
      test(`${id} ${provision.manifest.version} ${resource.target} baselines follow spec 05A`, () => {
        assert.equal(resource.kind, "type");
        assert.equal(resource.mode, "seed");
        const desired = matter(provision.resources.find(({ source }) => source === resource.source).document).data;
        const list = baselines(resource);
        assert.ok(list.length > 0);
        assert.equal(new Set(list.map(({ digest }) => digest)).size, list.length, "digests must be distinct");
        for (const baseline of list) {
          assert.equal(sha256(baseline.document), baseline.digest);
          assert.notEqual(baseline.digest, resource.digest, "a baseline cannot be the desired document");
          const frontmatter = matter(baseline.document).data;
          assert.equal(frontmatter.kind, desired.kind);
          assert.equal(frontmatter.name, desired.name);
          if (baseline.version !== undefined) assert.equal(baseline.version, frontmatter.version);
        }
        if (Array.isArray(resource.upgrade_from)) {
          const order = list.map(({ version }) => version);
          assert.deepEqual(order, [...order].sort((a, b) => b - a), "lists are ordered newest first");
        }
      });
    }
  }
}
