import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import matter from "gray-matter";
import { parse, stringify } from "yaml";
import { packEngine } from "./pack-engine.mjs";
import { compareVersions, publishedProvisions, seedTypes, withLegacyResourceModes } from "./pack-versions.mjs";

// Every pack whose seed type lists its upgrade baselines must upgrade a
// collection seeded by any earlier version of that pack, through each engine:
// an unedited starter becomes the exact new starter, and an edited one merges
// against the starter its lock records as its origin.

const sha256 = (document) => `sha256:${createHash("sha256").update(document).digest("hex")}`;
const all = await publishedProvisions();

// Publishers' own starters change other managed resources too (TaskNotes moves
// its contract to a new source), which a reviewed install adopts explicitly.
async function reviewedInstall(engine) {
  let assessment = await engine.assess();
  assert.equal(assessment.valid, true, JSON.stringify(assessment));
  const adoptions = Object.fromEntries(assessment.result.resources
    .filter((r) => r.mode === "managed" && r.action === "conflict" && r.installed_digest === undefined)
    .map((r) => [r.target, r.current_digest]));
  assessment = await engine.assess(adoptions);
  assert.equal(assessment.valid, true, JSON.stringify(assessment));
  const applied = await engine.apply(assessment.result.assessment_digest, adoptions);
  assert.equal(applied.valid, true, JSON.stringify(applied));
  return applied.result;
}

async function withCollection(run) {
  const root = await mkdtemp(join(tmpdir(), "mdbase-seed-upgrade-"));
  const engines = [];
  try {
    await writeFile(join(root, "mdbase.yaml"), "spec_version: 0.3.0\nsettings:\n  validation: error\n");
    await run(root, async (provision) => {
      const engine = await packEngine(root, withLegacyResourceModes(provision), "dev.mdbase.tests");
      engines.push(engine);
      return reviewedInstall(engine);
    });
  } finally {
    await Promise.all(engines.map((engine) => engine.close()));
    await rm(root, { recursive: true, force: true });
  }
}

async function originDigest(root, id, target) {
  const lock = parse(await readFile(join(root, "mdbase.lock.yaml"), "utf8"));
  return lock.packs.find((pack) => pack.id === id).resources.find((resource) => resource.target === target)
    .origin_digest;
}

// A collection's own edits: a documented body line and an extra schema property.
function customize(document) {
  const { content } = matter(document);
  // gray-matter caches parsed documents; edit a copy.
  const data = structuredClone(matter(document).data);
  data.schema.value.properties.local_note = { type: "string", description: "This collection's own field." };
  return `---\n${stringify(data)}---\n${content}\nThis collection's own documentation.\n`;
}

for (const [id, versions] of all) {
  for (const provision of versions) {
    for (const resource of seedTypes(provision).filter(({ upgrade_from: from }) => Array.isArray(from))) {
      const desired = provision.resources.find(({ source }) => source === resource.source).document;
      const desiredType = matter(desired).data;
      const earlier = versions.filter((candidate) =>
        compareVersions(candidate.manifest.version, provision.manifest.version) < 0
        && seedTypes(candidate).some(({ target }) => target === resource.target));
      assert.ok(earlier.length > 0, `${id} ${provision.manifest.version} lists baselines but has no earlier starter`);

      for (const previous of earlier) {
        const shipped = seedTypes(previous).find(({ target }) => target === resource.target);
        const starter = previous.resources.find(({ source }) => source === shipped.source).document;
        const label = `${id} ${previous.manifest.version} to ${provision.manifest.version} (${shipped.source})`;

        test(`${label}: an unedited starter becomes the exact new starter`, async () => {
          await withCollection(async (root, install) => {
            await install(previous);
            const typePath = join(root, resource.target);
            assert.equal(await readFile(typePath, "utf8"), starter);
            const result = await install(provision);
            const planned = result.resources.find(({ target }) => target === resource.target);
            if (starter === desired) {
              assert.equal(planned.action, "preserve");
            } else {
              assert.equal(planned.action, "update", JSON.stringify(planned));
              assert.deepEqual(planned.upgrade_baseline, {
                digest: sha256(starter), version: matter(starter).data.version,
              });
            }
            assert.equal(await readFile(typePath, "utf8"), desired);
            assert.equal(await originDigest(root, id, resource.target), resource.digest);
          });
        });

        if (starter === desired) continue;
        test(`${label}: an edited starter merges against its own baseline`, async () => {
          await withCollection(async (root, install) => {
            await install(previous);
            const typePath = join(root, resource.target);
            await writeFile(typePath, customize(starter));
            const result = await install(provision);
            const planned = result.resources.find(({ target }) => target === resource.target);
            assert.equal(planned.action, "update", JSON.stringify(planned));
            assert.equal(planned.upgrade_baseline.digest, sha256(starter));
            assert.equal(planned.upgrade_baseline.version, matter(starter).data.version);
            const upgraded = await readFile(typePath, "utf8");
            const type = structuredClone(matter(upgraded).data);
            assert.ok(upgraded.endsWith("\nThis collection's own documentation.\n"), "the body edit is kept");
            assert.equal(type.schema.value.properties.local_note.type, "string", "the added property is kept");
            // Everything else is the new starter: the edits touched nothing it changes.
            delete type.schema.value.properties.local_note;
            assert.deepEqual(type, desiredType);
            assert.equal(await originDigest(root, id, resource.target), resource.digest);
          });
        });
      }
    }
  }
}
