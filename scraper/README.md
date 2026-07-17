# Case Manager scraper

Pulls case data and documents out of Case Manager (`workcom.casemanager.biz`) for
migration to NotusPoint. Everything goes through Case Manager's own JSON API
directly (via Playwright's `context.request`) rather than clicking through the
UI, so it's fast and doesn't need a visible browser.

## Setup

Create a `.env` file in this directory (already present, not committed) with:

```
CM_USER=your-username
CM_PASS=your-password
```

Install dependencies (already done if `node_modules` exists):

```
npm install
npx playwright install chromium
```

## `caseList.txt`

You supply this file: one Case Manager case ID per line, in this directory.
Every stage reads it as its work list. To migrate a different set of cases,
replace the file (and wipe migration state if starting over).

## Interactive CLI (recommended)

```
npm start        # or just `migrate` (globally linked via npm link)
```

Launches a menu that drives the whole pipeline:

- **🚀 Full migration (fresh)** — wipes all migration state (after
  confirmation), exports case data, downloads documents, then uploads to
  the NotusPoint importer.
- **▶️ Resume / retry** — continues where the last run left off. Every stage
  skips cases already marked done in the ledger and retries failed ones, so
  a crash at case 2,400 of 3,000 restarts in seconds.
- **🎯 Migrate one case** — prompts for a case ID and runs the pipeline for
  just that case in an isolated `single/<caseId>/` workspace (its own data,
  documents and ledger via `MIGRATION_ROOT`), never touching the full run.
- **📦 / 📄 / ⬆️** — run any individual stage on its own (all
  resume-aware). The upload step lets you pick the full export or any
  single-case workspace, and can skip file uploads.
- **✅ Verify migration** — cross-checks the ledger against `caseList.txt`
  and the files on disk: export done per case, documents
  expected = downloaded = present on disk, case/files/costs uploaded, and
  warnings for costs that imported without their file link. Writes the full
  detail to `verifyReport.json`.
- **📊 Status** — per-stage progress counts and importer reachability.
- **🧹 Wipe migration state** — three flavours: **everything** (start
  completely afresh), **upload records only** (after clearing the NotusPoint
  DB — keeps all scraped data so re-uploading needs no re-scrape), or a
  custom selection of components.
- **🔒 Purge sensitive data** — deletes every file containing client/staff
  data scraped from Case Manager (`data/`, `documents/`, `shared.json`, the
  ledger, single-case workspaces, legacy exports) so only code and config
  remain — for before letting AI tooling (or anyone else) loose on the
  repo. `caseList.txt` (just case ids) and `.env` are kept.

## The ledger (`migrationState.json`)

Every stage records per-case progress in `migrationState.json`:

```json
{
  "staff":  { "<employeeId>": { "email": "...", "userId": "<notuspoint-user-id>" } },
  "cases": {
    "13938": {
      "export":    { "status": "done", "hasClient": true, "counts": { "contacts": 3, "billingTemplates": 2, "billingItems": 9, "costs": 12 } },
      "documents": { "status": "done", "expected": 41, "downloaded": 41, "failed": 0 },
      "upload": {
        "case":  { "status": "done" },
        "files": { "status": "done", "expected": 41, "uploaded": 41, "failed": 0 },
        "costs": { "status": "done", "expected": 12, "imported": 12, "skippedUnlinked": 0, "missingFileLinks": 0 }
      }
    }
  }
}
```

Statuses: absent/`pending` (not attempted), `failed` (retried on the next
run), `done` (skipped on resume). Deleting the file — or the CLI's wipe —
makes everything start from scratch.

Per-file upload progress (Case Manager `documentId` → NotusPoint file id)
lives in `documents/<caseId>/.uploadState.json`, saved after **every** file,
so a crash mid-case never duplicates files the importer already accepted; it
also carries the ids costs need for their file links on a resumed run.

The `staff` map remembers which NotusPoint user each Case Manager employee
became, so resumed uploads never re-POST staff (the importer rejects
duplicates) and can still resolve cost/file owners.

## Performance & tuning

All Case Manager traffic goes through one global in-flight cap
(`lib/cmClient.js`) — that cap is the rate limiter (no fixed sleeps).
Transient failures (WAF 429s, 5xx, network) retry with exponential backoff
while holding their slot, so errors slow the run down instead of failing
cases; an expired session triggers one shared re-login that all in-flight
requests wait on. Knobs (env vars):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CM_MAX_INFLIGHT` | 24 | Max concurrent requests to Case Manager. CM tops out around ~10 req/s server-side (measured 2026-07-16: 64 in-flight moved throughput not at all, just inflated latency into timeouts) — raising this buys nothing |
| `CM_CASE_CONCURRENCY` | 12 export / 8 docs | Cases processed at once per stage (just keeps the in-flight pool fed across case boundaries) |
| `CM_FORCE_GETDATA` | unset | Set to `1` to fetch per-file GetData for exact creator attribution (~2x the CM requests; see `downloadDocuments.js` below) |
| `UPLOAD_CASE_CONCURRENCY` | 8 | Cases uploaded at once |
| `UPLOAD_FILE_CONCURRENCY` | 32 | Concurrent file POSTs to the importer (global, across all cases) |

**Download and upload always run at the same time** in the CLI pipeline
(🚀 / ▶️): after the export, upload passes drain each case as its documents
complete, so the upload adds no wall-clock time. The pipeline asks nothing
after it starts — the importer is probed for reachability up front, and
partial failures are carried forward for "Resume / retry" instead of
prompting. (Manually: `downloadDocuments.js` in one terminal, re-run
`uploadCases.js` in another — ledger writes are lock-protected and merge,
so concurrent processes are safe.)

## Underlying scripts

All scripts write under `MIGRATION_ROOT` (default: this directory) — that's
how the CLI isolates single-case workspaces.

### `node runAll.js [caseListFile]`

The data export. Logs in once, fetches the shared lookup lists and employee
list (saved to `shared.json`), then captures every case ID in
`caseList.txt` not yet exported (`CM_CASE_CONCURRENCY` cases at a time,
with contact/estimate/cost detail fetches in parallel within each case).
Each case is saved to `data/<caseId>.json` as `{ fetchedAt, endpoints,
structured }` where `structured` is the importer-ready record (built by
`lib/structured.js`; `null` when the case has no Client contact).

### `node downloadDocuments.js [caseListFile]`

Downloads every document attached to each not-yet-done case into
`documents/{caseId}/`:
- Real uploaded files (PDF, Word, etc.) are downloaded as-is with their
  original filename.
- In-app emails (`.eml`) are reconstructed as real `.eml` files (From/To/Cc/
  Subject/Date headers + HTML body + attachments) so they open in any mail
  client.
- In-app formatted-text notes (`.cmrtf`) are saved as `.html`, preserving
  formatting.
- Each case directory also gets a `manifest.json` listing every file's
  original Case Manager title and a `fileType` (`EMAIL`, `CASE_NOTE`,
  `PDF`, `WORD`, `EXCEL`, `IMAGE`) used by `uploadCases.js`.

Incremental per document: a retried case keeps every file its previous run
downloaded (matched by `documentId` via the manifest) and fetches only the
missing ones, so one failed document costs one re-download, not the whole
case.

**Documents broken in Case Manager itself** (a CM 5xx on every retry — the
same signature as documents that fail to open in the CM UI) are migrated
automatically as placeholder CASE_NOTEs carrying the original title, date
and creator, whose text explains the file was unrecoverable at the source —
so the case completes its migration and anyone looking for the file in
NotusPoint learns what happened. Guard rails: timeouts/network errors and
4xx (WAF, auth) never convert — they stay failures and retry on resume —
and at most `CM_AUTO_PLACEHOLDER_CAP` (default 10) documents convert per
run, so a CM outage 500-ing everything can't mass-convert real documents.
Each conversion is logged with its document id, and Verify lists affected
cases as warnings. `missingDocuments.txt` (one document id per line, `#`
comments) still works to pre-mark known-broken documents so they skip the
retry cycle entirely. Documents across all in-flight cases download in parallel through the
global `CM_MAX_INFLIGHT` pool. Creator attribution (`CreatedByID`) is
mandatory — files must be attributed exactly as in Case Manager — so for
real files the per-document `GetData` call is skipped only when the list
rows already carry `CreatedByID` (probed on the first case; no fidelity
loss, nearly half the requests). When they don't, `GetData` is fetched per
document. Emails/notes always fetch `GetData` — their bodies live there.

