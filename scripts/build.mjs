import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { parse } from "yaml";
import { expandLocalReferences } from "./schema-expansion.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const catalogSource = parse(await readFile(join(root, "catalog.yaml"), "utf8"));
const packFiles = (await walk(join(root, "packs")))
  .filter((path) => path.endsWith(".pack.yaml"))
  .sort();

if (packFiles.length === 0) fail("At least one pack definition is required.");

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "artifacts"), { recursive: true });
await mkdir(join(dist, "packs"), { recursive: true });
await mkdir(join(dist, "schemas"), { recursive: true });

const contracts = new Map();
const packs = [];
const artifactDigests = new Map();

for (const packFile of packFiles) {
  const definition = parse(await readFile(packFile, "utf8"));
  validatePackDefinition(definition, relative(root, packFile));

  const resources = [];
  const manifestResources = [];
  const installedTypes = [];
  for (const resource of definition.resources) {
    assertSafePath(resource.source, "resource source");
    assertSafePath(resource.target, "resource target");
    const sourcePath = resolve(root, resource.source);
    assertInside(root, sourcePath, "resource source");
    const document = await readFile(sourcePath, "utf8");
    const resourceDigest = digest(document);

    resources.push({ source: resource.source, document });
    manifestResources.push({
      kind: resource.kind,
      source: resource.source,
      target: resource.target,
      digest: resourceDigest,
    });

    const artifactPath = join(dist, "artifacts", resource.source);
    const existingDigest = artifactDigests.get(resource.source);
    if (existingDigest && existingDigest !== resourceDigest) {
      fail(`Artifact ${resource.source} has conflicting bytes.`);
    }
    artifactDigests.set(resource.source, resourceDigest);
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, document);
    if (resource.kind === "schema") {
      const schemaPath = join(dist, resource.source);
      await mkdir(dirname(schemaPath), { recursive: true });
      await writeFile(schemaPath, document);
    }

    if (resource.kind === "contract") {
      registerContract(resource.source, document, resourceDigest);
    }
    if (resource.kind === "type" && definition.catalog !== false) {
      validateEditableType(resource.source, document, definition.expand_local_refs === true);
      const frontmatter = matter(document).data;
      installedTypes.push({
        name: frontmatter.name,
        label: humanizeTypeName(frontmatter.name),
      });
    }
  }

  const provision = {
    manifest: {
      kind: "mdbase.type-pack",
      id: definition.id,
      version: definition.version,
      name: definition.name,
      description: definition.description,
      resources: manifestResources,
    },
    resources,
    provides: definition.provides,
  };
  const provisionDocument = json(provision);
  const provisionPath = `packs/${definition.id}/${definition.version}.json`;
  await mkdir(dirname(join(dist, provisionPath)), { recursive: true });
  await writeFile(join(dist, provisionPath), provisionDocument);

  if (definition.catalog !== false) {
    validateCatalogPresentation(definition, installedTypes, relative(root, packFile));
    packs.push({
      id: definition.id,
      version: definition.version,
      name: definition.name,
      description: definition.description,
      digest: digest(provisionDocument),
      provision: `./${provisionPath}`,
      provides: definition.provides,
      resource_count: definition.resources.length,
      display: definition.display,
      installation: {
        ...definition.installation,
        types: installedTypes,
      },
    });
  }
}

const catalog = {
  ...catalogSource,
  contracts: [...contracts.values()].sort(compareIdentity),
  packs: packs.sort(compareIdentity),
};
await writeFile(join(dist, "catalog.json"), json(catalog));
for (const version of [1, 2]) {
  await cp(
    join(root, "schemas", `catalog.v${version}.schema.json`),
    join(dist, "schemas", `catalog.v${version}.schema.json`),
  );
}

console.log(
  `Built ${catalog.contracts.length} contract and ${catalog.packs.length} pack into ${relative(root, dist)}.`,
);

function registerContract(source, document, resourceDigest) {
  const frontmatter = matter(document).data;
  if (frontmatter.kind !== "mdbase.contract") {
    fail(`Contract resource ${source} is not an mdbase.contract document.`);
  }
  for (const key of ["id", "version", "name", "description", "contract_type"]) {
    if (typeof frontmatter[key] !== "string" || frontmatter[key].length === 0) {
      fail(`Contract resource ${source} is missing ${key}.`);
    }
  }
  const identity = `${frontmatter.id}\0${frontmatter.version}`;
  const entry = {
    id: frontmatter.id,
    version: frontmatter.version,
    name: frontmatter.name,
    description: frontmatter.description,
    contract_type: frontmatter.contract_type,
    digest: resourceDigest,
    artifact: `./artifacts/${source}`,
    standards: frontmatter["x-standard"] ? [frontmatter["x-standard"]] : [],
  };
  const existing = contracts.get(identity);
  if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) {
    fail(`Contract ${frontmatter.id} ${frontmatter.version} has conflicting artifacts.`);
  }
  contracts.set(identity, entry);
}

