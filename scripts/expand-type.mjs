import { readFile, writeFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { expandLocalReferences } from "./schema-expansion.mjs";

const [, , input, output] = process.argv;
if (!input || !output) {
  throw new Error("Usage: node scripts/expand-type.mjs <input.md> <output.md>");
}

const source = await readFile(input, "utf8");
const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n[\s\S]*)$/);
if (!match) throw new Error(`${input} is not a frontmatter document.`);

const document = parseDocument(match[1]);
const schema = document.getIn(["schema", "value"], true)?.toJSON();
if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
  throw new Error(`${input} does not contain schema.value.`);
}

const expanded = expandLocalReferences(schema);
if (expanded.expandedCount === 0) {
  throw new Error(`${input} does not contain expandable local references.`);
}
document.setIn(["schema", "value"], expanded.schema);
await writeFile(output, `---\n${document.toString()}---${match[2]}`);

console.log(
  `Expanded ${expanded.expandedCount} local references into ${output}`
  + (expanded.recursiveReferences.length
    ? `; retained ${expanded.recursiveReferences.length} recursive references`
    : ""),
);
