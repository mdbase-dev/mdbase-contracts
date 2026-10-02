import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

function adoptionArgs(adoptions) {
  return Object.entries(adoptions).flatMap(([target, digest]) => ["--adopt", `${target}=${digest}`]);
}

/** Installs packs through the Rust-engine mdbase CLI (`mdbase packs assess|apply`). */
export async function cliPackEngine(command, collectionRoot, provision, installedBy) {
  const bundle = await mkdtemp(join(tmpdir(), "mdbase-catalog-pack-"));
  const close = () => rm(bundle, { recursive: true, force: true });
  try {
    const manifest = join(bundle, "manifest.json");
    await writeFile(manifest, JSON.stringify(provision.manifest));
    for (const resource of provision.resources) {
      const path = resolve(bundle, "sources", resource.source);
      if (!path.startsWith(join(bundle, "sources") + sep)) {
        throw new Error("Pack source escapes verification bundle.");
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, resource.document);
    }
    function run(operation, extra = []) {
      const result = spawnSync(command, ["-C", collectionRoot, "--json", "packs", operation,
        "--manifest", manifest, "--resources", join(bundle, "sources"),
        "--installed-by", installedBy, ...extra], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      if (result.error) throw result.error;
      return JSON.parse(result.stdout || result.stderr);
    }
    return {
      assess: async (adoptions = {}) => run("assess", adoptionArgs(adoptions)),
      apply: async (digest, adoptions = {}) => run("apply", ["--assessment-digest", digest, ...adoptionArgs(adoptions)]),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
