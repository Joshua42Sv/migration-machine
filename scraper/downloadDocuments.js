require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const {
  login, getCaseDocuments, downloadDocumentFile, downloadDocumentAttachment, getCaseDocumentData,
} = require('./lib/apiClient');

const USERNAME = process.env.CM_USER || '';
const PASSWORD = process.env.CM_PASS || '';
const LIST_FILE = process.argv[2] || path.join(__dirname, 'caseList.txt');
const OUTPUT_DIR = path.join(__dirname, 'documents');

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

function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let i = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base} (${i})${ext}`;
    i++;
  }
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

// After Ctrl+C (or a crash) Playwright closes the browser but the loop keeps
// running; every remaining request fails with one of these. Treat them as
// fatal so we abort instead of logging hundreds of failures and writing a
// junk manifest.
function isBrowserGone(err) {
  return /browser has been closed|Request context disposed/i.test(err.message ?? '');
}

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
  return 'CASE_NOTE';
}

async function downloadNonFileDoc(context, token, caseId, doc) {
  const data = await getCaseDocumentData(context, token, caseId, doc.ID);
  if (doc.FileExtension === '.eml') {
    // A failed attachment shouldn't lose the email itself; build the .eml
    // with whatever downloaded and report the rest
    const attachments = [];
    for (const att of data.Attachments ?? []) {
      try {
        const { buffer } = await downloadDocumentAttachment(context, att.DocumentID, att.AttachmentID);
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

(async () => {
  const caseIds = readCaseList();
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.error(`Total: ${caseIds.length} cases to fetch documents for`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  console.error('Logging in...');
  const token = await login(context, USERNAME, PASSWORD);
  console.error('Logged in\n');

  let done = 0;
  for (const caseId of caseIds) {
    done++;
    const progress = `[${done}/${caseIds.length}]`;
    try {
      const documents = await getCaseDocuments(context, token, caseId);

      if (documents.length === 0) {
        console.error(`${progress} Case ${caseId}: no documents`);
        continue;
      }

      const caseDir = path.join(OUTPUT_DIR, caseId);
      fs.mkdirSync(caseDir, { recursive: true });

      // One bad document must not abort the case: the manifest is written
      // regardless, listing what succeeded, so the upload step always has it
      const manifest = [];
      const failedDocs = [];
      let docIndex = 0;
      for (const doc of documents) {
        docIndex++;
        const title = (doc.Title ?? doc.ID).slice(0, 60);
        process.stderr.write(
          `\r  [${docIndex}/${documents.length}] ${title}`.padEnd(80) + '\r',
        );
        try {
          const { buffer, filename } = doc.IsFile
            ? await downloadDocumentFile(context, doc.ID)
            : await downloadNonFileDoc(context, token, caseId, doc);
          const safeName = uniquePath(caseDir, sanitizeFilename(filename));
          fs.writeFileSync(path.join(caseDir, safeName), buffer);
          manifest.push({
            documentId: doc.ID,
            filename: safeName,
            title: doc.Title ?? safeName,
            fileType: classifyFileType(doc),
            dateUploaded: doc.DateCreated ?? '',
          });
        } catch (err) {
          if (isBrowserGone(err)) throw err;
          failedDocs.push({ id: doc.ID, title: doc.Title ?? '', error: err.message });
          console.error(`\n  document "${doc.Title ?? doc.ID}" FAILED: ${err.message}`);
        }
      }
      process.stderr.write(''.padEnd(80) + '\r');
      fs.writeFileSync(path.join(caseDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      console.error(
        `${progress} Case ${caseId}: saved ${manifest.length}/${documents.length} document(s)` +
          (failedDocs.length ? `, ${failedDocs.length} FAILED` : ''),
      );
    } catch (err) {
      if (isBrowserGone(err)) {
        console.error(`\nAborted: the browser was closed mid-run (Ctrl+C?). No manifest written for case ${caseId}; re-run to get a complete download.`);
        process.exit(1);
      }
      console.error(`${progress} Case ${caseId} FAILED: ${err.message}`);
    }
  }

  console.error(`\nFinished. ${done}/${caseIds.length} cases processed.`);
  await browser.close();
})();
