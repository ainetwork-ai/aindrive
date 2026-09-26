# web/shared/willow — Willow building blocks (pure, shared)

Spec: `docs/superpowers/specs/2026-09-26-willow-local-first-docs-design.md`.
No Node/DOM/Next imports: the server peer, the browser, the phone shell and (mirrored
by hand) the CLI run this code.

| File | What |
|---|---|
| `bytes.ts` | hex, concat, canonical JSON (what signatures cover), path components |
| `keys.ts` | device Ed25519 keypair = the device's subspace |
| `schemes.ts` | Willow parameters: communal namespace per drive (`namespaceOf`), subspace owner signs (`isAuthorisedWrite`) |
| `cert.ts` | device certificates (attestation / device / wallet), revocations, `resolvePerson` |
| `policy.ts` | owner-signed grants, `mayWrite` — every peer runs it at ingest |
| `doc.ts` | a Yjs document = its updates across subspaces; compaction; clientID → author |

Paths: `["_id","cert"]`, `["_id","revoke",<key>]`, `["_acl",<userId>]`,
`["doc",...path,"~u",<seq>]`, snapshot `["doc",...path,"~u"]`.
Gotcha: timestamps are microseconds; compaction must stamp the snapshot newer than
every update it replaces, or prefix pruning keeps them.

**The CLI has a generated copy** in `cli/src/willow-shared/` (packages stay independent).
After changing anything here, run `node web/scripts/mirror-willow-to-cli.mjs`;
`willow-mirror.test.ts` fails until you do.
