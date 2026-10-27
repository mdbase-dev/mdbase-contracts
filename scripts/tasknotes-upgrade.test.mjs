import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { packEngine } from "./pack-engine.mjs";

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

const targets = [
  { pack: "0.3.0-rc.14", contract: /0\.3\.0-rc\.4/ },
  // rc.15 turns assignees into collection-declared links to person records.
  { pack: "0.3.0-rc.15", contract: /0\.3\.0-rc\.5/, links: /assignees\[\]:/ },
  // rc.16 is rc.12's starter plus assignees only; rc.15 also dropped the
  // cancelled status and changed unrelated defaults.
  { pack: "0.3.0-rc.16", contract: /0\.3\.0-rc\.5/, links: /assignees\[\]:/, minimal: true },
  // rc.17 also leaves the collection's generator bookkeeping alone, which
  // follows its field mapping (rc.16 conflicted with a customized list).
  { pack: "0.3.0-rc.17", contract: /0\.3\.0-rc\.5/, links: /assignees\[\]:/, minimal: true, customMapping: true },
  // rc.18 ships rc.17's starter and lists every earlier starter as a baseline.
  { pack: "0.3.0-rc.18", contract: /0\.3\.0-rc\.5/, links: /assignees\[\]:/, minimal: true, customMapping: true },
  // rc.19 (tasknotes.task rc.6) moves app behaviour out of the binding into
  // the TaskNotes settings record; nothing else in the starter changes.
  { pack: "0.3.0-rc.19", contract: /0\.3\.0-rc\.6/, links: /assignees\[\]:/, minimal: true, customMapping: true, settingsRecord: true },
];

// The binding settings tasknotes.task rc.6 moved to the TaskNotes settings record.
function withoutAppSettings(type) {
  const binding = type.implements.find((entry) => entry.contract === "tasknotes.task").binding;
  for (const key of ["nlp", "templating", "time_tracking"]) delete binding[key];
  delete binding.archive?.move_on_archive;
  delete binding.archive?.folder;
  delete binding.recurrence?.reset_body_checkboxes;
  delete binding.links?.write_format;
  for (const definition of binding.status?.definitions ?? []) {
    for (const key of ["next_status", "exclude_from_cycle", "auto_archive", "auto_archive_delay_minutes"]) delete definition[key];
  }
  return type;
}

