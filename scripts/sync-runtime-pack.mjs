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
  await cp(from, to);
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
  provides: [
    "mdbase.runtime.workflow",
    "mdbase.runtime.policy",
    "mdbase.runtime.provider-registration",
    "mdbase.runtime.capability-grant",
    "mdbase.runtime.run",
    "mdbase.runtime.action-attempt",
    "mdbase.runtime.checkpoint",
    "mdbase.runtime.timer",
    "mdbase.runtime.diagnostic",
    "mdbase.runtime.dead-letter"
  ].map((id) => ({ id, version: "1.0.0" })),
  resources
};
const packPath = join(root, "packs/mdbase.runtime.standard/0.2.0.pack.yaml");
await mkdir(dirname(packPath), { recursive: true });
await writeFile(packPath, stringify(definition, { lineWidth: 0 }), "utf8");

console.log(`Synced ${resources.length} runtime resources from ${sourceRoot}.`);

function catalogSource(resource) {
  if (resource.kind === "contract") {
    return resource.source.replace(/^_contracts\//u, "contracts/");
  }
  if (resource.kind === "type") {
    return resource.source.replace(/^_types\//u, "types/mdbase-runtime/");
  }
  return resource.source;
}
