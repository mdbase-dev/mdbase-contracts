import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import matter from "gray-matter";

const root = new URL("../", import.meta.url);
const personSchema = JSON.parse(await readFile(new URL(
  "schemas/mdbase.person/1.0.0.schema.json", root,
), "utf8"));
const contactSchema = JSON.parse(await readFile(new URL(
  "schemas/mdbase.contact/1.0.0.schema.json", root,
), "utf8"));
const starter = matter(await readFile(new URL("types/person/1.md", root), "utf8")).data;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validatePerson = ajv.compile(personSchema);
const validateContact = ajv.compile(contactSchema);
const validateStarter = ajv.compile(starter.schema.value);

const identity = { issuer: "https://connect.example", subject: "usr_789" };
const person = { id: "person_abc123", name: "Callum" };

function valid(validate, value) {
  assert.equal(validate(value), true, ajv.errorsText(validate.errors));
}

function project(record, contractId) {
  const mapping = starter.implements.find(({ contract }) => contract === contractId);
  return Object.fromEntries(Object.entries(mapping.fields)
    .filter(([, local]) => Object.hasOwn(record, local))
    .map(([canonical, local]) => [canonical, record[local]]));
}

test("a person does not require an account or membership", () => {
  valid(validatePerson, person);
  valid(validatePerson, { ...person, identities: [] });
});

test("identity associations are portable across issuers and account changes", () => {
  valid(validatePerson, {
    ...person,
    identities: [identity, { issuer: "https://self-hosted.example", subject: identity.subject }],
  });
  valid(validatePerson, {
    ...person,
    name: "New display name",
    identities: [identity],
  });
  valid(validatePerson, {
    ...person,
    identities: [{ issuer: "http://localhost:3000", subject: "development-account" }],
  });
});

test("person IDs and labels must contain non-whitespace text", () => {
  for (const field of ["id", "name"]) {
    const missing = { ...person };
    delete missing[field];
    assert.equal(validatePerson(missing), false);
    for (const value of ["", " \t\n", null, 7]) {
      assert.equal(validatePerson({ ...person, [field]: value }), false);
    }
  }
});

test("identity references require both an absolute HTTP issuer and an opaque subject", () => {
  for (const invalid of [
    {},
    { issuer: identity.issuer },
    { subject: identity.subject },
    { ...identity, issuer: "/relative" },
    { ...identity, issuer: "mailto:callum@example.com" },
    { ...identity, issuer: "https://contains a space.example" },
    { ...identity, subject: "" },
    { ...identity, subject: " \t" },
    { ...identity, subject: 789 },
    { ...identity, access_token: "not-collection-data" },
    { ...identity, verified: true },
  ]) {
    assert.equal(validatePerson({ ...person, identities: [invalid] }), false,
      JSON.stringify(invalid));
  }
});

test("duplicate pairs in one person are rejected without normalizing subjects or issuers", () => {
  assert.equal(validatePerson({ ...person, identities: [identity, { ...identity }] }), false);
  valid(validatePerson, {
    ...person,
    identities: [
      identity,
      { ...identity, subject: "USR_789" },
      { ...identity, issuer: "https://connect.example/" },
    ],
  });
});

test("permissions and membership are not part of the person contract", () => {
  for (const extra of [{ role: "owner" }, { verified: true }, { membership_id: "member_1" }]) {
    assert.equal(validatePerson({ ...person, ...extra }), false);
  }
});

test("starter records project to both person and contact contracts", () => {
  const record = {
    type: "person",
    ...person,
    identities: [identity],
    kind: "individual",
    email: "callum@example.com",
    phone: "+61 400 000 000",
    organisation: "Example",
    birthday: "1990-01-01",
    favourite_colour: "blue",
  };
  valid(validateStarter, record);
  const personView = project(record, "mdbase.person");
  const contactView = project(record, "mdbase.contact");
  valid(validatePerson, personView);
  valid(validateContact, contactView);
  assert.deepEqual(personView, { ...person, identities: [identity] });
  assert.equal(contactView.primary_email, record.email);
  assert.equal(Object.hasOwn(personView, "favourite_colour"), false);
  assert.equal(Object.hasOwn(contactView, "identities"), false);
});

test("the starter accepts local fields but only individual contacts", () => {
  valid(validateStarter, { type: "person", ...person, local_notes: "Editable" });
  for (const kind of ["organisation", "group"]) {
    assert.equal(validateStarter({ type: "person", ...person, kind }), false);
  }
  assert.deepEqual(starter.collection.unique, [{ field: "id", scope: "collection" }]);
});

test("Person v2 documents every field without changing validation or contract mappings", async () => {
  const updated = matter(await readFile(new URL("types/person/2.md", root), "utf8")).data;
  assert.equal(updated.version, 2);
  function withoutDescriptions(value) {
    if (Array.isArray(value)) return value.map(withoutDescriptions);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description")
      .map(([key, entry]) => [key, withoutDescriptions(entry)]));
  }
  function described(schema) {
    assert.ok(schema.description?.length >= 30, "every field and identity entry needs useful guidance");
    for (const child of Object.values(schema.properties ?? {})) described(child);
    if (schema.items) described(schema.items);
  }
  described(updated.schema.value);
  assert.deepEqual(withoutDescriptions(updated.schema.value), withoutDescriptions(starter.schema.value));
  assert.deepEqual(updated.implements, starter.implements);
  assert.deepEqual(updated.collection, starter.collection);
  valid(ajv.compile(updated.schema.value), { type: "person", ...person, identities: [identity] });
});

test("cross-record identity ambiguity is not falsely presented as schema validation", () => {
  // Both records conform. Consumers must query every implementation and detect
  // the duplicate association rather than trusting either record as proof.
  valid(validatePerson, { ...person, identities: [identity] });
  valid(validatePerson, { ...person, id: "person_other", identities: [identity] });
});
