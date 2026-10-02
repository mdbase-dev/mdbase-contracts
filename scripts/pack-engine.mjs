import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cliPackEngine } from "./cli-pack-engine.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

/** The mdbase-ts build the checks import; CI pins it in sources.json. */
export const mdbase = await import(
  pathToFileURL(join(resolve(process.env.MDBASE_TS_DIR ?? join(root, "..", "mdbase")), "dist/index.js")).href
);

/** Which engine installs packs: the Rust mdbase CLI when MDBASE_VERIFY_CLI is set, otherwise mdbase-ts. */
export const packEngineName = process.env.MDBASE_VERIFY_CLI ? "mdbase CLI" : "mdbase-ts";

/**
 * A pack installer with one interface for both engines: assess(adoptions)
 * and apply(digest, adoptions) return v0.3 operation results.
 */
export async function packEngine(collectionRoot, provision, installedBy) {
  if (process.env.MDBASE_VERIFY_CLI) {
    return cliPackEngine(process.env.MDBASE_VERIFY_CLI, collectionRoot, provision, installedBy);
  }
  return {
    assess: async (adoptions = {}) => mdbase.assessTypePack(collectionRoot, provision, {
      installedBy, adoptResources: adoptions,
    }),
    apply: async (digest, adoptions = {}) => mdbase.applyTypePack(collectionRoot, provision, {
      installedBy, adoptResources: adoptions, expectedAssessmentDigest: digest,
    }),
    close: async () => {},
  };
}
