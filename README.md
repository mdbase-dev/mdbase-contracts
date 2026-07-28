# mdbase contracts

First-party, versioned data contracts and transactional type packs for mdbase
collections.

Published contract schemas are immutable interoperability boundaries. A
catalog-listed starter type contains an inline snapshot of its starting schema
instead of inheriting that boundary. Once installed, the type belongs to the
collection: users can edit its fields and update the explicit contract mapping
without changing the published contract.

The featured `mdbase.runtime.standard` pack supplies the durable runtime 0.2
standard library: ten ordinary record contracts and canonical implementing
types, the four canonical record-change events, and inspectable timer-event
and cancellation-action artifacts.
Installing it is passive and grants no execution authority.

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

Verification checks the catalog schema, every resource digest, a transactional
dry run, a real install, idempotent reinstallation, and the declared contract
implementations.

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
