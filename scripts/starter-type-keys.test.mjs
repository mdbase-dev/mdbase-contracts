import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import matter from "gray-matter";

const root = new URL("../", import.meta.url);

// Apps create records by naming a type; the engine records it under the collection's
// configured explicit type key (`type` by default, `mdbase_type` in some collections).
// A starter that requires or pins its own name under `type`, or rejects unknown
// top-level fields, fails in every collection whose key is something else.
for (const source of ["types/person/3.md", "types/comment/2.md", "types/view/2.md"]) {
  test(`${source} leaves the type key to the collection`, async () => {
    const type = matter(await readFile(new URL(source, root), "utf8")).data;
    const schema = type.schema.value;
    for (const key of ["type", "types"]) {
      assert.equal(schema.properties?.[key], undefined, `${key} must not be declared`);
      assert.ok(!(schema.required ?? []).includes(key), `${key} must not be required`);
    }
    assert.notEqual(schema.additionalProperties, false, "the starter must accept the collection's type key");
  });
}
