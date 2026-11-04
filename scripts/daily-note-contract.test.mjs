import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import matter from "gray-matter";

const root = new URL("../", import.meta.url);
const contractSchema = JSON.parse(await readFile(new URL(
  "schemas/mdbase.daily-note/1.0.0.schema.json", root,
), "utf8"));
const starter = matter(await readFile(new URL("types/daily-note/1.md", root), "utf8")).data;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateContract = ajv.compile(contractSchema);
const validateStarter = ajv.compile(starter.schema.value);

test("a daily note is one civil calendar date", () => {
  for (const validate of [validateContract, validateStarter]) {
    assert.equal(validate({ date: "2026-10-30" }), true, ajv.errorsText(validate.errors));
    assert.equal(validate({}), false);
    for (const date of ["2026-10-30T09:00:00Z", "2026-10-30+10:00", "2026-02-30", "30-10-2026", 20261030]) {
      assert.equal(validate({ date }), false, `accepted ${JSON.stringify(date)}`);
    }
  }
});

test("the contract view is only the date; the starter keeps the note's other fields", () => {
  assert.equal(validateContract({ date: "2026-10-30", mood: "good" }), false);
  assert.equal(validateStarter({ date: "2026-10-30", mood: "good" }), true);
});

test("the starter stores the date in the path and maps it to the contract", () => {
  const { path, unique } = starter.collection;
  assert.deepEqual(path.fields, ["date"]);
  assert.ok(path.pattern.includes("{date}"));
  assert.deepEqual(unique, [{ field: "date", scope: "type" }]);
  assert.deepEqual(starter.implements, [
    { contract: "mdbase.daily-note", version: "1.0.0", fields: { date: "date" } },
  ]);
});

test("the starter matches only date-named notes in its pattern's folder", () => {
  const glob = starter.match.path_glob;
  const folder = path => path.slice(0, path.lastIndexOf("/") + 1);
  assert.equal(folder(glob), folder(starter.collection.path.pattern));
  const pattern = new RegExp(`^${glob.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*")}$`);
  assert.match("Daily/2026-10-30.md", pattern);
  for (const path of ["Daily/Ideas.md", "Daily/2026-10-30 draft.md", "2026-10-30.md", "Daily/2026/2026-10-30.md"]) {
    assert.doesNotMatch(path, pattern);
  }
});
