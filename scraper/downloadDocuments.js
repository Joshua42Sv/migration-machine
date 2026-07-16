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
const CASE_CONCURRENCY = Number(process.env.CM_CASE_CONCURRENCY ?? 3);
// The /CaseDocument/_List rows may already carry CreatedByID; when they do,
// per-file /CaseDocument/GetData calls are skipped (nearly halving CM
// requests). Set CM_FORCE_GETDATA=1 to always fetch GetData instead.
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
  // Resume: only cases not yet fully downloaded run; each case's directory is
  // rebuilt from scratch so its manifest is always consistent.
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
    try {
      // Real files only need GetData for CreatedByID; skip it when the list
      // row already has one
      const needData = !doc.IsFile || !listHasCreatedBy;
      const data = needData ? await client.getCaseDocumentData(caseId, doc.ID) : null;
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
      console.error(`  document "${doc.Title ?? doc.ID}" on case ${caseId} FAILED: ${err.message}`);
      return { failure: { id: doc.ID, title: doc.Title ?? '', error: err.message } };
    }
  }

  // Downloads and re-writes one case's directory in full, returning the
  // ledger patch. All its documents go through the client's global limiter
  // together, so cases and documents interleave freely.
  async function processCase(caseId) {
    const documents = await client.getCaseDocuments(caseId);

    if (listHasCreatedBy === null && documents.length) {
      listHasCreatedBy = documents.every((d) => 'CreatedByID' in d);
      console.error(listHasCreatedBy
        ? '  document list rows carry CreatedByID — skipping per-file GetData calls'
        : '  document list rows have no CreatedByID — fetching GetData per document');
    }

    if (documents.length === 0) {
      return { status: 'done', expected: 0, downloaded: 0, failed: 0, error: undefined };
    }

    const caseDir = path.join(OUTPUT_DIR, caseId);
    fs.rmSync(caseDir, { recursive: true, force: true });
    fs.mkdirSync(caseDir, { recursive: true });

    const taken = new Set(['manifest.json', '.uploadstate.json']);
    const results = await Promise.all(
      documents.map((doc) => downloadOne(caseId, caseDir, taken, doc)),
    );
    const manifest = results.filter((r) => r.entry).map((r) => r.entry);
    const failedDocs = results.filter((r) => r.failure).map((r) => r.failure);

    fs.writeFileSync(path.join(caseDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return {
      status: failedDocs.length ? 'failed' : 'done',
      expected: documents.length,
      downloaded: manifest.length,
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
        ? `${result.downloaded}/${result.expected} document(s)${result.failed ? ` (${result.failed} FAILED)` : ''}`
        : `FAILED: ${result.error}`),
    );
  });

  console.error(`\nFinished. ${completed - failedCases}/${completed} case(s) fully downloaded, ${totalDocs} document(s)${failedCases ? `; ${failedCases} case(s) incomplete (re-run to retry)` : ''}.`);
  if (failedCases) process.exitCode = 1;
  await client.close();
})();
