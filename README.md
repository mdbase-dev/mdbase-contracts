# mdbase contracts

First-party, versioned data contracts and transactional type packs for mdbase
collections.

Record contracts describe compact, application-facing semantics rather than
storage layouts or external interchange formats. Their field names and schemas
should say what an application can rely on while leaving collections free to
choose local field names through explicit type mappings. Contract-specific
behavior such as workflow vocabularies belongs in a validated `binding_schema`.

Published contract schemas are immutable interoperability boundaries. A
catalog-listed starter type contains an inline snapshot of its starting schema
instead of inheriting that boundary. Once installed, the type belongs to the
collection: users can edit its fields and update the explicit contract mapping
without changing the published contract. Packs authored with
`expand_local_refs: true` expand every non-recursive local JSON Schema reference
so nested fields remain directly editable. Recursive references remain explicit
because they cannot be finitely expanded.

The featured `mdbase.runtime.standard` pack supplies the durable runtime 0.2
standard library: ten ordinary record contracts and canonical implementing
types, the four canonical record-change events, and inspectable timer-event
and cancellation-action artifacts.
Installing it is passive and grants no execution authority.

The `mdbase.contact` 1.2.0 pack offers one **Person** starter with portable IDs,
editable issuer/subject account associations, and optional contact details. It
implements both `mdbase.person` and `mdbase.contact`, so apps use the same notes.
The pack keeps the existing resource owner, but no longer adds a separate Contact
type to fresh collections. Older Contact types, notes, and customized Person types
are preserved; there is no automatic migration. Older pack artifacts remain
byte-identical at their versioned paths, but only the current pack is offered in the
catalog. Person starter v2 adds field-level descriptions and usage guidance without
changing validation or contract mappings. Pack resources
explicitly use `managed` for schemas/contracts and `seed` for editable starter
types; install tests exercise the exact generated payload without supplying
missing modes. Associations are ordinary collection data, never
authentication or membership authority. See
[`mdbase.person` 1.0.0](contracts/mdbase.person/1.0.0.md) for matching,
ambiguity, privacy, and lifecycle semantics.

The `tasknotes.task` pack is the canonical application-provisioned TaskNotes
contract bundle. TaskNotes clients embed the published provision byte-for-byte
and pin its catalog digest so independently deployed clients cannot drift onto
different managed-pack versions.

This repository is the canonical source. Its deterministic `dist/` output is
published at `https://mdbase.dev/contracts/`. A catalog entry is only a
discovery aid: every installable pack contains an exact manifest, embedded
source documents, and SHA-256 digests.

## Repository layout

```text
catalog.yaml                       catalog identity and presentation
contracts/<id>/<version>.md        contract source documents
types/<name>/<version>.md          default implementing types
schemas/<id>/<version>.json        referenced JSON Schemas
packs/<id>/<version>.pack.yaml     readable pack definitions
dist/                              deterministic publication artifact
```

The runtime pack is generated in `mdbase-spec`. Contract and schema artifacts
are imported byte-for-byte; its referenced canonical types are materialized as
editable inline schema snapshots for the catalog:

```sh
MDBASE_SPEC_DIR=../mdbase-spec npm run sync:runtime
```

## Build and verify

Requires Node.js 22+ and a built checkout of
[`@callumalpass/mdbase`](https://github.com/callumalpass/mdbase). A sibling
`../mdbase` checkout is used by default; set `MDBASE_TS_DIR` to override it.

```sh
npm install
npm run build
npm run verify
```

When authoring a starter from an existing inline schema, expand its local
references before adding it to a listed pack:

```sh
npm run expand:type -- types/example/1.md types/example/2.md
```

Verification checks the catalog schema, every resource digest, a transactional
dry run, a real install, idempotent reinstallation, and the declared contract
implementations.

The TaskNotes rc.14 candidate explicitly upgrades the rc.12 starter using a
digest-pinned baseline. It requires an engine with seed-upgrade support; older
engines reject it rather than silently skipping the upgrade. Published rc.12
and rc.13 bytes remain unchanged. The rc.15 candidate upgrades the same rc.12
starter to contract rc.5, where `assignees` are links to `mdbase.person` 2.0.0
records declared in `collection.links`; Person 2.0.0 drops the separate `id`.
The People pack 1.2.0 keeps shipping `mdbase.person` 1.0.0 so Person types
customised under 1.1.0 continue to validate. To verify with the updated Rust
engine:

```sh
MDBASE_VERIFY_CLI=/absolute/path/to/mdbase npm test
```

This runs dry-run/install/idempotency checks through that local CLI against
throwaway collections, then reopens the installed definitions with mdbase-ts.
It does not claim that older mdbase-ts versions can execute seed upgrades.

## TaskNotes assignments

The rc.17 TaskNotes pack introduces optional `assignees` through the rc.5 task
contract and task type v4 (starter revision 5): links to records implementing `mdbase.person` 2.0.0,
declared as links so engines resolve them. It upgrades collections that seeded
rc.12's task type 1 with a digest-pinned seed-type upgrade, without rewriting
published rc.3 resources. Type v4 is rc.12's type v1 plus the assignees field,
link, mapping and contract version only, so an upgrade keeps every other setting
a collection has. rc.15 (type v3) was regenerated from TaskNotes model defaults
and also dropped the `cancelled` status and changed colours and profiles; it,
and the superseded person-ID candidates rc.13 and rc.14, remain available at
their immutable URLs but are not listed (`catalog: false`).

rc.17's starter is rc.16's with the generator bookkeeping
(`x-tasknotes-generator.managed_fields`) left as rc.12 published it: each
collection's list follows its own field mapping, so an upgrade that changed it
conflicted wherever that mapping was customized. rc.16 is not listed.

Starter files are named by revision (`types/tasknotes-task/<revision>.md`); a
revision that does not change the task data keeps the type `version`, so
collections already at that version upgrade without a version conflict.

The starter is defined by `@tasknotes/model/starter`, which reproduces the
published starter byte for byte; `scripts/sync-tasknotes-pack.mjs` generates it
from there. The upgrade tests check that a new starter changes nothing beyond
its declared changes.

To regenerate from a built sibling model:

```sh
node scripts/sync-tasknotes-pack.mjs
npm run build
```

The importer refuses to overwrite differing existing versioned artifacts.
Publish this catalog before consumers request its new immutable URLs.

## Publishing

`mdbase.dev` pins a reviewed commit of this repository, builds it, and copies
`dist/` into its own `public/contracts/` directory. Published version URLs are
immutable. Changing an existing artifact requires a new contract or pack
version.

## Profiles and standards

A standards-oriented contract must identify its normative references and
state its profile scope. An mdbase contract is not presented as an official
schema from the referenced standards body unless that body actually publishes
it as such.

External interchange schemas should not be listed as general-purpose record
contracts unless the installed type intentionally stores that exact shape.
Converters and exporters can consume a smaller semantic record contract and
produce the external format. Historical packs may set `catalog: false` to keep
their immutable artifact URLs available without advertising them for new
installations.
