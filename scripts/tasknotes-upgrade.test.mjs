import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { cliPackEngine } from "./cli-pack-engine.mjs";

const command = process.env.MDBASE_VERIFY_CLI;
const load = async (version) => JSON.parse(await readFile(new URL(`../dist/packs/tasknotes.task/${version}.json`, import.meta.url), "utf8"));
async function reviewedInstall(engine) {
  let assessment = await engine.assess();
  assert.equal(assessment.valid, true, JSON.stringify(assessment));
  const adoptions = Object.fromEntries(assessment.result.resources
    .filter((r) => r.mode === "managed" && r.action === "conflict")
    .map((r) => [r.target, r.current_digest]));
  assessment = await engine.assess(adoptions);
  assert.equal(assessment.valid, true, JSON.stringify(assessment));
  return engine.apply(assessment.result.assessment_digest, adoptions);
}

for (const scenario of ["managed", "customized", "unmanaged", "conflict", "other-reference"]) {
  test(`TaskNotes rc.12 upgrade: ${scenario}`, { skip: !command }, async () => {
    const root = await mkdtemp(join(tmpdir(), "tasknotes-upgrade-test-"));
    const engines = [];
    try {
      await writeFile(join(root, "mdbase.yaml"), "spec_version: 0.3.0\nsettings:\n  validation: error\n");
      const old = await load("0.3.0-rc.12");
      async function engine(provision) {
        const value = await cliPackEngine(command, root, provision, "dev.mdbase.tests");
        engines.push(value);
        return value;
      }
      assert.equal((await reviewedInstall(await engine(old))).valid, true);
      const typePath = join(root, "_types/task.md");
      const oldType = await readFile(typePath, "utf8");
      if (scenario === "customized") {
        const type = parse(oldType.slice(4, oldType.indexOf("\n---", 4)));
        type.schema.value.properties.heading = type.schema.value.properties.title;
        delete type.schema.value.properties.title;
        type.schema.value.required = type.schema.value.required.map((key) => key === "title" ? "heading" : key);
        type.implements.find((entry) => entry.contract === "tasknotes.task").fields.title = "heading";
        await writeFile(typePath, `---\n${stringify(type)}---\nCustom documentation.\n`);
      }
      if (scenario === "conflict") await writeFile(typePath, oldType.replace("version: 1\n", "version: 99\n"));
      if (scenario === "other-reference") await writeFile(join(root, "_types/other.md"), oldType.replace("name: task", "name: other"));
      if (scenario === "unmanaged") await rm(join(root, "mdbase.lock.yaml"));
      const task = "---\ntype: task\ntitle: Keep\nheading: Keep\n---\nOriginal body.\n";
      await writeFile(join(root, "task.md"), task);
      const paths = old.manifest.resources.map((r) => r.target);
      if (scenario !== "unmanaged") paths.push("mdbase.lock.yaml");
      const before = await Promise.all(paths.map(async (path) => [path, await readFile(join(root, path), "utf8")]));
      if (scenario === "managed") {
        // The immediately preceding broken pack must reproduce the regression.
        assert.equal((await reviewedInstall(await engine(await load("0.3.0-rc.13")))).valid, false);
        for (const [path, document] of before) assert.equal(await readFile(join(root, path), "utf8"), document);
      }
      const result = await reviewedInstall(await engine(await load("0.3.0-rc.14")));
      const success = !["conflict", "other-reference"].includes(scenario);
      assert.equal(result.valid, success, JSON.stringify(result));
      assert.equal(await readFile(join(root, "task.md"), "utf8"), task);
      if (!success) {
        for (const [path, document] of before) assert.equal(await readFile(join(root, path), "utf8"), document);
      } else {
        const upgraded = await readFile(typePath, "utf8");
        assert.match(upgraded, /assignees/);
        assert.match(upgraded, /0\.3\.0-rc\.4/);
        if (scenario === "customized") {
          assert.match(upgraded, /title: heading/);
          assert.ok(upgraded.endsWith("Custom documentation.\n"));
        }
      }
    } finally {
      await Promise.all(engines.map((engine) => engine.close()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
