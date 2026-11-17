import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specRoot = resolve(
  process.env.MDBASE_SPEC_DIR ?? join(root, "..", "mdbase-spec")
);
// Published artifacts are immutable: this imports the current pack version
// alongside earlier ones and refuses to overwrite a differing existing file.
const PACK_VERSION = "0.2.1";
// Type snapshots are versioned so earlier packs keep their published sources.
const TYPE_DIR = "types/mdbase-runtime/v2";
const sourceRoot = join(specRoot, `standard-packs/mdbase-runtime/${PACK_VERSION}`);
const manifest = parse(await readFile(join(sourceRoot, "mdbase-pack.yaml"), "utf8"));

if (
  manifest.kind !== "mdbase.type-pack"
  || manifest.id !== "mdbase.runtime.standard"
  || manifest.version !== PACK_VERSION
) {
  throw new Error(`The source is not mdbase.runtime.standard ${PACK_VERSION}.`);
}

const runtimeRecordIds = [];
const recordContractVersions = new Map();
for (const resource of manifest.resources.filter(({ kind }) => kind === "contract")) {
  const document = await readFile(join(sourceRoot, resource.source), "utf8");
  const frontmatter = parseFrontmatter(document, resource.source).frontmatter;
  if (frontmatter.contract_type === "record") {
    runtimeRecordIds.push(frontmatter.id);
    recordContractVersions.set(frontmatter.id, frontmatter.version);
  }
}
const resources = [];
for (const resource of manifest.resources) {
  const source = catalogSource(resource);
  const from = join(sourceRoot, resource.source);
  const to = join(root, source);
  await mkdir(dirname(to), { recursive: true });
  const contents = resource.kind === "type"
    ? await editableTypeSnapshot(from)
    : await readFile(from, "utf8");
  const existing = await readFile(to, "utf8").catch(() => null);
  if (existing !== null && existing !== contents) {
    throw new Error(`${source} already exists with different content; publish a new version instead.`);
  }
  await writeFile(to, contents, "utf8");
  resources.push({
    kind: resource.kind,
    mode: resource.mode,
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
  display: {
    name: "Runtime standard library",
    summary: "Internal records and contracts for durable workflows, runs, timers, and diagnostics.",
    category: "infrastructure",
    audience: "infrastructure",
    icon: "terminal-window",
    badges: ["Runtime 0.2"]
  },
  installation: {
    visibility: "advanced",
    recommendation: "integration-managed",
    primary_type: null,
    caution: "Most collections do not need this pack. Install it only when a runtime integration asks you to."
  },
  // `provides` means the installed types implement these record contracts.
  // Event/action artifacts remain available for admission, while live
  // declarations say which sources/providers actually supply them.
  provides: [...new Set(runtimeRecordIds)]
    .sort()
    .map((id) => ({ id, version: recordContractVersions.get(id) })),
  resources
};
const packPath = join(root, `packs/mdbase.runtime.standard/${PACK_VERSION}.pack.yaml`);
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
    return resource.source.replace(/^_types\//u, `${TYPE_DIR}/`);
  }
  return resource.source;
}
