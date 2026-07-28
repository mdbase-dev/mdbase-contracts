import assert from "node:assert/strict";
import test from "node:test";
import { expandLocalReferences, localReferences } from "./schema-expansion.mjs";

test("expands repeated acyclic local references and removes definitions", () => {
  const source = {
    type: "object",
    properties: {
      home: { $ref: "#/$defs/address" },
      work: { $ref: "#/$defs/address" },
    },
    $defs: {
      address: {
        type: "object",
        properties: { city: { type: "string" } },
      },
    },
  };

  const result = expandLocalReferences(source);

  assert.equal(result.expandedCount, 2);
  assert.deepEqual(result.recursiveReferences, []);
  assert.deepEqual(result.schema.properties.home, {
    type: "object",
    properties: { city: { type: "string" } },
  });
  assert.deepEqual(result.schema.properties.work, result.schema.properties.home);
  assert.equal("$defs" in result.schema, false);
  assert.deepEqual(localReferences(result.schema), []);
});

test("retains references whose definition graph is recursive", () => {
  const source = {
    $ref: "#/$defs/node",
    $defs: {
      node: {
        type: "object",
        properties: {
          children: {
            type: "array",
            items: { $ref: "#/$defs/node" },
          },
        },
      },
    },
  };

  const result = expandLocalReferences(source);

  assert.equal(result.expandedCount, 0);
  assert.deepEqual(result.recursiveReferences, ["#/$defs/node"]);
  assert.deepEqual(result.schema, source);
});

test("preserves ref sibling semantics with allOf", () => {
  const source = {
    type: "object",
    properties: {
      label: {
        $ref: "#/$defs/text",
        minLength: 3,
      },
    },
    $defs: {
      text: { type: "string", maxLength: 20 },
    },
  };

  const result = expandLocalReferences(source);

  assert.deepEqual(result.schema.properties.label, {
    allOf: [
      { type: "string", maxLength: 20 },
      { minLength: 3 },
    ],
  });
});

test("removes definitions that only reference one another after use-site expansion", () => {
  const source = {
    type: "object",
    properties: {
      profile: { $ref: "#/$defs/profile" },
    },
    $defs: {
      profile: {
        type: "object",
        properties: {
          name: { $ref: "#/$defs/name" },
        },
      },
      name: { type: "string" },
    },
  };

  const result = expandLocalReferences(source);

  assert.deepEqual(result.schema, {
    type: "object",
    properties: {
      profile: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      },
    },
  });
});

test("rejects unresolved local references", () => {
  assert.throws(
    () => expandLocalReferences({ $ref: "#/$defs/missing" }),
    /does not resolve/,
  );
});