### `node uploadCases.js [--skip-files] [--costs-without-files]`

Uploads staff, then each importable case to the production importer API
(`http://localhost:8080/api/importer/case` by default, override with
`IMPORT_URL` / `IMPORT_FILE_URL` / `IMPORT_STAFF_URL` / `IMPORT_COSTS_URL`).

Each case uploads in three passes so costs can link to the files created
from their Case Manager documents:

1. Case + billing templates (no costs) to `/api/importer/case`.
2. Documents: reads `documents/{caseId}/manifest.json` and POSTs each file
   as `multipart/form-data`, recording each created file id against the
   manifest entry's Case Manager `documentId`.
3. Costs to `/api/importer/case/costs`, with each cost's `fileId` resolved
   from its `documentId`. While a case still has failed file uploads its
   costs are held back ("blocked") so a later resume can import them WITH
   their file links; `--costs-without-files` forces them through instead.

Each file uploads as the NotusPoint user created for the Case Manager
employee who created the document (manifest `createdById`). A document
whose creator is unknown in CM imports with no uploader — attribution
mirrors CM exactly and is never synthesized. The employee list is fetched
with inactives included so departed staff still resolve; staff are imported
only for employees referenced somewhere: cost loggers, assigned case users,
and document creators.

**Local documents are deleted once a case is fully in NotusPoint** (case +
every file + costs all done — costs are the last consumer of the local
sidecar): the whole `documents/<caseId>/` directory is removed and
`upload.purgedAt` stamped in the ledger, keeping disk usage bounded at
roughly the in-flight cases instead of the whole migration. Exported case
data (`data/<caseId>.json`) is kept. Verify skips the disk recount for
purged cases, and "Wipe upload records" resets their documents stage so a
re-upload re-downloads them first.

