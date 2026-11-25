import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import matter from "gray-matter";

const root = new URL("../", import.meta.url);
const contractSchema = JSON.parse(await readFile(new URL(
  "schemas/mdbase.memory/1.0.0.schema.json", root,
), "utf8"));
const starter = matter(await readFile(new URL("types/memory/1.md", root), "utf8")).data;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateContract = ajv.compile(contractSchema);
const validateStarter = ajv.compile(starter.schema.value);
const memory = { name: "prefers-metric-units", description: "Prefers metric units and 24-hour times", kind: "feedback" };

test("a memory is a kebab-case name, a one-line description and a kind", () => {
  for (const validate of [validateContract, validateStarter]) {
    assert.equal(validate(memory), true, ajv.errorsText(validate.errors));
    assert.equal(validate({ ...memory, by: "Claude" }), true, ajv.errorsText(validate.errors));
    for (const kind of ["user", "feedback", "project", "reference"]) {
      assert.equal(validate({ ...memory, kind }), true, kind);
    }
    for (const key of ["name", "description", "kind"]) {
      const { [key]: _omitted, ...rest } = memory;
      assert.equal(validate(rest), false, `accepted a memory without ${key}`);
    }
    for (const name of ["Prefers metric", "prefers_metric", "-metric", "metric-", "metric--units", "a".repeat(81)]) {
      assert.equal(validate({ ...memory, name }), false, `accepted name ${JSON.stringify(name)}`);
    }
    for (const description of ["", "x".repeat(201)]) {
      assert.equal(validate({ ...memory, description }), false, `accepted a ${description.length}-character description`);
    }
    assert.equal(validate({ ...memory, kind: "preference" }), false);
    assert.equal(validate({ ...memory, by: "" }), false);
  }
});

test("the contract view is only the index; the starter keeps the note's other fields", () => {
  assert.equal(validateContract({ ...memory, tags: ["home"] }), false);
  assert.equal(validateStarter({ ...memory, tags: ["home"] }), true);
});

test("the starter stores the name in the path and maps every contract field", () => {
  const { path, unique, display } = starter.collection;
  assert.deepEqual(path, { pattern: "Memories/{name}.md", fields: ["name"] });
  assert.deepEqual(unique, [{ field: "name", scope: "type" }]);
  assert.equal(display.name_field, "description");
  assert.deepEqual(starter.implements, [{
    contract: "mdbase.memory",
    version: "1.0.0",
    fields: { name: "name", description: "description", kind: "kind", by: "by" },
  }]);
  assert.deepEqual(Object.keys(starter.implements[0].fields).sort(), Object.keys(contractSchema.properties).sort());
});

test("the starter's index carries the rules an assistant reads before any body", () => {
  // Assistants see a type's description and field descriptions when they
  // describe a collection, not the type document's body.
  assert.match(starter.description, /list only name, description and kind/);
  assert.match(starter.description, /Update an existing memory rather than adding a duplicate/);
  assert.match(starter.description, /Never store passwords, keys or other secrets/);
  assert.match(starter.schema.value.properties.kind.description, /"Why:" line and a "How to apply:" line/);
  assert.match(starter.schema.value.properties.kind.description, /absolute dates/);
});

test("the starter matches notes in its pattern's folder only", () => {
  const glob = starter.match.path_glob;
  const folder = path => path.slice(0, path.lastIndexOf("/") + 1);
  assert.equal(folder(glob), folder(starter.collection.path.pattern));
  const pattern = new RegExp(`^${glob.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*")}$`);
  assert.match("Memories/prefers-metric-units.md", pattern);
  for (const path of ["prefers-metric-units.md", "Memories/archive/old.md", "Notes/prefers-metric-units.md"]) {
    assert.doesNotMatch(path, pattern);
  }
});
