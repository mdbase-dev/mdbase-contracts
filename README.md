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
changing validation or contract mappings. Starter types leave the type key to the collection:
apps name a type when they create a record and the engine records it under the
collection's configured `explicit_type_keys` (`type` by default, `mdbase_type` in
collections where `type` is data). Person v3, Comment v2 and View v2 therefore no
longer require or pin `type`, and View v2 accepts unknown top-level fields; each
keeps its `match` rule for hand-written records. `mdbase.contact` 1.3.0,
`mdbase.comment` 1.0.1 and `mdbase.view` 1.0.1 offer them as reviewed upgrades of
the unmodified previous starter; `mdbase.contact` 1.4.0 upgrades both earlier
Person starters (v1 from 1.1.0 and v2 from 1.2.0) to v3. Pack resources
explicitly use `managed` for schemas/contracts and `seed` for editable starter
types; install tests exercise the exact generated payload without supplying
missing modes. Associations are ordinary collection data, never
authentication or membership authority. See
[`mdbase.person` 1.0.0](contracts/mdbase.person/1.0.0.md) for matching,
ambiguity, privacy, and lifecycle semantics.

The `mdbase.comment` pack defines comments, replies and suggested edits as
records of their own, anchored to a quote of the commented record's Markdown
body and linked to `mdbase.person` authors. Apps that comment embed the
published provision unchanged, as mdbase writer does.

The `mdbase.daily-note` pack defines one record per local calendar day,
identified by its `date` (an RFC 3339 full-date), never by its path. Apps find
daily notes through the contract's type implementations and treat a date held
by several records as ambiguous. The **Daily note** starter stores the date
only in the file name, `Daily/YYYY-MM-DD.md`, with `collection.path.fields`
(path-stored fields, mdbase 0.3.0-rc.6), and matches only date-named files in
that folder so other notes there keep their own types. The pack needs an engine
with path-stored fields: the pinned mdbase-ts and Rust CLI reject the starter
until `sources.json` moves to engines that implement them. See
[`mdbase.daily-note` 1.0.0](contracts/mdbase.daily-note/1.0.0.md).

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

