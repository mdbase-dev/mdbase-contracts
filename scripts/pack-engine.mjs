import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/**
 * The mdbase engine the checks run: the `mdbase` package built from
 * mdbase-connect's `runtime/packages/mdbase` (the same core as the daemon and
 * the Obsidian plugin). CI builds it at the commit pinned in sources.json.
 */
const packageDir = resolve(process.env.MDBASE_DIR ?? join(root, "..", "mdbase-connect", "runtime", "packages", "mdbase"));
const load = (entry) => import(pathToFileURL(join(packageDir, "dist", entry)).href);
export const mdbase = await load("index.js");
export const { Collection } = await load("node/index.js");

export const packEngineName = `mdbase ${mdbase.VERSION}`;

/** Every collection file the engine reads as a resource: all but `.mdbase/` and hidden folders. */
export async function collectionResources(collectionRoot) {
  const resources = {};
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) resources[relative(collectionRoot, path).split(sep).join("/")] = await readFile(path, "utf8");
    }
  }
  await walk(collectionRoot);
  return resources;
}

/** The contract implementations a collection's installed types declare. */
export async function contractImplementations(collectionRoot, id, version) {
  const catalog = await mdbase.loadCatalog(await collectionResources(collectionRoot));
  return catalog.implementations.filter((i) => i.contract === id && i.version === version);
}

/** Run an engine call as a v0.3-style result: `{ valid, result }` or `{ valid: false, diagnostics }`. */
export async function attempt(run) {
  try {
    return { valid: true, result: await run() };
  } catch (error) {
    if (!(error instanceof mdbase.MdbaseError)) throw error;
    return { valid: false, diagnostics: [diagnostic(error)] };
  }
}

function diagnostic(error) {
  return { code: error.code, message: error.message, help: error.help, details: error.details };
}

/**
 * A pack installer over a collection folder: assess(adoptions) and
 * apply(digest, adoptions) return `{ valid, result, diagnostics }`. Apply
 * writes the engine's exact `writes` and `deletes`, including the lock.
 */
export async function packEngine(collectionRoot, provision, installedBy) {
  const pack = {
    manifest: JSON.stringify(provision.manifest),
    sources: Object.fromEntries(provision.resources.map(({ source, document }) => [source, document])),
  };
  const options = (adoptions) => ({ installed_by: installedBy, adopt: adoptions });
  const assess = async (adoptions) => mdbase.assessTypePack({
    pack, resources: await collectionResources(collectionRoot), options: options(adoptions),
  });
  // `live` is already the target's current digest; add the installed one from the receipt.
  const describe = (assessment) => ({
    ...assessment,
    resources: assessment.resources.map((resource) => {
      const installed = assessment.current?.resources.find(({ target }) => target === resource.target);
      return {
        ...resource,
        current_digest: resource.live ?? undefined,
        installed_digest: installed?.digest,
      };
    }),
  });
  return {
    assess: async (adoptions = {}) => {
      const outcome = await attempt(async () => describe(await assess(adoptions)));
      if (outcome.valid) outcome.diagnostics = outcome.result.issues;
      return outcome;
    },
    apply: async (expectedDigest, adoptions = {}) => {
      const outcome = await attempt(async () => {
        const application = await mdbase.applyTypePack({
          pack, resources: await collectionResources(collectionRoot), options: options(adoptions), expectedDigest,
        });
        for (const { path, document } of application.writes) {
          const target = resolve(collectionRoot, path);
          if (!target.startsWith(resolve(collectionRoot) + sep)) throw new Error(`Pack write escapes the collection: ${path}`);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, document);
        }
        for (const path of application.deletes) await rm(resolve(collectionRoot, path), { force: true });
        return describe(application.assessment);
      });
      if (!outcome.valid) {
        // Say why: the assessment's issues and conflicting resources, as the refusal alone does not.
        const assessment = await assess(adoptions).catch(() => null);
        if (assessment) {
          outcome.diagnostics.push(...assessment.issues, ...assessment.resources
            .filter(({ action }) => action === "conflict")
            .map(({ target, reason }) => ({ code: "type_pack_conflict", target, reason })));
        }
      }
      return outcome;
    },
    close: async () => {},
  };
}
