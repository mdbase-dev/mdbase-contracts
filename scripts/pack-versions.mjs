import { readdir, readFile } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);

/** Every published provision by pack id, listed or not (`catalog: false` URLs stay installable). */
export async function publishedProvisions() {
  const byId = new Map();
  for (const id of (await readdir(new URL("packs/", dist))).sort()) {
    const versions = [];
    for (const file of await readdir(new URL(`packs/${id}/`, dist))) {
      versions.push(JSON.parse(await readFile(new URL(`packs/${id}/${file}`, dist), "utf8")));
    }
    byId.set(id, versions.sort((left, right) => compareVersions(left.manifest.version, right.manifest.version)));
  }
  return byId;
}

/** Seed type resources; legacy packs without modes install types as seeds. */
export function seedTypes(provision) {
  return provision.manifest.resources.filter((resource) =>
    resource.kind === "type" && (resource.mode ?? "seed") === "seed");
}

/** A seed type's upgrade baselines: one, or a list (mdbase spec 05A). */
export function baselines(resource) {
  if (resource.upgrade_from === undefined) return [];
  return Array.isArray(resource.upgrade_from) ? resource.upgrade_from : [resource.upgrade_from];
}

/** The provision with the modes legacy engines defaulted (types seed, others managed). */
export function withLegacyResourceModes(provision) {
  if (provision.manifest.resources.every(({ mode }) => mode !== undefined)) return provision;
  return {
    ...provision,
    manifest: {
      ...provision.manifest,
      resources: provision.manifest.resources.map((resource) => ({
        ...resource,
        mode: resource.mode ?? (resource.kind === "type" ? "seed" : "managed"),
      })),
    },
  };
}

/** SemVer 2.0.0 precedence, including numeric prerelease identifiers (rc.9 < rc.12). */
export function compareVersions(left, right) {
  const split = (version) => {
    const [core, prerelease] = version.split("+")[0].split(/-(.*)/su);
    return { core: core.split(".").map(Number), prerelease: prerelease ? prerelease.split(".") : [] };
  };
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  const numeric = /^\d+$/u;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    if (numeric.test(x) && numeric.test(y)) return Number(x) - Number(y);
    if (numeric.test(x) !== numeric.test(y)) return numeric.test(x) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
