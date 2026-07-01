require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { login, getCaseDocuments, downloadDocumentFile, getCaseDocumentData } = require('./lib/apiClient');

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

function buildEml(doc) {
  const lines = [];
  if (doc.From) lines.push(`From: ${doc.From}`);
  if (doc.To) lines.push(`To: ${doc.To}`);
  if (doc.CC) lines.push(`Cc: ${doc.CC}`);
  if (doc.BCC) lines.push(`Bcc: ${doc.BCC}`);
  lines.push(`Subject: ${doc.Title ?? ''}`);
  lines.push(`Date: ${new Date(doc.DateCreated).toUTCString()}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/html; charset="UTF-8"');
  lines.push('');
  lines.push(doc.HtmlDoc ?? '');
  return lines.join('\r\n');
}

function buildHtml(doc) {
  const body = doc.HtmlDoc || `<pre>${doc.Details ?? ''}</pre>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${doc.Title ?? ''}</title></head><body>${body}</body></html>`;
}

async function downloadNonFileDoc(context, token, caseId, doc) {
  const data = await getCaseDocumentData(context, token, caseId, doc.ID);
  if (data.Attachments?.length > 0) {
    console.error(`  note: ${doc.Title} has ${data.Attachments.length} attachment(s) not yet handled`);
  }
  if (doc.FileExtension === '.eml') {
    return { buffer: Buffer.from(buildEml(data), 'utf8'), filename: `${data.Title}.eml` };
  }
  return { buffer: Buffer.from(buildHtml(data), 'utf8'), filename: `${data.Title}.html` };
}

(async () => {
  const caseIds = readCaseList();
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

      for (const doc of documents) {
        const { buffer, filename } = doc.IsFile
          ? await downloadDocumentFile(context, doc.ID)
          : await downloadNonFileDoc(context, token, caseId, doc);
        const safeName = uniquePath(caseDir, sanitizeFilename(filename));
        fs.writeFileSync(path.join(caseDir, safeName), buffer);
      }
      console.error(`${progress} Case ${caseId}: saved ${documents.length} document(s)`);
    } catch (err) {
      console.error(`${progress} Case ${caseId} FAILED: ${err.message}`);
    }
  }

  console.error(`\nFinished. ${done}/${caseIds.length} cases processed.`);
  await browser.close();
})();
