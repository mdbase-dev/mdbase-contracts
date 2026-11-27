import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import matter from "gray-matter";
import { Collection, packEngine } from "./pack-engine.mjs";

// Collections exactly as the TaskNotes 5.0 plugin writes them (upgraded from
// TaskNotes 4.13.6 and the 5.0 betas, with default and customized settings).
// Every TaskNotes pack must install over them, as TaskNotes App does through
// Connect, without conflicts and without dropping statuses or touching records.
const LATEST = "0.3.0-rc.23";
const fixtures = new URL("./fixtures/tasknotes-5.0/", import.meta.url);

async function reviewedInstall(engine) {
  let assessment = await engine.assess();
  assert.equal(assessment.valid, true, JSON.stringify(assessment));
  const adoptions = Object.fromEntries(assessment.result.resources
    .filter((r) => r.mode === "managed" && r.action === "conflict" && r.installed_digest === undefined)
    .map((r) => [r.target, r.current_digest]));
  assessment = await engine.assess(adoptions);
  assert.equal(assessment.valid, true, JSON.stringify(assessment));
  assert.equal(assessment.result.status !== "conflict", true,
    JSON.stringify(assessment.result.resources.filter((r) => r.action === "conflict")));
  return engine.apply(assessment.result.assessment_digest, adoptions);
}

for (const name of (await readdir(fixtures)).filter((file) => file.endsWith(".json")).sort()) {
  test(`TaskNotes ${LATEST} installs over a TaskNotes 5.0 plugin collection: ${name}`, async () => {
    const { files } = JSON.parse(await readFile(new URL(name, fixtures), "utf8"));
    const root = await mkdtemp(join(tmpdir(), "tasknotes-plugin-collection-"));
    let engine;
    try {
      for (const [path, document] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), document);
      }
      const provision = JSON.parse(await readFile(new URL(`../dist/packs/tasknotes.task/${LATEST}.json`, import.meta.url), "utf8"));
      engine = await packEngine(root, provision, "dev.mdbase.tests");
      const result = await reviewedInstall(engine);
      assert.equal(result.valid, true, JSON.stringify(result));
      const type = await readFile(join(root, "_types/task.md"), "utf8");
      // These collections have no recorded seed origin. Exact starters are
      // replaced, while generated types can merge from an inferred baseline.
      const seed = provision.manifest.resources.find(({ target }) => target === "_types/task.md");
      const planned = result.result.resources.find(({ target }) => target === "_types/task.md");
      const starter = seed.upgrade_from.find(({ document }) => document === files["_types/task.md"]);
      const desired = provision.resources.find(({ source }) => source === seed.source).document;
      if (starter) {
        assert.equal(planned.action, "update");
        assert.equal(type, desired);
      } else if (name === "issue-2706.json") {
        assert.equal(planned.action, "update");
        const patternStarter = await readFile(new URL("../types/tasknotes-task/7.md", import.meta.url), "utf8");
        const baseline = seed.upgrade_from.find(({ document }) => document === patternStarter);
        assert.equal(planned.upgrade_baseline.digest, baseline.digest);
        const before = matter(files["_types/task.md"]);
        const after = matter(type);
        const expected = structuredClone(before.data);
        const desiredType = matter(desired).data;
        for (const field of ["due", "scheduled", "dateCreated", "dateModified"]) {
          expected.schema.value.properties[field] = desiredType.schema.value.properties[field];
        }
        expected.version = desiredType.version;
        expected.implements[0].version = "0.3.0-rc.7";
        assert.deepEqual(after.data, expected);
        assert.equal(after.content, before.content);
        const contractPath = "_contracts/tasknotes.task/0.3.0-rc.6.md";
        assert.equal(await readFile(join(root, contractPath), "utf8"), files[contractPath]);
      } else {
        // The preserved plugin type keeps its existing contract until TaskNotes
        // upgrades it. Check that the pack retains the exact contract bytes.
        assert.equal(planned.action, "preserve");
        assert.match(planned.reason, /no upgrade baseline applies/);
        assert.equal(type, files["_types/task.md"]);
        const contractPath = Object.keys(files).find((path) => path.startsWith("_contracts/tasknotes.task"));
        assert.equal(await readFile(join(root, contractPath), "utf8"), files[contractPath]);
      }
      if (files["_types/task.md"].includes("- cancelled")) assert.match(type, /- cancelled/);
      assert.equal(await readFile(join(root, "_types/tasknotes-settings.md"), "utf8"),
        provision.resources.find(({ source }) => source === "types/tasknotes-settings/2.md").document);
      for (const path of Object.keys(files).filter((path) => !path.startsWith("_") && !path.startsWith("mdbase"))) {
        assert.equal(await readFile(join(root, path), "utf8"), files[path], path);
      }
      if (name === "issue-2706.json") {
        const settingsPath = "_mdbase/settings/dev.tasknotes.md";
        assert.equal(await readFile(join(root, settingsPath), "utf8"), files[settingsPath]);
        const collection = await Collection.open(root);
        try {
          assert.deepEqual(await collection.validateOne("TaskNotes/Tasks/timed.md"), []);
        } finally {
          await collection.close();
        }
      }
    } finally {
      await engine?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
