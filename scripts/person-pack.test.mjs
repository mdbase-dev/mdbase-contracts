import assert from "node:assert/strict";
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
  const assessment = valid(await assessTypePack(collectionRoot, input, options));
  valid(await applyTypePack(collectionRoot, input, {
    ...options, expectedAssessmentDigest: assessment.assessment_digest,
  }));
}

for (const versions of [["1.1.0"], ["1.0.0", "1.1.0"]]) {
  test(`person and contact types coexist: ${versions.join(" then ")}`, async () => {
    const collectionRoot = await mkdtemp(join(tmpdir(), "mdbase-person-pack-"));
    let collection;
    try {
      await writeFile(join(collectionRoot, "mdbase.yaml"),
        "spec_version: 0.3.0\nsettings:\n  validation: error\n");
      let customizedContact;
      for (const version of versions) {
        await install(collectionRoot, version);
        if (version === "1.0.0") {
          const typePath = join(collectionRoot, "_types/contact.md");
          customizedContact = (await readFile(typePath, "utf8"))
            .replace("A person or organisation you want to stay in touch with", "My collection-owned contact type");
          await writeFile(typePath, customizedContact);
        }
      }
      if (customizedContact) {
        assert.equal(await readFile(join(collectionRoot, "_types/contact.md"), "utf8"), customizedContact,
          "pack upgrade must preserve the user's customized Contact type");
      }
      const opened = await Collection.open(collectionRoot);
      assert.equal(opened.error, undefined);
      collection = opened.collection;
      assert.ok(collection);
      assert.equal(collection.getDataContractImplementations("mdbase.contact", "1.0.0").length, 2);
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
    } finally {
      await collection?.close();
      await rm(collectionRoot, { recursive: true, force: true });
    }
  });
}
