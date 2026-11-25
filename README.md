# Historical snapshots with PingRoom

Reconstruct which facts were effective at one instant using only revisions known by another instant. A named owner selects a documented pair of timestamps through PingRoom. Code applies corrections and retractions, reports overlapping facts, and exports a local snapshot only when every key has an unambiguous result.

Use it between an append-only fact export and an audit or reporting adapter. It writes local JSON; it does not connect to a database or change the source history.

## Try it offline

Choose **Use this template**, clone your copy, and use Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
```

The fictional paper catalog demonstrates the same effective instant viewed before and after a correction, a later retraction, conflicting facts, and Unknown. Tests and demos use published `@pingroom/sdk` **0.8.0** with local mock transports. After installation they need no network or credentials and send no live pings. Dependencies are locked; `.npmrc` requests a 14-day minimum release age where npm supports it.

## Prepare the history

```sh
cp examples/history.json history.json
cp config.example.json config.json
```

Map your export into `history.json`. The two timestamps define the view:

- `effectiveAt`: when did the fact apply?
- `knownAt`: which revisions had been recorded by this cutoff?

For example, a paper specification effective January 1–February 1 was recorded as A4 on January 2 and corrected to A5 on January 20. The January 15 effective view shows A4 with a January 15 knowledge cutoff, and A5 with a January 22 cutoff. This keeps the later correction out of the earlier knowledge view.

| Field | Contract |
| --- | --- |
| `historyId` | 1–40 characters: lowercase letter first, then lowercase letters, digits, `_` or `-`. |
| `title`, `context` | Nonempty single-line descriptions, at most 40 and 80 UTF-16 units. |
| `facts` | 1–64 objects containing exactly `id`, `key`, `validFrom`, `validTo`, `revisions`. |
| Fact `id`, `key` | At most 24 characters using the history ID alphabet. Fact IDs are unique; keys may repeat. |
| `validFrom`, `validTo` | A nonempty interval: start included, end excluded. These boundaries and the key stay fixed across revisions of this fact. |
| `revisions` | 1–8 entries, strictly increasing by `recordedAt`. Assertion: `{recordedAt, kind: "assert", value}`. Retraction: `{recordedAt, kind: "retract"}` without a value. |
| Assertion `value` | `null`, boolean, safe integer, or well-formed string of at most 128 UTF-16 units. Negative zero, fractions, objects and arrays are refused. Strings preserve whitespace and escaped controls exactly. |
| `profiles` | 1–3 objects containing exactly `id`, `label`, `reference`, `effectiveAt`, `knownAt`. Each timestamp pair must differ. |
| Profile metadata | Unique ID of at most 12 characters; unique label of at most 24 UTF-16 units; source-policy reference of at most 40 units. |

All domain timestamps must be valid canonical UTC strings with exactly three fractional digits, such as `2026-01-15T00:00:00.000Z`. Offsets, missing milliseconds, leap seconds and normalized invalid dates are rejected. Years have exactly four digits. `knownAt` may precede `effectiveAt` when a fact was recorded in advance; a correction may also be recorded after its valid interval ends.

IDs other than `historyId` exclude `constructor`, `prototype`, `__proto__` and `unknown`. Profile labels cannot be Unknown. Metadata rejects surrounding whitespace, controls, format characters and malformed Unicode. Extra fields, sparse arrays and duplicate IDs fail validation. The CLI input file must fit 64 KiB, and the complete Question must fit 500 UTF-16 units. Shorten metadata if preview refuses it.

Facts are sorted by ID in ASCII order; revision and profile order stay unchanged. Saved state binds this canonical source, participant, connection and policy. Do not edit a started session's history to apply a correction; retain the session and prepare a separate reviewed input for a new run.

## Connect and select a view

Install [PingRoom](https://pingroom.io/i), then run:

```sh
npm run connect
npm run inspect
```

Approve the printed pairing link and grant a **standard private room** containing the history owner, with room-list and Question create/read permissions. Verify the person in the app, then put their exact member UUID and a label in `config.json`. A display name alone does not establish identity. Pairing stores private credentials in ignored `.pingroom/` and resumes the same pending pairing when run again.

For an existing connection, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and the 12-character `PINGROOM_ROOM`. Blank or partial pairs are rejected; credential sources cannot be combined.

```sh
npm run preview
npm start
# After the owner answers:
npm start
npm run report
npm run export
```

Preview displays the exact local source, policy, recipient and Question without contacting PingRoom. The owner selects the view requested by their report specification, or Unknown if it cannot be established. Each invocation creates at most one direct, 15-minute Question or reads that original Question once. There is no background polling or automatic replacement.

PingRoom receives title/context, history ID, profile labels/references and both timestamps, the owner UUID, source/fact/policy hashes and attempt identifiers. Fact keys, intervals, revision times and values remain local. Hashes identify data without encrypting it. Local reports include the full supplied history, including revisions later than the selected knowledge cutoff; they do not limit disclosure to what was known at that cutoff.

## Reconstruction and output

For each fact, code selects the last revision with `recordedAt <= knownAt`. An assertion contributes a row only when `validFrom <= effectiveAt < validTo`. A retraction removes that fact from this view; it does not remove other facts with the same key. A later assertion can restore the fact. A first recorded retraction is allowed and creates no earlier assertion.

Exactly one contributing fact produces a row. No contributing fact lists the key in `absentKeys`. Two or more contributing facts list the key and all candidates in `ambiguities`, even if their values agree. Code does not choose the most recently recorded overlapping fact. Ambiguous keys appear in neither rows nor absent keys, and any ambiguity withholds the complete snapshot.

`report` writes `.bitemporal/report.json`, including diagnostics on ambiguous results. `export` writes `.bitemporal/snapshot.json` only for a known, unambiguous view. Both retain the source and policy hashes and Question evidence. For a known selection, `analysis` contains the selected profile, rows, absent keys, ambiguities and one diagnostic per fact. Rows sort by key; candidates sort by fact ID. Each row retains its source fact ID, selected revision timestamp and valid interval. Fact diagnostics distinguish not-known, retracted, outside-valid-time and included, in that precedence order.

A selected view may contain no rows. Absence means no active assertion in the supplied history; it does not prove that no fact existed in the real system. A complete export also does not establish that the input is complete or true. Unknown, missing, expired, cancelled, misattributed or invalid answers withhold analysis. Refused exports preserve existing files; consume output only after successful export with the expected source and policy hashes. State and outputs use private permissions, atomic writes and an exclusive local lock, with a 1 MiB output bound. Paths resolve from the project directory.

Command exit codes: `0` for successful commands or complete runs, `2` for Unknown, incomplete or ambiguous runs, `3` for pending/ready runs, `4` for uncertain creation, and `1` for errors. `status` and `report` describe the stored result without network access and return 0 even for incomplete states; inspect their JSON status.

## Recover an uncertain request

```sh
npm run status
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

