require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient, isBrowserGone } = require('./lib/cmClient');
const { mapPool } = require('./lib/pool');
const { roots } = require('./lib/paths');
const { loadLedger } = require('./lib/ledger');

const USERNAME = process.env.CM_USER || '';
const PASSWORD = process.env.CM_PASS || '';
const paths = roots();
const LIST_FILE = process.argv[2] || paths.caseList;
const OUTPUT_DIR = paths.documentsDir;
// Cases processed at once. The real throughput comes from every document
// download across all cases sharing the client's global CM_MAX_INFLIGHT
// pool — one 700-document case alone keeps the whole pool busy, so this
// mainly avoids stalling at case boundaries.
const CASE_CONCURRENCY = Number(process.env.CM_CASE_CONCURRENCY ?? 8);
// Creator attribution (CreatedByID) is mandatory — migrated files must be
// attributed exactly as in Case Manager. The /CaseDocument/_List rows may
// already carry CreatedByID; when they do, per-file /CaseDocument/GetData
// calls are skipped (nearly halving CM requests) with no fidelity loss.
// When they don't, GetData is fetched per document. Set CM_FORCE_GETDATA=1
// to always fetch GetData even when the list rows carry it.
const FORCE_GETDATA = process.env.CM_FORCE_GETDATA === '1';

if (!USERNAME || !PASSWORD) {
  console.error('Set CM_USER and CM_PASS environment variables');
  process.exit(1);
}

if (!fs.existsSync(LIST_FILE)) {
  console.error(`Case list file not found: ${LIST_FILE}`);
  process.exit(1);
}

function readCaseList() {
  return fs.readFileSync(LIST_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

// Documents confirmed missing in Case Manager itself (opening them in the CM
// UI fails too — typically orphaned records whose file is gone server-side).
// Each becomes a placeholder CASE_NOTE in NotusPoint, keeping the original
// title and date and stating the file was not recoverable, so the case can
// finish migrating and anyone looking for the file learns what happened.
// One Case Manager document ID per line; '#' starts a comment.
const MISSING_LIST = path.join(paths.root, 'missingDocuments.txt');

function readMissingList() {
  if (!fs.existsSync(MISSING_LIST)) return new Set();
  return new Set(
    fs.readFileSync(MISSING_LIST, 'utf8')
      .split('\n')
      .map((l) => l.split('#')[0].trim())
      .filter(Boolean),
  );
}

function buildMissingPlaceholder(doc) {
  const created = doc.DateCreated ? new Date(doc.DateCreated).toLocaleDateString('en-AU') : 'an unknown date';
  const body =
    '<pre>This document could not be migrated from Case Manager.\n\n' +
    `The original file "${doc.Title ?? doc.ID}" (created ${created}) was missing or unreadable in ` +
    'Case Manager itself — opening it there also failed, so no copy could be retrieved.\n\n' +
    `Case Manager document ID: ${doc.ID}</pre>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${doc.Title ?? ''} (missing in Case Manager)</title></head><body>${body}</body></html>`;
}

function sanitizeFilename(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '_').trim();
}

// Filenames are reserved synchronously in an in-memory set (not via
// fs.existsSync) because documents in one case download concurrently.
// Case-insensitive to match the macOS filesystem.
function claimName(taken, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let i = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base} (${i})${ext}`;
    i++;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

const ATTACHMENT_MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.eml': 'message/rfc822',
};

function attachmentMimeType(filename) {
  return ATTACHMENT_MIME_TYPES[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

// attachments: [{ filename, buffer }]. With attachments the email becomes a
// multipart/mixed MIME message (HTML body part + base64 attachment parts) so
// the .eml opens in any mail client with its attachments intact.
function buildEml(doc, attachments = []) {
  const headers = [];
  if (doc.From) headers.push(`From: ${doc.From}`);
  if (doc.To) headers.push(`To: ${doc.To}`);
  if (doc.CC) headers.push(`Cc: ${doc.CC}`);
  if (doc.BCC) headers.push(`Bcc: ${doc.BCC}`);
  headers.push(`Subject: ${doc.Title ?? ''}`);
  headers.push(`Date: ${new Date(doc.DateCreated).toUTCString()}`);
  headers.push('MIME-Version: 1.0');

  if (!attachments.length) {
    headers.push('Content-Type: text/html; charset="UTF-8"');
    return [...headers, '', doc.HtmlDoc ?? ''].join('\r\n');
  }

  const boundary = `=_cm_${Math.random().toString(16).slice(2)}`;
  const lines = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    'This is a multi-part message in MIME format.',
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    doc.HtmlDoc ?? '',
    '',
  ];
  for (const att of attachments) {
    const filename = att.filename.replace(/"/g, "'");
    lines.push(
      `--${boundary}`,
      `Content-Type: ${attachmentMimeType(filename)}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      att.buffer.toString('base64').replace(/(.{76})/g, '$1\r\n'),
      '',
    );
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

