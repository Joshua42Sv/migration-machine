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
- `cases.json` — raw API responses per case
- `structuredData.json` — flattened client/case fields ready for migration
  (name, contact details, cause/condition descriptions, etc.), plus the
  distinct causes/conditions/employment statuses referenced

**Note:** this overwrites `cases.json`/`structuredData.json` on every run — it
does not merge with a previous run's output. Run it against the full
`caseList.txt`, not incrementally.

### `node downloadDocuments.js [caseListFile]`

Downloads every document attached to each case in `caseList.txt` into
`documents/{caseId}/`:
- Real uploaded files (PDF, Word, etc.) are downloaded as-is with their
  original filename.
- In-app emails (`.eml`) are reconstructed as real `.eml` files (From/To/Cc/
  Subject/Date headers + HTML body) so they open in any mail client.
- In-app formatted-text notes (`.cmrtf`) are saved as `.html`, preserving
  formatting.

Existing files in `documents/` are left alone; re-running won't overwrite them
(duplicate filenames get a `(2)`, `(3)`, ... suffix instead).

## Suggested order for a full migration run

1. `node findCaseListEndpoint.js` — build the full `caseList.txt`
2. `node runAll.js` — export case + contact data
3. `node downloadDocuments.js` — download all documents

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
