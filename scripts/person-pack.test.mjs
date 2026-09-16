import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cliPackEngine } from "./cli-pack-engine.mjs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const mdbaseDir = resolve(process.env.MDBASE_TS_DIR ?? join(root, "..", "mdbase"));
const { Collection, applyTypePack, assessTypePack } = await import(
  pathToFileURL(join(mdbaseDir, "dist/index.js")).href
);

test("the catalog offers only the single-type People starter", async () => {
  const catalog = JSON.parse(await readFile(join(root, "dist/catalog.json"), "utf8"));
  const packs = catalog.packs.filter(({ id, installation }) => id === "mdbase.contact" && installation.visibility !== "hidden");
  assert.deepEqual(packs.map(({ version }) => version), ["1.2.0"]);
  assert.deepEqual(packs[0].installation.types.map(({ name }) => name), ["person"]);
  assert.equal(packs[0].installation.primary_type, "person");
});

test("previously distributed Contact provisions remain byte-identical", async () => {
  for (const [version, digest] of [
    ["1.0.0", "70c3ab048da407a56fe265a840c83a2d1df90aa351fde0d50ce1459a155cc4e9"],
    ["1.1.0", "14bba55df0574401b46ae08e5ef1e41e615d1477f70c3cc202eb9ff179287864"],
  ]) {
    const bytes = await readFile(join(root, "dist/packs/mdbase.contact", `${version}.json`));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
  }
});

function valid(result) {
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  return result.result;
}

async function install(collectionRoot, version) {
  const provision = JSON.parse(await readFile(
    join(root, "dist/packs/mdbase.contact", `${version}.json`), "utf8",
  ));
  // Only the immutable legacy pack needs compatibility. Test the new pack's
  // exact distributed bytes: live hosted engines require explicit modes.
  if (version !== "1.0.0") assert.ok(provision.manifest.resources.every((resource) => ["seed", "managed"].includes(resource.mode)));
  const input = version !== "1.0.0" ? provision : {
    ...provision,
    manifest: {
      ...provision.manifest,
      resources: provision.manifest.resources.map((resource) => ({
        ...resource,
        mode: resource.mode ?? (resource.kind === "type" ? "seed" : "managed"),
      })),
    },
  };
  const options = { installedBy: "dev.mdbase.first-party" };
  if (process.env.MDBASE_VERIFY_CLI) {
    const engine = await cliPackEngine(process.env.MDBASE_VERIFY_CLI, collectionRoot, input, options.installedBy);
    try { const assessment = valid(await engine.assess()); valid(await engine.apply(assessment.assessment_digest)); }
    finally { await engine.close(); }
  } else {
    const assessment = valid(await assessTypePack(collectionRoot, input, options));
    valid(await applyTypePack(collectionRoot, input, {
      ...options, expectedAssessmentDigest: assessment.assessment_digest,
    }));
  }
}