Creation intent is saved before the POST. A lost response or failed post-create save leaves it uncertain, and another `npm start` will not resend. `find-id` searches a bounded recent list for matching evidence; an empty list does not prove that creation failed. Recover only the exact original Question ID. The program verifies the request, room, recipient, asking registration, options, hashes and timestamps before accepting it. Keep the original connection for reads.

Do not delete unresolved state, clear a lock held by another process, or repeat uncertain pairing registration. Resolve an expired or uncertain pairing through Connected Agents before preparing a fresh connection.

## Adapt the integration

Export stable fact IDs, fixed valid intervals and the authoritative recorded-at correction history from your system. If a correction changes an interval, represent the old fact's retraction and a new fact assertion explicitly; this starter does not infer that relationship. Preserve same-time cross-fact assertions as separate facts so overlap remains visible.

In `src/model.js`, `snapshotAt(input, profileId)` is the pure reconstruction API and `snapshotPlan(input, choice)` adds incomplete/Unknown/ambiguous states. In `src/engine.js`, `step` handles durable PingRoom collection and `exportAnalysis` requires the verified receipt. Feed the exported rows to your own read-only report adapter. Database publication, source extraction and deployment are extension points requiring your own implementation.

Tests cover cutoff boundaries, retractions and reassertions, overlapping facts, empty snapshots, strict validation, a chronological-event oracle, uncertain creation, response provenance, private files, partial credentials, transport timeouts and offline CLI use. [Log compaction](https://github.com/pingroom/starter-log-compaction) instead preserves the latest mutation per key for a final replay state; [event-time windows](https://github.com/pingroom/starter-event-time-windows) aggregates arrivals by a watermark policy. This starter reconstructs a fact view across independent effective and knowledge times.

MIT licensed. See [LICENSE](LICENSE).