Fully resume-aware: cases/files/costs/staff already accepted by the
importer are skipped via the ledger and the per-case `.uploadState.json`.
Staff import is also idempotent on the NotusPoint side — a user whose email
already exists is returned untouched (never updated), so re-runs against a
live DB can't clobber NotusPoint-side changes. Case import still rejects
duplicate case IDs: if the NotusPoint DB was cleared since the last upload,
wipe the upload records first (menu → Wipe migration state).
Only cases whose `documents` stage is `done` are touched (so it can run
alongside the downloader); file POSTs run `UPLOAD_FILE_CONCURRENCY` at a
time across `UPLOAD_CASE_CONCURRENCY` concurrent cases. `--skip-files`
uploads cases and costs only (costs then import without file links) — only
for quick data-checking runs.

### `node getCase.js <caseId>`

Legacy single-case fetch into `cases.json`. Superseded by the CLI's
"Migrate one case" — kept for ad-hoc poking at raw responses.

## Suggested order for a full migration run

Use the CLI (`npm start` → 🚀 or ▶️). Manually it's:

1. Populate `caseList.txt` — one case ID per line
2. `node runAll.js` — export case + contact data
3. `node downloadDocuments.js` — download all documents (can overlap with 4)
4. `node uploadCases.js` — import into the new production system; re-run to
   drain cases as their documents finish
5. CLI → ✅ Verify migration — confirm everything landed

Re-running any step resumes/retries; wipe via the CLI to start over.

## Known limitations / things to check before the production (~3,000 case) run

- CM's ~10 req/s server-side ceiling caps the download at roughly
  ~1.5–2 days for ~1.6M documents — inside the 48h window but without much
  slack. If that's too tight, the next lever is multiple CM sessions in
  parallel (untested; WAF/account risk).
- Document handling has only been verified against `.pdf`, `.docx`, `.eml`,
  and `.cmrtf` from a handful of cases — other document/record types may
  appear at scale and aren't explicitly handled yet.
- Hardcoded `customerId` / `requirementId` TODOs in `uploadCases.js` must be
  replaced before a production run.
- Verification is against the ledger + local disk; it does not (yet) query
  NotusPoint to independently confirm record counts.