function buildHtml(doc) {
  const body = doc.HtmlDoc || `<pre>${doc.Details ?? ''}</pre>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${doc.Title ?? ''}</title></head><body>${body}</body></html>`;
}

const NIL_ID = '00000000-0000-0000-0000-000000000000';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp']);
const WORD_EXTENSIONS = new Set(['.doc', '.docx']);
const EXCEL_EXTENSIONS = new Set(['.xls', '.xlsx']);

function classifyFileType(doc) {
  if (!doc.IsFile) return doc.FileExtension === '.eml' ? 'EMAIL' : 'CASE_NOTE';

  const ext = (doc.FileExtension || '').toLowerCase();
  if (ext === '.pdf') return 'PDF';
  if (WORD_EXTENSIONS.has(ext)) return 'WORD';
  if (EXCEL_EXTENSIONS.has(ext)) return 'EXCEL';
  if (IMAGE_EXTENSIONS.has(ext)) return 'IMAGE';
  // Archives and anything else binary must not be CASE_NOTE — the importer
  // decodes CASE_NOTE buffers as UTF-8 into noteText, which null bytes break
  return 'OTHER';
}

(async () => {
  const ledger = loadLedger(paths.root);
  const caseIds = readCaseList();
  const missingDocs = readMissingList();
  if (missingDocs.size) {
    console.error(`${missingDocs.size} document id(s) in ${path.basename(MISSING_LIST)} will migrate as placeholder notes.`);
  }
  // Resume: only cases not yet fully downloaded run, and within a case only
  // documents missing from its manifest are fetched (see processCase).
  const pending = caseIds.filter(id => ledger.stageStatus(id, 'documents') !== 'done');

  console.error(`Total: ${caseIds.length} case(s) in list, ${caseIds.length - pending.length} already downloaded, ${pending.length} to fetch`);

  if (!pending.length) {
    console.error('Nothing to download — all cases are already done.');
    return;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.error('Logging in...');
  const client = await createClient({ username: USERNAME, password: PASSWORD });
  console.error('Logged in\n');

  // null = not probed yet; decided from the first non-empty document list
  let listHasCreatedBy = FORCE_GETDATA ? false : null;
  let totalDocs = 0;

  // A CM 5xx that survives every retry means CM itself cannot serve the
  // document (same signature as documents confirmed broken in the CM UI) —
  // those migrate as placeholder notes automatically. Timeouts/network
  // errors and 4xx (WAF blocks, auth) never convert: they're transient or
  // config problems and stay failures for the next resume. The per-run cap
  // keeps a CM outage (500s on everything) from mass-converting real
  // documents; past it, 5xx failures record normally.
  const AUTO_PLACEHOLDER_CAP = Number(process.env.CM_AUTO_PLACEHOLDER_CAP ?? 10);
  let autoPlaceholders = 0;
  let capWarned = false;

  // Writes the placeholder note for an unrecoverable document and returns
  // its manifest entry. Attribution still mirrors CM when the metadata
  // (CreatedByID) could be read; the note keeps the original title and date.
  function writePlaceholder(caseDir, taken, doc, createdById) {
    const title = `${doc.Title ?? doc.ID} (missing in Case Manager)`;
    const safeName = claimName(taken, sanitizeFilename(`${title}.html`));
    fs.writeFileSync(path.join(caseDir, safeName), Buffer.from(buildMissingPlaceholder(doc), 'utf8'));
    totalDocs++;
    return {
      documentId: doc.ID,
      createdById: createdById && createdById !== NIL_ID ? createdById : '',
      filename: safeName,
      title,
      fileType: 'CASE_NOTE',
      dateUploaded: doc.DateCreated ?? '',
      missingAtSource: true,
    };
  }

  // data is the /CaseDocument/GetData record (needed for email/note bodies;
  // it also carries CreatedByID when the list row doesn't)
  async function buildNonFileDoc(doc, data) {
    if (doc.FileExtension === '.eml') {
      // A failed attachment shouldn't lose the email itself; build the .eml
      // with whatever downloaded and report the rest
      const attachments = [];
      for (const att of data.Attachments ?? []) {
        try {
          const { buffer } = await client.downloadDocumentAttachment(att.DocumentID, att.AttachmentID);
          attachments.push({ filename: att.ItemValue || att.AttachmentID, buffer });
        } catch (err) {
          if (isBrowserGone(err)) throw err;
          console.error(`  attachment "${att.ItemValue}" on "${doc.Title}" FAILED: ${err.message}`);
        }
      }
      return { buffer: Buffer.from(buildEml(data, attachments), 'utf8'), filename: `${data.Title}.eml` };
    }
    if (data.Attachments?.length > 0) {
      console.error(`  note: ${doc.Title} has ${data.Attachments.length} attachment(s) - only embeddable in emails, skipped`);
    }
    return { buffer: Buffer.from(buildHtml(data), 'utf8'), filename: `${data.Title}.html` };
  }

  // Downloads one document into caseDir; returns { entry } or { failure }.
  // Never throws except for browser-gone (fatal). Buffers are written and
  // released as each download completes, so memory stays flat.
  async function downloadOne(caseId, caseDir, taken, doc) {
    if (missingDocs.has(doc.ID)) {
      // Pre-confirmed unrecoverable: placeholder without even retrying.
      let createdBy = doc.CreatedByID;
      if (!doc.IsFile || !listHasCreatedBy) {
        try {
          createdBy = (await client.getCaseDocumentData(caseId, doc.ID)).CreatedByID;
        } catch (err) {
          if (isBrowserGone(err)) throw err; // metadata gone too: no attribution
        }
      }
      return { entry: writePlaceholder(caseDir, taken, doc, createdBy) };
    }
    // Kept outside the try so a GetFile failure can still attribute the
    // placeholder note using the metadata fetched before it
    let data = null;
    try {
      // Real files only need GetData for CreatedByID; skip it only when the
      // list row already provides one (attribution must never be lost)
      const needData = !doc.IsFile || !listHasCreatedBy;
      data = needData ? await client.getCaseDocumentData(caseId, doc.ID) : null;
      const { buffer, filename } = doc.IsFile
        ? await client.downloadDocumentFile(doc.ID)
        : await buildNonFileDoc(doc, data);
      const safeName = claimName(taken, sanitizeFilename(filename));
      fs.writeFileSync(path.join(caseDir, safeName), buffer);
      const rawCreatedBy = data?.CreatedByID ?? doc.CreatedByID;
      const createdById = rawCreatedBy && rawCreatedBy !== NIL_ID ? rawCreatedBy : '';
      totalDocs++;
      if (totalDocs % 100 === 0) console.error(`  ...${totalDocs} document(s) downloaded this run`);
      return {
        entry: {
          documentId: doc.ID,
          createdById,
          filename: safeName,
          title: doc.Title ?? safeName,
          fileType: classifyFileType(doc),
          dateUploaded: doc.DateCreated ?? '',
        },
      };
    } catch (err) {
      if (isBrowserGone(err)) throw err;
      if ((err.status ?? 0) >= 500) {
        if (autoPlaceholders < AUTO_PLACEHOLDER_CAP) {
          autoPlaceholders++;
          console.error(
            `  document "${doc.Title ?? doc.ID}" (id ${doc.ID}) on case ${caseId}: ` +
            `CM cannot serve it (HTTP ${err.status} after all retries) — migrated as a placeholder note`,
          );
          return { entry: writePlaceholder(caseDir, taken, doc, data?.CreatedByID ?? doc.CreatedByID) };
        }
        if (!capWarned) {
          capWarned = true;
          console.error(
            `  auto-placeholder cap (${AUTO_PLACEHOLDER_CAP}) reached — this looks like a CM outage, ` +
            `so further 5xx failures stay failures. Raise CM_AUTO_PLACEHOLDER_CAP if they are genuinely broken documents.`,
          );
        }
      }
      console.error(`  document "${doc.Title ?? doc.ID}" (id ${doc.ID}) on case ${caseId} FAILED: ${err.message}`);
      return { failure: { id: doc.ID, title: doc.Title ?? '', error: err.message } };
    }
  }

  // Downloads one case's documents, returning the ledger patch. All its
  // documents go through the client's global limiter together, so cases and
  // documents interleave freely. Resume is per-document: files an earlier run
  // already downloaded (matched by documentId via the previous manifest) are
  // kept, so retrying a 900-document case with one failure fetches one
  // document, not 900.
  async function processCase(caseId) {
    const documents = await client.getCaseDocuments(caseId);

    if (listHasCreatedBy === null && documents.length) {
      listHasCreatedBy = documents.every((d) => 'CreatedByID' in d);
      console.error(listHasCreatedBy
        ? '  document list rows carry CreatedByID — skipping per-file GetData calls'
        : '  document list rows have no CreatedByID — fetching GetData per document (required for creator attribution)');
    }

    if (documents.length === 0) {
      return { status: 'done', expected: 0, downloaded: 0, reused: 0, failed: 0, error: undefined };
    }

    const caseDir = path.join(OUTPUT_DIR, caseId);
    fs.mkdirSync(caseDir, { recursive: true });

    const previous = new Map();
    try {
      for (const entry of JSON.parse(fs.readFileSync(path.join(caseDir, 'manifest.json'), 'utf8'))) {
        previous.set(entry.documentId, entry);
      }
    } catch {} // no/unreadable manifest — download everything

    const reusedEntries = [];
    const toFetch = [];
    for (const doc of documents) {
      const prev = previous.get(doc.ID);
      if (prev && fs.existsSync(path.join(caseDir, prev.filename))) reusedEntries.push(prev);
      else toFetch.push(doc);
    }

    // Remove files no reused entry claims (crashed-run leftovers, documents
    // deleted in CM) so filenames stay collision-free and the directory always
    // matches the manifest. The upload sidecar survives — it's keyed by
    // documentId and the uploader skips ids it doesn't find in the manifest.
    const keep = new Set(['manifest.json', '.uploadstate.json',
      ...reusedEntries.map((e) => e.filename.toLowerCase())]);
    for (const f of fs.readdirSync(caseDir)) {
      if (!keep.has(f.toLowerCase())) fs.rmSync(path.join(caseDir, f), { force: true });
    }

    const taken = new Set(keep);
    const results = await Promise.all(
      toFetch.map((doc) => downloadOne(caseId, caseDir, taken, doc)),
    );
    const manifest = [...reusedEntries, ...results.filter((r) => r.entry).map((r) => r.entry)];
    const failedDocs = results.filter((r) => r.failure).map((r) => r.failure);

    fs.writeFileSync(path.join(caseDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return {
      status: failedDocs.length ? 'failed' : 'done',
      expected: documents.length,
      downloaded: manifest.length,
      reused: reusedEntries.length,
      placeholders: manifest.filter((e) => e.missingAtSource).length,
      failed: failedDocs.length,
      error: failedDocs.length ? failedDocs[0].error : undefined,
    };
  }

  let completed = 0;
  let failedCases = 0;
  await mapPool(pending, CASE_CONCURRENCY, async (caseId) => {
    let result;
    try {
      result = await processCase(caseId);
    } catch (err) {
      if (isBrowserGone(err)) {
        console.error(`\nAborted: the browser was closed mid-run (Ctrl+C?). Case ${caseId} stays pending; re-run to resume.`);
        process.exit(1);
      }
      result = { status: 'failed', error: err.message };
    }
    if (result.status !== 'done') failedCases++;
    ledger.updateStage(caseId, 'documents', result);
    completed++;
    console.error(
      `[${completed}/${pending.length}] Case ${caseId}: ` +
      (result.expected != null
        ? `${result.downloaded}/${result.expected} document(s)` +
          `${result.reused ? ` (${result.reused} kept from last run)` : ''}` +
          `${result.placeholders ? ` (${result.placeholders} missing in CM -> placeholder note)` : ''}` +
          `${result.failed ? ` (${result.failed} FAILED)` : ''}`
        : `FAILED: ${result.error}`),
    );
  });

  console.error(`\nFinished. ${completed - failedCases}/${completed} case(s) fully downloaded, ${totalDocs} document(s)${failedCases ? `; ${failedCases} case(s) incomplete (re-run to retry)` : ''}.`);
  if (autoPlaceholders) {
    console.error(`${autoPlaceholders} document(s) CM could not serve were migrated as placeholder notes (see per-case logs and Verify).`);
  }
  if (failedCases) {
    console.error(
      `If a failed document is confirmed missing in Case Manager itself (opening it in the CM UI also fails), ` +
      `add its id to ${path.basename(MISSING_LIST)} to migrate it as a placeholder note without waiting on retries.`,
    );
    process.exitCode = 1;
  }
  await client.close();
})();
