import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { liftConfigurationSetup, validateConfigurationSetup } from "./configuration-setup.mjs";

const root = new URL("../", import.meta.url);
const base = () => ({ configuration: {
  requirements: [{ id: "base-extension", path: "/settings/record_extensions", predicate: "contains", value: "base" }],
  provisions: [{ requirement: "base-extension", operation: "set_add", path: "/settings/record_extensions", value: "base" }],
} });
const change = (mutate) => { const result = base(); mutate(result.configuration); return result; };

test("catalog clauses lift into exactly the existing CollectionSetup arrays without aliases", () => {
  const declaration = base();
  const lifted = liftConfigurationSetup(declaration);
  assert.deepEqual(lifted.requirements.configuration, declaration.configuration.requirements);
  assert.deepEqual(lifted.provisions.configuration, declaration.configuration.provisions);
  lifted.requirements.configuration[0].value = "changed";
  assert.equal(declaration.configuration.requirements[0].value, "base");
  assert.deepEqual(liftConfigurationSetup(undefined), {
    requirements: { configuration: [] }, provisions: { configuration: [] },
  });
});

test("duplicate, orphan, mismatched and unsupported clauses refuse", () => {
  for (const declaration of [
    null, {}, { configuration: null }, { ...base(), unexpected: true },
    change((c) => { c.provisions = []; }),
    change((c) => { c.requirements.push(c.requirements[0]); }),
    change((c) => { c.provisions.push(c.provisions[0]); }),
    change((c) => { c.provisions[0].requirement = "orphan"; }),
    change((c) => { c.provisions[0].value = "md"; }),
    change((c) => { c.provisions[0].path = "/x-private/sources"; }),
    change((c) => { c.provisions[0].operation = "replace"; }),
    change((c) => { c.requirements[0].predicate = "equals"; }),
    change((c) => { c.requirements[0].secret = "never reported"; }),
    change((c) => { c.requirements[0].id = "Invalid"; }),
    change((c) => { c.requirements = Array(129).fill(c.requirements[0]); }),
  ]) assert.throws(() => validateConfigurationSetup(declaration), /^Error: invalid_collection_setup:/);
});

test("only the exact approved settings pointer is exempt from x-* confinement", () => {
  for (const path of [
    "/settings/timezone", "/settings/record_extensions/extra", "/runtime/events",
    "/x-private", "/x-private/0", "/x-private/-", "/x-private/bad~2escape",
    "/x-private//empty", "/x-private/\u0085", `/${"x".repeat(1025)}/value`,
    `/x-private/${Array(16).fill("nested").join("/")}`,
  ]) {
    assert.throws(() => validateConfigurationSetup(change((c) => {
      c.requirements[0].path = c.provisions[0].path = path;
    })), /invalid_collection_setup/);
  }
  for (const path of ["/settings/record_extensions", "/x-private/escaped~1key", "/x-private/escaped~0key"]) {
    validateConfigurationSetup(change((c) => { c.requirements[0].path = c.provisions[0].path = path; }));
  }
});

test("extension values are strings; extension namespaces retain the scalar domain", () => {
  for (const value of [null, true, 12, ["base"], {}, "../base", ".base"]) {
    assert.throws(() => validateConfigurationSetup(change((c) => {
      c.requirements[0].value = c.provisions[0].value = value;
    })), /invalid_collection_setup/);
  }
  for (const value of [null, true, false, 0, -0, 1.25, "public-source"]) {
    validateConfigurationSetup(change((c) => {
      c.requirements[0].path = c.provisions[0].path = "/x-private/sources";
      c.requirements[0].value = c.provisions[0].value = value;
    }));
  }
  for (const value of [Infinity, NaN, [], {}]) {
    assert.throws(() => validateConfigurationSetup(change((c) => {
      c.requirements[0].path = c.provisions[0].path = "/x-private/sources";
      c.requirements[0].value = c.provisions[0].value = value;
    })), /invalid_collection_setup/);
  }
});

test("published old Bases provision is immutable; candidate transports setup outside strict manifest", async () => {
  const old = await readFile(new URL("dist/packs/obsidian.base/1.0.0.json", root));
  assert.equal(createHash("sha256").update(old).digest("hex"), "8251b351a4b00c4ea3f4d49988ae45ab52ceaf2420f57ce8105ca4cfe5eafd50");
  const candidate = JSON.parse(await readFile(new URL("dist/packs/obsidian.base/1.0.1.json", root), "utf8"));
  assert.equal(candidate.manifest.kind, "mdbase.type-pack");
  assert.equal(candidate.manifest.version, "1.0.1");
  assert.equal(Object.hasOwn(candidate.manifest, "setup"), false);
  const lifted = liftConfigurationSetup(candidate.setup);
  assert.equal(lifted.requirements.configuration[0].path, "/settings/record_extensions");
  assert.equal(lifted.provisions.configuration[0].value, "base");
  assert.deepEqual(candidate.resources, JSON.parse(old).resources);
  const catalog = JSON.parse(await readFile(new URL("dist/catalog.json", root), "utf8"));
  assert.equal(catalog.packs.some((pack) => pack.id === "obsidian.base" && pack.version === "1.0.1"), false);
});