function validateEditableType(source, document, requireExpandedReferences) {
  const frontmatter = matter(document).data;
  if (frontmatter.kind !== "mdbase.type") {
    fail(`Type resource ${source} is not an mdbase.type document.`);
  }
  if (
    !frontmatter.schema
    || typeof frontmatter.schema !== "object"
    || !frontmatter.schema.value
    || typeof frontmatter.schema.value !== "object"
    || Array.isArray(frontmatter.schema.value)
  ) {
    fail(`Catalog type resource ${source} must contain an editable schema.value snapshot.`);
  }
  if (frontmatter.schema.ref !== undefined) {
    fail(`Catalog type resource ${source} must not inherit a referenced schema.`);
  }
  if (requireExpandedReferences) {
    const expansion = expandLocalReferences(frontmatter.schema.value);
    if (expansion.expandedCount > 0) {
      fail(
        `Catalog type resource ${source} contains ${expansion.expandedCount} expandable local `
        + `${expansion.expandedCount === 1 ? "reference" : "references"}; run npm run expand:type.`,
      );
    }
  }
}

function validatePackDefinition(value, label) {
  if (!value || typeof value !== "object" || value.kind !== "mdbase.catalog-pack") {
    fail(`${label} must be an mdbase.catalog-pack object.`);
  }
  for (const key of ["id", "version", "name", "description"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      fail(`${label} is missing ${key}.`);
    }
  }
  if (value.catalog !== undefined && typeof value.catalog !== "boolean") {
    fail(`${label} catalog must be a boolean.`);
  }
  if (
    value.expand_local_refs !== undefined
    && typeof value.expand_local_refs !== "boolean"
  ) {
    fail(`${label} expand_local_refs must be a boolean.`);
  }
  if (!Array.isArray(value.provides) || value.provides.length === 0) {
    fail(`${label} must provide at least one contract.`);
  }
  if (!Array.isArray(value.resources) || value.resources.length === 0) {
    fail(`${label} must contain at least one resource.`);
  }
  const targets = new Set();
  for (const resource of value.resources) {
    if (!["contract", "type", "schema"].includes(resource?.kind)) {
      fail(`${label} contains an invalid resource kind.`);
    }
    if (typeof resource.source !== "string" || typeof resource.target !== "string") {
      fail(`${label} contains a resource without source and target paths.`);
    }
    if (!targets.add(resource.target)) fail(`${label} contains duplicate target ${resource.target}.`);
  }
}

function validateCatalogPresentation(definition, installedTypes, label) {
  const display = definition.display;
  if (!display || typeof display !== "object" || Array.isArray(display)) {
    fail(`${label} must declare display metadata.`);
  }
  for (const key of ["name", "summary", "category", "audience", "icon"]) {
    if (typeof display[key] !== "string" || display[key].length === 0) {
      fail(`${label} display is missing ${key}.`);
    }
  }
  if (!["people", "work", "research", "calendar", "infrastructure", "other"].includes(
    display.category,
  )) {
    fail(`${label} display.category is invalid.`);
  }
  if (!["general", "developer", "infrastructure"].includes(display.audience)) {
    fail(`${label} display.audience is invalid.`);
  }
  if (
    display.badges !== undefined
    && (
      !Array.isArray(display.badges)
      || display.badges.some((badge) => typeof badge !== "string" || badge.length === 0)
    )
  ) {
    fail(`${label} display.badges must contain non-empty strings.`);
  }

  const installation = definition.installation;
  if (!installation || typeof installation !== "object" || Array.isArray(installation)) {
    fail(`${label} must declare installation metadata.`);
  }
  if (!["default", "advanced", "hidden"].includes(installation.visibility)) {
    fail(`${label} installation.visibility is invalid.`);
  }
  if (!["user", "optional", "integration-managed"].includes(installation.recommendation)) {
    fail(`${label} installation.recommendation is invalid.`);
  }
  if (
    installation.caution !== undefined
    && (typeof installation.caution !== "string" || installation.caution.length === 0)
  ) {
    fail(`${label} installation.caution must be a non-empty string.`);
  }
  if (
    installation.primary_type !== null
    && typeof installation.primary_type !== "string"
  ) {
    fail(`${label} installation.primary_type must be a type name or null.`);
  }
  if (
    typeof installation.primary_type === "string"
    && !installedTypes.some(({ name }) => name === installation.primary_type)
  ) {
    fail(
      `${label} installation.primary_type ${installation.primary_type} is not installed by the pack.`,
    );
  }
}

function humanizeTypeName(name) {
  const parts = name.split(/[\s_-]+/u).filter(Boolean);
  return parts
    .map((part, index) => index === 0 ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(path));
    else paths.push(path);
  }
  return paths;
}

function assertSafePath(path, label) {
  if (
    typeof path !== "string"
    || path.length === 0
    || path.startsWith("/")
    || path.includes("\\")
    || path.split("/").includes("..")
  ) {
    fail(`Unsafe ${label}: ${JSON.stringify(path)}.`);
  }
}

function assertInside(parent, child, label) {
  const path = relative(parent, child);
  if (path === ".." || path.startsWith(`..${sep}`)) fail(`${label} escapes the repository.`);
}

function compareIdentity(left, right) {
  return `${left.id}\0${left.version}`.localeCompare(`${right.id}\0${right.version}`);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fail(message) {
  throw new Error(message);
}
