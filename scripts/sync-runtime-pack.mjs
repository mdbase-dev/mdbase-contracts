import {
  cp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specRoot = resolve(
  process.env.MDBASE_SPEC_DIR ?? join(root, "..", "mdbase-spec")
);
const sourceRoot = join(specRoot, "standard-packs/mdbase-runtime/0.2.0");
const manifest = parse(await readFile(join(sourceRoot, "mdbase-pack.yaml"), "utf8"));

if (
  manifest.kind !== "mdbase.type-pack"
  || manifest.id !== "mdbase.runtime.standard"
  || manifest.version !== "0.2.0"
) {
  throw new Error("The source is not mdbase.runtime.standard 0.2.0.");
}

const runtimeContractIds = manifest.resources
  .filter(({ kind }) => kind === "contract")
  .map(({ source }) => source.split("/")[1]);
const runtimeRecordIds = [];
for (const resource of manifest.resources.filter(({ kind }) => kind === "contract")) {
  const document = await readFile(join(sourceRoot, resource.source), "utf8");
  const frontmatter = parseFrontmatter(document, resource.source).frontmatter;
  if (frontmatter.contract_type === "record") {
    runtimeRecordIds.push(frontmatter.id);
  }
}
const runtimeSchemaIds = manifest.resources
  .filter(({ kind }) => kind === "schema")
  .map(({ source }) => source.split("/")[1]);

for (const id of new Set(runtimeContractIds)) {
  await rm(join(root, "contracts", id), { recursive: true, force: true });
}
for (const id of new Set(runtimeSchemaIds)) {
  await rm(join(root, "schemas", id), { recursive: true, force: true });
}
await rm(join(root, "types/mdbase-runtime"), { recursive: true, force: true });

const resources = [];
for (const resource of manifest.resources) {
  const source = catalogSource(resource);
  const from = join(sourceRoot, resource.source);
  const to = join(root, source);
  await mkdir(dirname(to), { recursive: true });
  if (resource.kind === "type") {
    await writeFile(to, await editableTypeSnapshot(from), "utf8");
  } else {
    await cp(from, to);
  }
  resources.push({
    kind: resource.kind,
    source,
    target: resource.target
  });
}

const definition = {
  kind: "mdbase.catalog-pack",
  id: manifest.id,
  version: manifest.version,
  name: manifest.name,
  description: manifest.description,
  featured: true,
  // `provides` means the installed types implement these record contracts.
  // Event/action artifacts remain available for admission, while live
  // declarations say which sources/providers actually supply them.
  provides: [...new Set(runtimeRecordIds)]
    .sort()
    .map((id) => ({ id, version: "1.0.0" })),
  resources
};
const packPath = join(root, "packs/mdbase.runtime.standard/0.2.0.pack.yaml");
await mkdir(dirname(packPath), { recursive: true });
await writeFile(packPath, stringify(definition, { lineWidth: 0 }), "utf8");

console.log(`Synced ${resources.length} runtime resources from ${sourceRoot}.`);

async function editableTypeSnapshot(path) {
  const document = await readFile(path, "utf8");
  const { frontmatter, body } = parseFrontmatter(document, path);
  const reference = frontmatter?.schema?.ref;
  if (typeof reference !== "string") {
    throw new Error(`Runtime type ${path} has no schema.ref to materialize.`);
  }
  const value = JSON.parse(
    await readFile(resolve(dirname(path), reference), "utf8")
  );
  frontmatter.schema = {
    dialect: frontmatter.schema.dialect,
    value
  };
  return `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n${body}`;
}

function parseFrontmatter(document, label) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(document);
  if (!match) {
    throw new Error(`Runtime resource ${label} has no YAML frontmatter.`);
  }
  return { frontmatter: parse(match[1]), body: match[2] };
}

function catalogSource(resource) {
  if (resource.kind === "contract") {
    return resource.source.replace(/^_contracts\//u, "contracts/");
  }
  if (resource.kind === "type") {
    return resource.source.replace(/^_types\//u, "types/mdbase-runtime/");
  }
  return resource.source;
}
