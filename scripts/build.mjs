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
  const providedContracts = new Map();
  for (const resource of definition.resources) {
    assertSafePath(resource.source, "resource source");
    assertSafePath(resource.target, "resource target");
    const sourcePath = resolve(root, resource.source);
    assertInside(root, sourcePath, "resource source");
    const document = await readFile(sourcePath, "utf8");
    const resourceDigest = digest(document);
    const upgradeFrom = resource.upgrade_from === undefined
      ? undefined
      : await upgradeBaselines(resource, document, resourceDigest, relative(root, packFile));
    resources.push({ source: resource.source, document });
    manifestResources.push({
      kind: resource.kind,
      ...(resource.mode ? { mode: resource.mode } : {}),
      source: resource.source,
      target: resource.target,
      digest: resourceDigest,
      ...(upgradeFrom ? { upgrade_from: upgradeFrom } : {}),
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

    if (resource.kind === "contract" && definition.catalog !== false) {
      registerContract(resource.source, document, resourceDigest);
      const reference = await contractReference(sourcePath, document);
      providedContracts.set(`${reference.id}\0${reference.version}`, reference);
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

  const provides = definition.catalog === false
    ? definition.provides
    : definition.provides.map((provided) => {
      const contract = providedContracts.get(`${provided.id}\0${provided.version}`);
      if (!contract) {
        fail(
          `${relative(root, packFile)} provides ${provided.id} ${provided.version} `
          + "without including its contract artifact.",
        );
      }
      if (provided.digest !== undefined && provided.digest !== contract.digest) {
        fail(
          `${relative(root, packFile)} declares the wrong digest for `
          + `${provided.id} ${provided.version}.`,
        );
      }
      return {
        id: provided.id,
        version: provided.version,
        digest: contract.digest,
      };
    });

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
    provides,
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
      provides,
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

/**
 * A seed type's upgrade baselines (mdbase spec 05A). The single-path form
 * keeps emitting one `{ digest, document }` baseline, so published packs stay
 * byte-identical; a list emits `[{ digest, version, document }]`, newest first.
 */
async function upgradeBaselines(resource, desired, desiredDigest, label) {
  const at = `${label} ${resource.target} upgrade_from`;
  if (resource.kind !== "type" || resource.mode !== "seed") {
    fail(`${at}: only seed types may declare an upgrade baseline.`);
  }
  const list = Array.isArray(resource.upgrade_from);
  const paths = list ? resource.upgrade_from : [resource.upgrade_from];
  if (paths.length === 0) fail(`${at}: a baseline list must not be empty.`);
  const desiredType = matter(desired).data;
  const seen = new Set();
  const baselines = [];
  for (const path of paths) {
    assertSafePath(path, "upgrade baseline");
    const baselinePath = resolve(root, path);
    assertInside(root, baselinePath, "upgrade baseline");
    const document = await readFile(baselinePath, "utf8");
    const baselineDigest = digest(document);
    if (baselineDigest === desiredDigest) fail(`${at}: ${path} is the resource's own document.`);
    if (seen.has(baselineDigest)) fail(`${at}: ${path} repeats an earlier baseline.`);
    seen.add(baselineDigest);
    const frontmatter = matter(document).data;
    if (frontmatter.kind !== desiredType.kind || frontmatter.name !== desiredType.name) {
      fail(`${at}: ${path} must have the same type kind and name as ${resource.source}.`);
    }
    if (frontmatter.version !== undefined && !Number.isInteger(frontmatter.version)) {
      fail(`${at}: ${path} must declare an integer type version.`);
    }
    baselines.push({
      digest: baselineDigest,
      ...(frontmatter.version === undefined ? {} : { version: frontmatter.version }),
      document,
    });
  }
  if (!list) return { digest: baselines[0].digest, document: baselines[0].document };
  // Newest first; Array.prototype.sort is stable, so equal versions keep their order.
  return baselines.sort((left, right) => (right.version ?? -Infinity) - (left.version ?? -Infinity));
}

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

async function contractReference(sourcePath, document) {
  const frontmatter = matter(document).data;
  const contractType = frontmatter.contract_type;
  const portable = {
    kind: frontmatter.kind,
    contract_type: contractType,
    id: frontmatter.id,
    version: frontmatter.version,
  };
  for (const field of schemaFieldsForContractType(contractType)) {
    const wrapper = frontmatter[field];
    if (wrapper === undefined) continue;
    if (!isPlainObject(wrapper)) {
      fail(`${relative(root, sourcePath)} ${field} must be a schema wrapper.`);
    }
    if (Object.hasOwn(wrapper, "value")) {
      portable[field] = wrapper.value;
      continue;
    }
    if (typeof wrapper.ref !== "string" || wrapper.ref.length === 0) {
      fail(`${relative(root, sourcePath)} ${field} must contain value or ref.`);
    }
    const schemaPath = resolve(dirname(sourcePath), wrapper.ref);
    assertInside(root, schemaPath, `${relative(root, sourcePath)} ${field} ref`);
    portable[field] = JSON.parse(await readFile(schemaPath, "utf8"));
  }
  if (contractType === "action" && isPlainObject(frontmatter.behavior)) {
    portable.behavior = frontmatter.behavior;
  }
  return {
    id: frontmatter.id,
    version: frontmatter.version,
    digest: digestCanonical(portable),
  };
}

function schemaFieldsForContractType(contractType) {
  if (contractType === "record") return ["record_schema", "binding_schema"];
  if (contractType === "event") return ["data_schema", "source_schema"];
  if (contractType === "action") {
    return ["input_schema", "output_schema", "error_schema", "provider_schema"];
  }
  fail(`Unsupported contract type ${JSON.stringify(contractType)}.`);
}

function digestCanonical(value) {
  return digest(canonicalJson(value));
}

function canonicalJson(value) {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
  ) return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("Canonical JSON does not allow non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  fail(`Canonical JSON cannot encode ${typeof value}.`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    if (
      resource.mode !== undefined
      && !["managed", "seed"].includes(resource.mode)
    ) {
      fail(`${label} contains an invalid resource mode.`);
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
