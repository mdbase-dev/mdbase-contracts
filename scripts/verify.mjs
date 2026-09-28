import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { cliPackEngine } from "./cli-pack-engine.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const catalog = json(await readFile(join(dist, "catalog.json"), "utf8"));
const catalogSchema = json(
  await readFile(join(root, `schemas/catalog.v${catalog.catalog_version}.schema.json`), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

if (!ajv.validate(catalogSchema, catalog)) {
  fail(`Catalog is invalid:\n${ajv.errorsText(ajv.errors, { separator: "\n" })}`);
}

const mdbaseDir = resolve(process.env.MDBASE_TS_DIR ?? join(root, "..", "mdbase"));
const mdbaseEntry = join(mdbaseDir, "dist", "index.js");
const { Collection, applyTypePack, assessTypePack } = await import(
  pathToFileURL(mdbaseEntry).href
);

for (const contract of catalog.contracts) {
  const artifact = await readCatalogArtifact(contract.artifact);
  assertDigest(artifact, contract.digest, `contract ${contract.id} ${contract.version}`);
}

for (const pack of catalog.packs) {
  const provisionDocument = await readCatalogArtifact(pack.provision);
  assertDigest(provisionDocument, pack.digest, `pack ${pack.id} ${pack.version}`);
  const provision = json(provisionDocument);
  const installProvision = withLegacyResourceModes(provision);

  for (const definition of provision.manifest.resources) {
    const resource = provision.resources.find(({ source }) => source === definition.source);
    if (!resource) fail(`Pack ${pack.id} is missing source ${definition.source}.`);
    assertDigest(resource.document, definition.digest, `resource ${definition.source}`);
    const artifact = await readFile(join(dist, "artifacts", definition.source), "utf8");
    if (artifact !== resource.document) {
      fail(`Published artifact ${definition.source} differs from its embedded pack resource.`);
    }
    if (definition.kind === "schema") {
      const schema = await readFile(join(dist, definition.source), "utf8");
      if (schema !== resource.document) {
        fail(`Published schema ${definition.source} differs from its embedded pack resource.`);
      }
    }
  }

  const collectionRoot = await mkdtemp(join(tmpdir(), "mdbase-contract-catalog-"));
  let engine;
  try {
    await writeFile(
      join(collectionRoot, "mdbase.yaml"),
      "spec_version: 0.3.0\nsettings:\n  validation: error\n",
    );
    const assessmentOptions = { installedBy: catalog.id };
    engine = process.env.MDBASE_VERIFY_CLI
      ? await cliPackEngine(process.env.MDBASE_VERIFY_CLI, collectionRoot, installProvision, catalog.id)
      : {
        assess: () => assessTypePack(collectionRoot, installProvision, assessmentOptions),
        apply: (digest) => applyTypePack(collectionRoot, installProvision, {
          ...assessmentOptions, expectedAssessmentDigest: digest,
        }),
      };
    const dryRun = await engine.assess();
    assertValid(dryRun, `${pack.id} dry run`);
    if (dryRun.result.resources.some(({ action }) => action !== "create")) {
      fail(`${pack.id} dry run did not plan only creates.`);
    }

    assertValid(await engine.apply(dryRun.result.assessment_digest), `${pack.id} install`);
    const repeatedAssessment = await engine.assess();
    assertValid(repeatedAssessment, `${pack.id} repeat assessment`);
    const repeated = await engine.apply(repeatedAssessment.result.assessment_digest);
    assertValid(repeated, `${pack.id} repeat install`);
    if (
      repeated.result.resources.some(
        ({ action }) => action !== "unchanged" && action !== "preserve",
      )
    ) {
      fail(`${pack.id} repeat install is not idempotent.`);
    }

    const opened = await Collection.open(collectionRoot);
    if (!opened.collection || opened.error) {
      fail(`${pack.id} could not be reopened: ${opened.error?.message ?? "unknown error"}.`);
    }
    try {
      for (const provided of pack.provides) {
        const implementations = opened.collection.getDataContractImplementations(
          provided.id,
          provided.version,
        );
        if (implementations.length === 0) {
          fail(`${pack.id} provides ${provided.id} ${provided.version} without an implementation.`);
        }
      }
    } finally {
      await opened.collection.close();
    }
  } finally {
    await engine?.close?.();
    await rm(collectionRoot, { recursive: true, force: true });
  }
}

console.log(`Verified ${catalog.contracts.length} contract and ${catalog.packs.length} pack.`);

async function readCatalogArtifact(relativeUrl) {
  if (typeof relativeUrl !== "string" || !relativeUrl.startsWith("./")) {
    fail(`Invalid catalog artifact URL: ${JSON.stringify(relativeUrl)}.`);
  }
  return readFile(join(dist, relativeUrl.slice(2)), "utf8");
}

function assertDigest(document, expected, label) {
  const actual = `sha256:${createHash("sha256").update(document).digest("hex")}`;
  if (actual !== expected) fail(`${label} has digest ${actual}; expected ${expected}.`);
}

function withLegacyResourceModes(provision) {
  if (provision.manifest.resources.every(({ mode }) => mode !== undefined)) {
    return provision;
  }
  return {
    ...provision,
    manifest: {
      ...provision.manifest,
      resources: provision.manifest.resources.map((resource) => ({
        ...resource,
        mode: resource.kind === "type" ? "seed" : "managed",
      })),
    },
  };
}

function assertValid(result, label) {
  if (!result.valid) {
    fail(`${label} failed:\n${JSON.stringify(result.diagnostics, null, 2)}`);
  }
}

function json(document) {
  return JSON.parse(document);
}

function fail(message) {
  throw new Error(message);
}