Requires Node.js 22+ and a built `mdbase` package from
[mdbase-connect](https://github.com/mdbase-dev/mdbase-connect)'s
`runtime/packages/mdbase`: the same engine core the daemon, the Obsidian plugin
and the SDK run. A sibling `../mdbase-connect` checkout is used by default; set
`MDBASE_DIR` to the package folder to override it. Build it from
`runtime/` with:

```sh
npm ci --prefix tools/wasm
cargo xtask mdbase-wasm
cd packages/mdbase && npm ci && npm run build:native && npm run build
```

CI builds the commit pinned in `sources.json` (`mdbase_engine.ref`), which is
the single source of truth for the engine the catalog is verified against.

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
customised under 1.1.0 continue to validate.

Every check (catalog verification, the People pack tests, and the TaskNotes
upgrade and plugin-collection tests) assesses and applies packs through the
engine's `assessTypePack` and `applyTypePack`, and reopens installed
collections with its native `Collection`.

## Seed upgrade baselines

A seed type is the collection's to edit once installed, so a new pack version
replaces it only through an explicit seed-type upgrade (mdbase spec 05A). A pack
definition names the starters it upgrades with `upgrade_from`, either one path
or a list:

```yaml
  - kind: type
    mode: seed
    source: types/tasknotes-task/5.md
    target: _types/task.md
    upgrade_from:
      - types/tasknotes-task/4.md
      - types/tasknotes-task/3.md
      - types/tasknotes-task/2.md
      - types/tasknotes-task/1.md
```

`npm run build` emits a list as `[{ digest, version, document }]`, ordered
newest first, with `version` read from each baseline's frontmatter; the single
form keeps emitting one `{ digest, document }` so published packs stay
byte-identical. The build rejects baselines on anything but a seed type,
duplicate or self baselines, and baselines whose type `kind` or `name` differs
from the desired starter.

Engines replace a starter equal to any listed baseline with the exact new
starter, and merge an edited starter against the baseline its lock records as
its `origin_digest`. An edited type with no recorded origin (installed by an
engine before 05A) or an unlisted origin merges against the nearest listed
baseline that merges cleanly; failing that it is preserved. An unlisted
starter is therefore upgraded only by inference, so the catalog keeps an
invariant, checked by `scripts/seed-baselines.test.mjs`: for every offered
(non-hidden) pack and seed target, `upgrade_from` lists every starter that any
earlier version of the pack shipped at that target, including unlisted
(`catalog: false`) versions. When a pack's list changes, publish a new version
and hide the previous one (`installation.visibility: hidden`).
`scripts/seed-upgrade.test.mjs` installs each earlier version through the
selected engine and upgrades it, unedited and customised.

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

rc.18 ships rc.17's starter unchanged and lists every earlier starter as an
upgrade baseline (revisions 4, 3, 2 and 1, from rc.16, rc.15, rc.13/rc.14 and
rc.12), so a collection seeded by any earlier pack upgrades to it. rc.17 is
hidden. A customised task type whose lock records no origin merges against
the nearest earlier starter, keeping its customisations.

## TaskNotes settings record

rc.19 provides `tasknotes.task` 0.3.0-rc.6, `tasknotes.settings` 1.0.0 and the
generic `mdbase.app-settings` 1.0.0 (copied byte for byte from mdbase Reader, so
both apps install the same contract). rc.6 moves app behaviour out of the task
binding: NLP triggers, templating, archive moves, time tracking, checkbox
resets on recurrence, the link write format, and per-status `next_status`,
`exclude_from_cycle`, `auto_archive` and `auto_archive_delay_minutes`. TaskNotes
keeps them in one record, `_settings/dev.tasknotes.md`, of the seeded
`tasknotes-settings` type (unique on `app`). The pack seeds the type only; the
record is written by TaskNotes, which reads each setting from the record, then
from an rc.5 binding that still holds it, then its default.

The rc.6 contract is installed at `_contracts/tasknotes.task/0.3.0-rc.6.md`.
The rc.5 contract stays managed at `_contracts/tasknotes.task.md`, not
provided, so task types that still implement it (edited types the pack
preserves, and types the TaskNotes plugin wrote) stay valid until TaskNotes
upgrades them. Starter revision 6 (type v5) is revision 5 with the moved
settings removed and the contract version raised; it lists revisions 5 to 1 as
baselines, and rc.18 is hidden. A collection that edited its status
definitions (for example their colours) conflicts on that list and the
upgrade is blocked for review; TaskNotes upgrades such a type itself.

Starter files are named by revision (`types/tasknotes-task/<revision>.md`); a
revision that does not change the task data keeps the type `version`, so
collections already at that version upgrade without a version conflict.

## Retained contracts

A type implements one exact contract version, and a type outside a pack's
targets (a renamed or customised starter, or a collection's own type) is never
upgraded by that pack. A pack that stops installing a contract an earlier
version installed leaves such a type invalid, and engines then refuse the whole
upgrade. The catalog therefore keeps a second invariant, checked by
`scripts/contract-retention.test.mjs`: every offered (non-hidden) pack installs
every contract document that any earlier version of the pack shipped,
including unlisted versions.

rc.12 to rc.18 of the TaskNotes pack managed one contract at
`_contracts/tasknotes.task.md` and replaced it in place: rc.3 (rc.12), rc.4
(rc.13, rc.14), then rc.5. rc.19 kept rc.5 there but not the two before it, so
a collection last set up by rc.12 to rc.14 whose task type is not the starter
at `_types/task.md` could not be upgraded at all. rc.20 is rc.19 plus rc.3 and
rc.4 at `_contracts/tasknotes.task/<version>.md`, neither provided; its starter
and baselines are unchanged, and rc.19 is hidden. Such a type stays valid on
the contract it implements. TaskNotes reads rc.6 and rc.5 types only, so it
still needs a type on one of those.

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
