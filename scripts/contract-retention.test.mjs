import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { compareVersions, publishedProvisions } from "./pack-versions.mjs";

// A type implements one exact contract version. A collection set up by any
// earlier version of a pack may hold types that still implement a contract
// that version installed: a customised or renamed starter, or a type of the
// collection's own. If the offered pack no longer installs that contract, the
// type is left invalid and engines refuse the whole upgrade. So the offered
// pack must keep installing every contract document an earlier version shipped.

const dist = new URL("../dist/", import.meta.url);
const catalog = JSON.parse(await readFile(new URL("catalog.json", dist), "utf8"));
const contracts = (provision) => provision.manifest.resources.filter(({ kind }) => kind === "contract");

const all = await publishedProvisions();
const offered = catalog.packs.filter(({ installation }) => installation.visibility !== "hidden");

for (const entry of offered) {
  test(`${entry.id} ${entry.version} keeps every contract an earlier version installed`, () => {
    const provision = all.get(entry.id).find(({ manifest }) => manifest.version === entry.version);
    const kept = new Set(contracts(provision).map(({ digest }) => digest));
    const missing = new Set();
    for (const earlier of all.get(entry.id)) {
      if (compareVersions(earlier.manifest.version, entry.version) >= 0) continue;
      for (const shipped of contracts(earlier)) {
        if (!kept.has(shipped.digest)) missing.add(`${shipped.source} (${earlier.manifest.version})`);
      }
    }
    assert.deepEqual([...missing], [], `${entry.id} ${entry.version} must also install ${[...missing].join(", ")}`);
  });
}
