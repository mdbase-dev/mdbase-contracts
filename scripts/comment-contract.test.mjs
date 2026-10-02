import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import matter from "gray-matter";

const root = new URL("../", import.meta.url);
const commentSchema = JSON.parse(await readFile(new URL(
  "schemas/mdbase.comment/1.0.0.schema.json", root,
), "utf8"));
const starter = matter(await readFile(new URL("types/comment/2.md", root), "utf8")).data;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateComment = ajv.compile(commentSchema);
const validateStarter = ajv.compile(starter.schema.value);

const hash = `sha256:${"a".repeat(64)}`;
const thread = {
  document: "[[chapters/method]]",
  motivation: "commenting",
  target: {
    quote: { exact: "suggests strongly", prefix: "the evidence ", suffix: " that" },
    text_position: { basis: { profile: "markdown-body", hash }, unit: "unicode_code_point", start: 120, end: 137 },
  },
  status: "open",
  created_by: "[[Alex Rivera]]",
  created_at: "2026-09-29T10:00:00Z",
};

function valid(validate, value) {
  assert.equal(validate(value), true, ajv.errorsText(validate.errors));
}

function invalid(validate, value) {
  assert.equal(validate(value), false, `accepted ${JSON.stringify(value)}`);
}

test("a thread, a reply and a whole-record comment", () => {
  valid(validateComment, thread);
  valid(validateComment, {
    document: thread.document,
    in_reply_to: "[[comments/01k6-thread]]",
    motivation: "replying",
    created_at: "2026-09-29T10:05:00Z",
  });
  valid(validateComment, { document: thread.document, created_at: thread.created_at });
});

test("an anonymous comment needs no person link", () => {
  const { created_by: _, ...anonymous } = thread;
  valid(validateComment, anonymous);
});

test("a suggestion needs a target and a replacement", () => {
  valid(validateComment, { ...thread, motivation: "editing", suggestion: { replacement: "suggests" } });
  valid(validateComment, { ...thread, motivation: "editing", suggestion: { replacement: "" } });
  valid(validateComment, { ...thread, motivation: "editing", status: "resolved", suggestion: { replacement: "x", outcome: "accepted" } });
  invalid(validateComment, { ...thread, motivation: "editing" });
  const { target: _, ...untargeted } = thread;
  invalid(validateComment, { ...untargeted, motivation: "editing", suggestion: { replacement: "x" } });
});

test("an insertion point is located by the text around it", () => {
  const insertion = (quote) => ({ ...thread, motivation: "editing", target: { quote }, suggestion: { replacement: ", clearly," } });
  valid(validateComment, insertion({ exact: "", prefix: "The evidence" }));
  valid(validateComment, insertion({ exact: "", suffix: " suggests" }));
  invalid(validateComment, insertion({ exact: "" }));
  invalid(validateComment, insertion({ exact: "", prefix: "" }));
});

test("positions are code points of the Markdown body", () => {
  const at = (text_position) => ({ ...thread, target: { quote: thread.target.quote, text_position } });
  invalid(validateComment, at({ ...thread.target.text_position, unit: "utf16_code_unit" }));
  invalid(validateComment, at({ ...thread.target.text_position, basis: { profile: "html", hash } }));
  invalid(validateComment, at({ ...thread.target.text_position, basis: { profile: "markdown-body", hash: "abc" } }));
  invalid(validateComment, at({ ...thread.target.text_position, start: -1 }));
});

test("a target always quotes its text", () => {
  invalid(validateComment, { ...thread, target: { text_position: thread.target.text_position } });
});

test("the contract view is closed; the starter type is open", () => {
  invalid(validateComment, { ...thread, colour: "yellow" });
  valid(validateStarter, { type: "comment", ...thread, colour: "yellow" });
  // Whatever key the collection records the type under is just another open field.
  valid(validateStarter, thread);
  valid(validateStarter, { mdbase_type: "comment", ...thread });
});

test("the starter maps every contract field to itself and links every reference", () => {
  const mapping = starter.implements.find(({ contract }) => contract === "mdbase.comment");
  assert.equal(mapping.version, "1.0.0");
  assert.deepEqual(Object.keys(mapping.fields).sort(), Object.keys(commentSchema.properties).sort());
  for (const [canonical, local] of Object.entries(mapping.fields)) assert.equal(canonical, local);
  const links = starter.collection.links;
  for (const field of ["document", "in_reply_to", "created_by", "resolved_by"]) {
    assert.equal(links[field]?.validate_exists, false, `${field} must tolerate a deleted target`);
  }
});

// The collection's explicit type key (`type`, `mdbase_type`, ...) is configuration, not
// part of the comment, so the starter neither requires nor pins it.
test("the starter's schema is the contract's", () => {
  assert.equal(starter.schema.value.properties.type, undefined);
  assert.ok(!starter.schema.value.required.includes("type"));
  assert.deepEqual(starter.schema.value.properties, commentSchema.properties);
  assert.deepEqual(starter.schema.value.allOf, commentSchema.allOf);
});