// Everything an upgrade may change in the starter type: assignees, versions
// and (from rc.19) the settings moved to the settings record.
function withoutAssignees(document, settingsRecord = false) {
  const type = parse(document.slice(4, document.indexOf("\n---", 4)));
  delete type.version;
  delete type.schema.value.properties.assignees;
  delete type.collection.links["assignees[]"];
  const implementation = type.implements.find((entry) => entry.contract === "tasknotes.task");
  delete implementation.version;
  delete implementation.fields.assignees;
  type["x-tasknotes-generator"].managed_fields = type["x-tasknotes-generator"].managed_fields.filter((field) => field !== "assignees");
  return settingsRecord ? withoutAppSettings(type) : type;
}
for (const target of targets) for (const scenario of ["managed", "customized", "customized-without-origin", "generator-defaults", "custom-mapping", "unmanaged", "conflict", "other-reference"]) {
  if (scenario === "generator-defaults" && !target.minimal) continue;
  if (scenario === "custom-mapping" && !target.customMapping) continue;
  test(`TaskNotes rc.12 to ${target.pack} upgrade: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "tasknotes-upgrade-test-"));
    const engines = [];
    try {
      await writeFile(join(root, "mdbase.yaml"), "spec_version: 0.3.0\nsettings:\n  validation: error\n");
      const old = await load("0.3.0-rc.12");
      async function engine(provision) {
        const value = await packEngine(root, provision, "dev.mdbase.tests");
        engines.push(value);
        return value;
      }
      assert.equal((await reviewedInstall(await engine(old))).valid, true);
      const typePath = join(root, "_types/task.md");
      const oldType = await readFile(typePath, "utf8");
      if (scenario === "customized" || scenario === "customized-without-origin") {
        const type = parse(oldType.slice(4, oldType.indexOf("\n---", 4)));
        type.schema.value.properties.heading = type.schema.value.properties.title;
        delete type.schema.value.properties.title;
        type.schema.value.required = type.schema.value.required.map((key) => key === "title" ? "heading" : key);
        type.implements.find((entry) => entry.contract === "tasknotes.task").fields.title = "heading";
        await writeFile(typePath, `---\n${stringify(type)}---\nCustom documentation.\n`);
      }
      if (scenario === "generator-defaults") {
        // Collections set up by earlier TaskNotes generators carry their own
        // status colours; an upgrade must keep them, and keep cancelled.
        await writeFile(typePath, oldType.replaceAll("#94a3b8", "#cccccc").replace("#64748b", "#808080").replace("#3b82f6", "#0066cc"));
      }
      if (scenario === "custom-mapping") {
        // A collection whose due field is named "deadline" lists it in its bookkeeping.
        await writeFile(typePath, oldType.replace("\n    - due\n", "\n    - deadline\n"));
      }
      if (scenario === "conflict") await writeFile(typePath, oldType.replace("version: 1\n", "version: 99\n"));
      if (scenario === "other-reference") await writeFile(join(root, "_types/other.md"), oldType.replace("name: task", "name: other"));
      if (scenario === "unmanaged") await rm(join(root, "mdbase.lock.yaml"));
      if (scenario === "customized-without-origin") {
        // Engines before mdbase spec 05A recorded no seed origin in the lock.
        const lockPath = join(root, "mdbase.lock.yaml");
        const lock = parse(await readFile(lockPath, "utf8"));
        for (const pack of lock.packs) for (const resource of pack.resources) delete resource.origin_digest;
        await writeFile(lockPath, stringify(lock));
      }
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
      const result = await reviewedInstall(await engine(await load(target.pack)));
      // An edited seed with no recorded origin (locks written before mdbase spec
      // 05A) is never merged against a guessed baseline. It is preserved, and as
      // it still requires the replaced contract the whole upgrade is blocked,
      // exactly as for any other reference to that contract.
      // rc.19 changes the starter's status definitions (their behaviour moved
      // to the settings record), and a collection that also edited them (here,
      // colours) conflicts on that list: the upgrade is blocked, the collection
      // keeps its rc.5 type, and TaskNotes upgrades it itself.
      const definitionsConflict = target.settingsRecord && scenario === "generator-defaults";
      const success = !["conflict", "other-reference", "customized-without-origin"].includes(scenario) && !definitionsConflict;
      assert.equal(result.valid, success, JSON.stringify(result));
      if (definitionsConflict) {
        assert.match(JSON.stringify(result.diagnostics), /binding\/status\/definitions/);
      }
      if (scenario === "customized-without-origin") {
        assert.match(JSON.stringify(result.diagnostics), /tasknotes\.task.{1,4}0\.3\.0-rc\.3/);
      }
      assert.equal(await readFile(join(root, "task.md"), "utf8"), task);
      if (!success) {
        for (const [path, document] of before) assert.equal(await readFile(join(root, path), "utf8"), document);
      } else {
        const upgraded = await readFile(typePath, "utf8");
        assert.match(upgraded, /assignees/);
        assert.match(upgraded, target.contract);
        if (target.links) assert.match(upgraded, target.links);
        if (target.minimal) {
          assert.deepEqual(
            withoutAssignees(upgraded, target.settingsRecord),
            withoutAssignees(new Map(before).get("_types/task.md"), target.settingsRecord),
          );
          assert.match(upgraded, /- cancelled/);
        }
        if (target.settingsRecord) {
          // The settings type is seeded; the record itself is the app's to write.
          assert.match(await readFile(join(root, "_types/tasknotes-settings.md"), "utf8"), /tasknotes\.settings/);
          assert.doesNotMatch(upgraded, /move_on_archive|time_tracking|templating:/);
          await assert.rejects(readFile(join(root, "_settings/dev.tasknotes.md"), "utf8"), { code: "ENOENT" });
        }
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