for (const versions of [["1.1.0"], ["1.0.0", "1.1.0"], ["1.2.0"], ["1.0.0", "1.2.0"], ["1.1.0", "1.2.0"]]) {
  test(`one fresh Person type, legacy contacts preserved: ${versions.join(" then ")}`, async () => {
    const collectionRoot = await mkdtemp(join(tmpdir(), "mdbase-person-pack-"));
    let collection;
    try {
      await writeFile(join(collectionRoot, "mdbase.yaml"),
        "spec_version: 0.3.0\nsettings:\n  validation: error\n");
      let customizedContact;
      let customizedPerson;
      const legacyContact = "---\ntype: contact\nname: Existing contact\nid: legacy_contact\nprivate_notes: Keep me\n---\nOriginal **contact** body.\n";
      const legacyPerson = "---\ntype: person\nname: Existing person\nid: legacy_person\n---\nOriginal **person** body.\n";
      const hasContact = versions.some((version) => version !== "1.2.0");
      for (const version of versions) {
        await install(collectionRoot, version);
        if (version !== "1.2.0") {
          const typePath = join(collectionRoot, "_types/contact.md");
          customizedContact = (await readFile(typePath, "utf8")) + "\nMy collection-owned Contact documentation.\n";
          await writeFile(typePath, customizedContact);
          await writeFile(join(collectionRoot, "legacy-contact.md"), legacyContact);
        }
        if (version === "1.1.0") {
          const typePath = join(collectionRoot, "_types/person.md");
          customizedPerson = (await readFile(typePath, "utf8")) + "\nMy collection-owned Person documentation.\n";
          await writeFile(typePath, customizedPerson);
          await writeFile(join(collectionRoot, "legacy-person.md"), legacyPerson);
        }
      }
      if (customizedContact) {
        assert.equal(await readFile(join(collectionRoot, "_types/contact.md"), "utf8"), customizedContact,
          "pack upgrade must preserve the user's customized Contact type");
      }
      if (customizedPerson) assert.equal(await readFile(join(collectionRoot, "_types/person.md"), "utf8"), customizedPerson);
      if (hasContact) assert.equal(await readFile(join(collectionRoot, "legacy-contact.md"), "utf8"), legacyContact);
      if (customizedPerson) assert.equal(await readFile(join(collectionRoot, "legacy-person.md"), "utf8"), legacyPerson);
      if (!hasContact) await assert.rejects(readFile(join(collectionRoot, "_types/contact.md")), { code: "ENOENT" });
      const opened = await Collection.open(collectionRoot);
      assert.equal(opened.error, undefined);
      collection = opened.collection;
      assert.ok(collection);
      assert.equal(collection.getDataContractImplementations("mdbase.contact", "1.0.0").length, hasContact ? 2 : 1);
      assert.equal(collection.getDataContractImplementations("mdbase.person", "1.0.0").length, 1);
      const operations = collection.v03Operations();
      const frontmatter = {
        type: "person", id: "person_one", name: "Callum",
        identities: [{ issuer: "https://connect.example", subject: "usr_one" }],
      };
      valid(await operations.create({ path: "people/callum.md", frontmatter }));
      const duplicate = await operations.create({ path: "people/duplicate.md", frontmatter });
      assert.equal(duplicate.valid, false, "starter must reject duplicate person IDs");
      valid(await operations.rename({ from: "people/callum.md", to: "contacts/callum.md" }));
      const document = await readFile(join(collectionRoot, "contacts/callum.md"), "utf8");
      assert.match(document, /person_one/);
      assert.match(document, /usr_one/);
      valid(await operations.create({
        path: "people/local.md", frontmatter: { type: "person", id: "person_local", name: "Local contact" },
      }));
      if (!hasContact) {
        valid(await operations.create({ path: "people/details.md", frontmatter: { type: "person", id: "person_details", name: "With contact details", email: "local@example.com", phone: "+44 20 1234 5678", organisation: "Example", birthday: "2000-01-02" } }));
      } else {
        const contact = valid(await operations.create({
          path: "contacts/existing.md", body: "Keep this **Markdown** body.",
          frontmatter: { type: "contact", id: "contact_existing", name: "Existing contact", email: "local@example.com", private_notes: "Collection-owned data" },
        }));
        const converted = valid(await operations.update({
          path: "contacts/existing.md", if_revision: String(contact.revision),
          fields: { type: "person", identities: [{ issuer: "https://connect.example", subject: "existing_account" }] },
        }));
        assert.equal(converted.frontmatter.id, "contact_existing");
        assert.equal(converted.frontmatter.name, "Existing contact");
        assert.equal(converted.frontmatter.email, "local@example.com");
        assert.equal(converted.frontmatter.private_notes, "Collection-owned data");
        assert.match(await readFile(join(collectionRoot, "contacts/existing.md"), "utf8"), /Keep this \*\*Markdown\*\* body\./);
        const stale = await operations.update({ path: "contacts/existing.md", if_revision: String(contact.revision), fields: { name: "Stale overwrite" } });
        assert.equal(stale.valid, false, "conversion must not bypass revision checks");
      }
    } finally {
      await collection?.close();
      await rm(collectionRoot, { recursive: true, force: true });
    }
  });
}
