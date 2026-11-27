import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import matter from "gray-matter";

const version = "0.3.0-rc.7";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const contract = matter(await read(`contracts/tasknotes.task/${version}.md`)).data;
const recordSchema = JSON.parse(await read(`schemas/tasknotes.task/${version}.schema.json`));
const bindingSchema = JSON.parse(await read(`schemas/tasknotes.task.binding/${version}.schema.json`));
const starter = matter(await read("types/tasknotes-task/8.md")).data;

// The starter uses required-only conditions, which JSON Schema allows.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const validateDate = ajv.compile({ type: "string", format: "date" });
ajv.addFormat("local-date-time", (value) => {
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/.exec(value);
  return match !== null && validateDate(match[1]);
});
const validateContract = ajv.compile(recordSchema);
const validateStarter = ajv.compile(starter.schema.value);

const dateFields = ["due", "scheduled"];
const timestampFields = ["dateCreated", "dateModified"];

test("the TaskNotes rc.7 contract and starter agree on date fields and the binding", () => {
  assert.deepEqual(contract.record_schema.value, recordSchema);
  assert.deepEqual(contract.binding_schema.value, bindingSchema);
  assert.equal(starter.implements[0].version, version);
  const validateBinding = ajv.compile(bindingSchema);
  assert.equal(validateBinding(starter.implements[0].binding), true, ajv.errorsText(validateBinding.errors));
  for (const field of [...dateFields, ...timestampFields]) {
    const formats = [...(dateFields.includes(field) ? ["date"] : []), "date-time", "local-date-time"];
    const expected = { anyOf: formats.map((format) => ({ type: "string", format })) };
    assert.deepEqual(recordSchema.properties[field], expected, field);
    assert.deepEqual(starter.schema.value.properties[field], expected, field);
  }
});

test("TaskNotes dates accept floating and offset times and reserve date-only values for due and scheduled", () => {
  const base = { title: "Timed task", status: "open", dateCreated: "2026-11-27T08:00:00Z" };
  for (const validate of [validateContract, validateStarter]) {
    for (const field of [...dateFields, ...timestampFields]) {
      for (const value of ["2026-11-27T08:00", "2026-11-27T08:00:00", "2024-02-29T08:00:05.123", "2026-11-27T08:00:00+11:00", base.dateCreated]) {
        assert.equal(validate({ ...base, [field]: value }), true, `${field} ${value}: ${ajv.errorsText(validate.errors)}`);
      }
      for (const value of ["2026-02-29T08:00", "2026-11-27T24:00", "2026-11-27T08:60", "2026-11-27T08:00:99", "2026-11-27T08:00+11:00", 123]) {
        assert.equal(validate({ ...base, [field]: value }), false, `${field} accepted ${value}`);
      }
      assert.equal(validate({ ...base, [field]: "2026-11-27" }), dateFields.includes(field), field);
    }
  }
});
