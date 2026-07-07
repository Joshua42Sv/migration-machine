# Case Manager scraper

Pulls case data and documents out of Case Manager (`workcom.casemanager.biz`) for
migration to a new system. Everything goes through Case Manager's own JSON API
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

A plain text file, one case number per line. This is the input for `runAll.js`
and `downloadDocuments.js` — populate it with every case you want to migrate.

`findCaseListEndpoint.js` can generate this automatically from the case grid:

```
node findCaseListEndpoint.js
```

Logs in, reads every case number loaded into the case list grid's Kendo
DataSource, and writes them to `caseList.txt`.

## Commands

### `node getCase.js <caseId>`

Fetches a single case (case data + contacts) and merges it into `cases.json`.
Useful for testing against one case. Defaults to case `13098` if no ID is given.

### `node runAll.js [caseListFile]`

The main data export. Logs in once, fetches the shared lookup lists (Category,
Status, Cause, Condition, etc.) once, then loops over every case ID in
`caseList.txt` (or a path you pass in) fetching case data + contacts.

Writes:
- `cases.json` — raw API responses per case (including the full client
  contact record fetched from `/CaseContact/GetData`)
- `structuredData.json` — client/case fields shaped to match the importer
  API's `CaseImportDto` (`clientFirstName`, `clientAddress`, `claimNumber`,
  `referralDate`, etc.), plus cause/condition/employment status
  descriptions and the distinct values referenced

The client's address (`clientAddress`) is always included; a separate
billing address (`clientBillingAddress`) is only included when the case
contact has `Address2UsePrimary` set to false in Case Manager.

The referrer (`referrer`) is the case contact whose roles include
"Referrer" — a contact can hold this alongside other roles (e.g. "Bill To,
Referrer"), so it's matched on role membership rather than primary role.

**Note:** this overwrites `cases.json`/`structuredData.json` on every run — it
does not merge with a previous run's output. Run it against the full
`caseList.txt`, not incrementally.

### `node uploadCases.js [structuredDataFile]`

Reads `structuredData.json` and POSTs each case, one at a time, to the
production importer API (`http://localhost:8080/api/importer/case` by
default, override with `IMPORT_URL`). Failures for individual cases are
logged and don't stop the run; a summary of failed case IDs is printed at
the end.

Immediately after a case uploads successfully, its documents are uploaded
too: reads `documents/{caseId}/manifest.json` and POSTs each file as
`multipart/form-data` to `http://localhost:8080/api/importer/case/file`
(override with `IMPORT_FILE_URL`), one at a time. `uploadedById` is
currently a hardcoded placeholder in `uploadCases.js` — replace it with a
real mapped user ID before a production run. File failures are logged and
tallied separately from case failures; run `downloadDocuments.js` first so
manifests exist.

### `node downloadDocuments.js [caseListFile]`

Downloads every document attached to each case in `caseList.txt` into
`documents/{caseId}/`:
- Real uploaded files (PDF, Word, etc.) are downloaded as-is with their
  original filename.
- In-app emails (`.eml`) are reconstructed as real `.eml` files (From/To/Cc/
  Subject/Date headers + HTML body) so they open in any mail client.
- In-app formatted-text notes (`.cmrtf`) are saved as `.html`, preserving
  formatting.
- Each case directory also gets a `manifest.json` listing every file's
  original Case Manager title and a `fileType` (`EMAIL`, `CASE_NOTE`,
  `PDF`, `WORD`, `EXCEL`, `IMAGE`) used by `uploadCases.js`.

**Note:** this deletes and fully recreates the whole `documents/` directory
on every run — it does not do an incremental/resumable download.

## Suggested order for a full migration run

1. `node findCaseListEndpoint.js` — build the full `caseList.txt`
2. `node runAll.js` — export case + contact data
3. `node downloadDocuments.js` — download all documents
4. `node uploadCases.js` — import case data into the new production system

## Known limitations / things to check before a large (~2,000 case) run

- No rate limiting or backoff — Case Manager sits behind an AWS WAF that has
  already been observed blocking malformed requests; a large burst of API
  traffic has not been tested for rate limits.
- No resume support — both scripts start fresh each run, so a failure partway
  through a large batch means starting over, not resuming.
- The anti-forgery token is fetched once at login; untested whether it or the
  session expires during a very long run.
- Document handling has only been verified against `.pdf`, `.docx`, `.eml`,
  and `.cmrtf` from a handful of cases — other document/record types may
  appear at scale and aren't explicitly handled yet.
