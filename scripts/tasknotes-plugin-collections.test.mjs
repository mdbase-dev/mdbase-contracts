import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { packEngine } from "./pack-engine.mjs";

// Collections exactly as the TaskNotes 5.0 plugin writes them (upgraded from
// TaskNotes 4.13.6 and the 5.0 betas, with default and customized settings).
// Every TaskNotes pack must install over them, as TaskNotes App does through
// Connect, without conflicts and without dropping statuses or touching records.
const LATEST = "0.3.0-rc.18";
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
      // These collections have no lock, so no recorded seed origin: a task type
      // equal to a published starter is replaced with the new starter, and any
      // other is the collection's own and is preserved with a reason, never
      // merged against a guessed baseline (mdbase spec 05A).
      const seed = provision.manifest.resources.find(({ target }) => target === "_types/task.md");
      const planned = result.result.resources.find(({ target }) => target === "_types/task.md");
      const starter = seed.upgrade_from.find(({ document }) => document === files["_types/task.md"]);
      if (starter) {
        assert.equal(planned.action, "update");
        assert.equal(type, provision.resources.find(({ source }) => source === seed.source).document);
      } else {
        assert.equal(planned.action, "preserve");
        assert.match(planned.reason, /no upgrade baseline applies/);
        assert.equal(type, files["_types/task.md"]);
      }
      if (files["_types/task.md"].includes("- cancelled")) assert.match(type, /- cancelled/);
      assert.match(type, /version: 0\.3\.0-rc\.5/);
      for (const path of Object.keys(files).filter((path) => !path.startsWith("_") && !path.startsWith("mdbase"))) {
        assert.equal(await readFile(join(root, path), "utf8"), files[path], path);
      }
    } finally {
      await engine?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
