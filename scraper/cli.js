#!/usr/bin/env node
// Interactive menu for the Case Manager -> NotusPoint migration pipeline.
// Orchestrates the stage scripts (findCaseListEndpoint, runAll,
// downloadDocuments, uploadCases) by spawning them with inherited stdio, so
// their own progress output streams straight through. Progress is tracked in
// migrationState.json (see lib/ledger.js): every stage resumes where it left
// off, and "Wipe migration state" resets for a fresh start.
const path = require('path');
// .env lives next to this script; load it explicitly so the globally linked
// `migrate` command works from any directory
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { spawn } = require('child_process');
const fs = require('fs');
const {
  intro, outro, select, multiselect, text, confirm, isCancel, note, log,
} = require('@clack/prompts');
const pc = require('picocolors');
const { roots } = require('./lib/paths');
const { loadLedger, LEDGER_NAME } = require('./lib/ledger');

const DIR = __dirname;
const MAIN = roots(DIR);
const SINGLE_DIR = path.join(DIR, 'single');
const LEGACY_FILES = ['cases.json', 'structuredData.json'].map((f) => path.join(DIR, f));
const IMPORT_URL = process.env.IMPORT_URL || 'http://localhost:8080/api/importer/case';

// Wall-clock stamp appended to every log line (runs span days, so keep the date)
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return pc.dim(`[${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`);
}

// Re-emits a child stream line by line with the timestamp appended, so the
// stage scripts' own progress output stays untouched at the source.
function stampLines(src, dest) {
  let buf = '';
  src.setEncoding('utf8');
  src.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) dest.write(line.trim() ? `${line} ${ts()}\n` : `${line}\n`);
  });
  src.on('end', () => { if (buf) dest.write(`${buf} ${ts()}\n`); });
}

function run(script, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(DIR, script), ...args], {
      cwd: DIR,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    stampLines(child.stdout, process.stdout);
    stampLines(child.stderr, process.stderr);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Runs one pipeline step, echoing a heading before and a timed result after.
// Returns true on success. The stage scripts exit 1 on partial failures too,
// so false means "some cases need a retry", not necessarily "nothing worked" —
// every stage resumes, so re-running retries just the incomplete cases.
async function step(title, script, args = [], env = {}) {
  console.log('');
  log.step(`${pc.bold(title)} ${ts()}`);
  const started = Date.now();
  try {
    await run(script, args, env);
    log.success(`${pc.green(`${title} — done in ${fmtDuration(Date.now() - started)}`)} ${ts()}`);
    return true;
  } catch (err) {
    log.error(`${pc.red(`${title} — ${err.message} (after ${fmtDuration(Date.now() - started)})`)} ${ts()}`);
    return false;
  }
}

function countLines(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).length;
}

function readCaseList(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

function cancelled(value) {
  if (isCancel(value)) {
    log.warn('Cancelled — back to menu.');
    return true;
  }
  return false;
}

// A case is fully migrated when all three upload parts are done; cases with
// no Client contact are not importable and count separately.
function uploadComplete(entry) {
  const up = entry?.upload;
  return up?.case?.status === 'done'
    && up?.files?.status === 'done'
    && up?.costs?.status === 'done';
}

function tally(root = MAIN) {
  const ledger = loadLedger(root.root);
  const caseIds = readCaseList(root.caseList);
  const t = {
    listed: caseIds.length,
    exported: 0, exportFailed: 0,
    noClient: 0,
    docsDone: 0, docsFailed: 0,
    uploaded: 0,
    ledger,
    caseIds,
  };
  for (const id of caseIds) {
    const entry = ledger.state.cases[id];
    if (entry?.export?.status === 'done') {
      t.exported++;
      if (entry.export.hasClient === false) t.noClient++;
    } else if (entry?.export?.status === 'failed') t.exportFailed++;
    if (entry?.documents?.status === 'done') t.docsDone++;
    else if (entry?.documents?.status === 'failed') t.docsFailed++;
    if (entry?.export?.hasClient !== false && uploadComplete(entry)) t.uploaded++;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Menu actions
// ---------------------------------------------------------------------------

async function confirmUploadTarget() {
  note(
    `Importer: ${pc.cyan(IMPORT_URL)}\n` +
    'The NotusPoint importer must be running. Resumed runs are safe —\n' +
    'already-imported cases, files and staff are skipped via the ledger —\n' +
    'but if the NotusPoint DB was cleared since the last upload, wipe the\n' +
    'upload records first (menu → Wipe migration state → upload records).\n' +
    'Safe to run while the document download is still going: only cases\n' +
    'with completed documents upload; re-run to drain the rest.',
    'Before uploading',
  );
  const ok = await confirm({ message: 'Importer running and ledger in sync with the DB?' });
  return ok === true;
}

async function uploadDataset(root) {
  if (!fs.existsSync(root.dataDir)) {
    log.error('No exported data yet — run an export first.');
    return;
  }
  if (!(await confirmUploadTarget())) return;
  const withFiles = await confirm({ message: 'Upload documents/files too? ("No" = cases + costs only, no file links)' });
  if (cancelled(withFiles)) return;
  const args = [];
  if (withFiles === false) args.push('--skip-files');
  await step('Upload to NotusPoint', 'uploadCases.js', args, { MIGRATION_ROOT: root.root });
}

async function runPipeline({ fresh }) {
  if (fresh) {
    const haveState = fs.existsSync(MAIN.ledgerFile) || fs.existsSync(MAIN.dataDir);
    if (haveState) {
      const wiped = await wipeEverything({ includeSingles: false });
      if (!wiped) return;
    }
  }

  if (!fs.existsSync(MAIN.caseList)) {
    log.error('No caseList.txt — create it in this directory with one case ID per line, then re-run.');
    return;
  }

  log.info(`${countLines(MAIN.caseList)} case(s) in the list.`);
  const exportOk = await step('Export case data', 'runAll.js');
  const docsOk = await step('Download documents', 'downloadDocuments.js');
  if (!exportOk || !docsOk) {
    log.warn('Some cases failed to export/download — run "Resume / retry" to retry them before uploading, or continue anyway.');
    const anyway = await confirm({ message: 'Continue to upload anyway?', initialValue: false });
    if (cancelled(anyway) || anyway !== true) return;
  } else {
    const upload = await confirm({ message: 'Export complete. Upload to NotusPoint now?' });
    if (cancelled(upload) || upload !== true) {
      log.info('Skipped upload — run "Upload to NotusPoint" from the menu when ready.');
      return;
    }
  }
  await uploadDataset(MAIN);
}

// A single case gets its own workspace under single/<caseId>/ (its own data,
// documents and ledger via MIGRATION_ROOT) so it never touches the full run.
async function singleCase() {
  const caseId = await text({
    message: 'Case Manager case ID to migrate:',
    placeholder: 'e.g. 13938',
    validate: (v) => (/^\d+$/.test((v ?? '').trim()) ? undefined : 'Enter a numeric case ID'),
  });
  if (cancelled(caseId)) return;
  const id = caseId.trim();

  const root = roots(path.join(SINGLE_DIR, id));
  fs.mkdirSync(root.root, { recursive: true });
  fs.writeFileSync(root.caseList, `${id}\n`);
  const env = { MIGRATION_ROOT: root.root };
  log.info(`Workspace: ${pc.dim(path.relative(DIR, root.root))} (the full run's data is untouched)`);

  if (!(await step(`Export case ${id}`, 'runAll.js', [], env))) return;
  if (!(await step(`Download documents for ${id}`, 'downloadDocuments.js', [], env))) return;

  const upload = await confirm({ message: `Upload case ${id} to NotusPoint now?` });
  if (cancelled(upload) || upload !== true) {
    log.info(`Skipped upload — data kept in ${path.relative(DIR, root.root)}.`);
    return;
  }
  await uploadDataset(root);
}

function singleWorkspaces() {
  if (!fs.existsSync(SINGLE_DIR)) return [];
  return fs.readdirSync(SINGLE_DIR).filter((d) =>
    fs.existsSync(path.join(SINGLE_DIR, d, 'data')));
}

async function uploadMenu() {
  const singles = singleWorkspaces();
  let root = MAIN;

  if (singles.length) {
    const choice = await select({
      message: 'Which dataset do you want to upload?',
      options: [
        { value: 'full', label: 'Full export', hint: 'data/ + documents/' },
        ...singles.map((id) => ({
          value: id, label: `Single case ${id}`, hint: `single/${id}/`,
        })),
      ],
    });
    if (cancelled(choice)) return;
    if (choice !== 'full') root = roots(path.join(SINGLE_DIR, choice));
  }
  await uploadDataset(root);
}

// ---------------------------------------------------------------------------
// Verify — cross-checks the ledger against the case list and the files on
// disk, and writes the full detail to verifyReport.json.
// ---------------------------------------------------------------------------

async function verify() {
  if (!fs.existsSync(MAIN.caseList)) { log.error('No caseList.txt to verify against.'); return; }
  const ledger = loadLedger(MAIN.root);
  const caseIds = readCaseList(MAIN.caseList);

  const issues = [];
  const warnings = [];
  const noClient = [];
  let complete = 0;

  for (const id of caseIds) {
    const entry = ledger.state.cases[id] ?? {};
    const problems = [];
    const exp = entry.export;
    const docs = entry.documents;
    const up = entry.upload;

    if (exp?.status !== 'done') {
      problems.push(`export ${exp?.status ?? 'pending'}${exp?.error ? ` (${exp.error})` : ''}`);
    } else if (exp.hasClient === false) {
      noClient.push(id);
    }

    if (docs?.status !== 'done') {
      problems.push(`documents ${docs?.status ?? 'pending'}${docs?.expected != null ? ` (${docs.downloaded}/${docs.expected})` : ''}`);
    } else if (docs.downloaded > 0) {
      // Trust nothing: recount what's actually on disk against the manifest
      const caseDir = path.join(MAIN.documentsDir, id);
      const manifestPath = path.join(caseDir, 'manifest.json');
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.length !== docs.downloaded) {
          problems.push(`manifest lists ${manifest.length} file(s), ledger says ${docs.downloaded}`);
        }
        const missing = manifest.filter((e) => !fs.existsSync(path.join(caseDir, e.filename)));
        if (missing.length) problems.push(`${missing.length} manifest file(s) missing on disk`);
      } catch {
        problems.push('manifest.json missing or unreadable');
      }
    }

    if (exp?.status === 'done' && exp.hasClient !== false) {
      if (up?.case?.status !== 'done') {
        problems.push(`case upload ${up?.case?.status ?? 'pending'}${up?.case?.error ? ` (${up.case.error})` : ''}`);
      }
      if (up?.files) {
        if (up.files.status !== 'done' || up.files.uploaded < up.files.expected) {
          problems.push(`files ${up.files.uploaded ?? 0}/${up.files.expected ?? '?'} uploaded`);
        }
      } else if ((docs?.downloaded ?? 0) > 0 && up?.case?.status === 'done') {
        problems.push('files not uploaded');
      }
      if (up?.costs?.status !== 'done') {
        if ((exp.counts?.costs ?? 0) > 0 || up?.costs) {
          problems.push(`costs ${up?.costs?.status ?? 'pending'}${up?.costs?.error ? ` (${up.costs.error})` : ''}`);
        }
      } else {
        if (up.costs.missingFileLinks > 0) {
          warnings.push(`${id}: ${up.costs.missingFileLinks} cost(s) imported without their file link`);
        }
        if (up.costs.skippedUnlinked > 0) {
          warnings.push(`${id}: ${up.costs.skippedUnlinked} cost(s) skipped (not linked to an estimate item in Case Manager)`);
        }
      }
    }

    if (problems.length) issues.push({ caseId: id, problems });
    else if (exp?.hasClient !== false) complete++;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    casesInList: caseIds.length,
    fullyMigrated: complete,
    notImportableNoClient: noClient,
    issues,
    warnings,
  };
  const reportFile = path.join(MAIN.root, 'verifyReport.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  const lines = [
    `${pc.green(`${complete}/${caseIds.length}`)} case(s) fully migrated (export + documents + upload verified)`,
    noClient.length ? `${noClient.length} case(s) have no Client contact — nothing importable` : null,
    issues.length ? pc.red(`${issues.length} case(s) with problems:`) : pc.green('No problems found.'),
    ...issues.slice(0, 15).map((i) => `  ${i.caseId}: ${i.problems.join('; ')}`),
    issues.length > 15 ? pc.dim(`  ...and ${issues.length - 15} more`) : null,
    warnings.length ? pc.yellow(`${warnings.length} warning(s):`) : null,
    ...warnings.slice(0, 10).map((w) => `  ${w}`),
    warnings.length > 10 ? pc.dim(`  ...and ${warnings.length - 10} more`) : null,
    '',
    pc.dim(`Full report: ${path.basename(reportFile)}`),
  ].filter((l) => l !== null);
  note(lines.join('\n'), 'Verification');

  if (issues.length) {
    log.info('"Resume / retry" will retry the incomplete stages for these cases.');
  }
}

// ---------------------------------------------------------------------------
// Wipe
// ---------------------------------------------------------------------------

function rmAll(targets) {
  for (const target of targets) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

async function wipeEverything({ includeSingles }) {
  const targets = [MAIN.ledgerFile, MAIN.dataDir, MAIN.documentsDir, MAIN.sharedFile,
    path.join(MAIN.root, 'verifyReport.json'), ...LEGACY_FILES];
  if (includeSingles) targets.push(SINGLE_DIR);
  const existing = targets.filter((t) => fs.existsSync(t));
  if (!existing.length) { log.info('Nothing to wipe — already clean.'); return true; }

  note(existing.map((t) => `  ${path.relative(DIR, t)}`).join('\n'), pc.red('This deletes'));
  const sure = await confirm({
    message: pc.red('Delete all migration state and exported data? (Case Manager is untouched; everything can be re-scraped)'),
    initialValue: false,
  });
  if (cancelled(sure) || sure !== true) return false;
  rmAll(existing);
  log.success('Wiped — the next run starts completely fresh.');
  return true;
}

// After clearing the NotusPoint DB: forget what was uploaded (upload sections,
// staff user ids, per-case .uploadState.json sidecars) but keep everything
// scraped from Case Manager, so re-uploading needs no re-scrape.
async function wipeUploadRecords() {
  const sure = await confirm({
    message: 'Reset upload records (keeps all exported data + documents)? Do this after clearing the NotusPoint DB.',
    initialValue: false,
  });
  if (cancelled(sure) || sure !== true) return;

  const ledger = loadLedger(MAIN.root);
  let cleared = 0;
  for (const entry of Object.values(ledger.state.cases)) {
    if (entry.upload) { delete entry.upload; cleared++; }
  }
  ledger.state.staff = {};
  ledger.save();

  let sidecars = 0;
  if (fs.existsSync(MAIN.documentsDir)) {
    for (const d of fs.readdirSync(MAIN.documentsDir)) {
      const sidecar = path.join(MAIN.documentsDir, d, '.uploadState.json');
      if (fs.existsSync(sidecar)) { fs.rmSync(sidecar); sidecars++; }
    }
  }
  log.success(`Reset upload records for ${cleared} case(s), ${sidecars} file-upload sidecar(s), and the staff map.`);
  log.info('Note: single-case workspaces keep their own ledgers — wipe those separately if needed.');
}

// Deletes everything containing client/staff data scraped from Case Manager
// (case data, documents, employee lists, the ledger with its staff emails)
// so the repo is safe to open up — e.g. to AI tooling. caseList.txt stays
// (just sequential case ids, not sensitive), as do code, config and .env.
async function purgeSensitiveData() {
  const targets = [
    MAIN.dataDir, MAIN.documentsDir, MAIN.sharedFile, MAIN.ledgerFile,
    path.join(MAIN.root, 'verifyReport.json'), ...LEGACY_FILES, SINGLE_DIR,
  ];
  const existing = targets.filter((t) => fs.existsSync(t));
  if (!existing.length) { log.info('Nothing to purge — no scraped data present.'); return; }

  note(
    existing.map((t) => `  ${path.relative(DIR, t)}`).join('\n') +
    `\n\n${pc.dim('Kept: caseList.txt (just case ids) and .env (credentials).')}`,
    pc.red('This deletes'),
  );
  const sure = await confirm({
    message: pc.red('Delete ALL scraped case/client data and migration progress?'),
    initialValue: false,
  });
  if (cancelled(sure) || sure !== true) return;
  rmAll(existing);
  log.success('Purged — no client data remains in the repo (only code, config and .env).');
}

async function wipeMenu() {
  const choice = await select({
    message: 'What do you want to wipe?',
    options: [
      { value: 'everything', label: '🔥 Everything (start afresh)', hint: 'ledger + exported data + documents + single-case workspaces' },
      { value: 'upload', label: '↩️  Upload records only', hint: 'after clearing the NotusPoint DB; keeps all scraped data' },
      { value: 'custom', label: '🧩 Choose components...' },
    ],
  });
  if (cancelled(choice)) return;

  if (choice === 'everything') { await wipeEverything({ includeSingles: true }); return; }
  if (choice === 'upload') { await wipeUploadRecords(); return; }

  const parts = await multiselect({
    message: 'Select components to delete:',
    options: [
      { value: 'ledger', label: `Ledger (${LEDGER_NAME} + verifyReport.json)`, hint: 'all progress forgotten; scripts redo everything' },
      { value: 'data', label: 'Exported case data (data/, shared.json, legacy cases.json/structuredData.json)' },
      { value: 'documents', label: 'Downloaded documents (documents/)' },
      { value: 'singles', label: 'Single-case workspaces (single/)' },
    ],
    required: true,
  });
  if (cancelled(parts)) return;

  const targets = [];
  if (parts.includes('ledger')) targets.push(MAIN.ledgerFile, path.join(MAIN.root, 'verifyReport.json'));
  if (parts.includes('data')) targets.push(MAIN.dataDir, MAIN.sharedFile, ...LEGACY_FILES);
  if (parts.includes('documents')) targets.push(MAIN.documentsDir);
  if (parts.includes('singles')) targets.push(SINGLE_DIR);
  const existing = targets.filter((t) => fs.existsSync(t));
  if (!existing.length) { log.info('Nothing to wipe — those are already clean.'); return; }

  note(existing.map((t) => `  ${path.relative(DIR, t)}`).join('\n'), pc.red('This deletes'));
  const sure = await confirm({ message: pc.red('Delete the selected components?'), initialValue: false });
  if (cancelled(sure) || sure !== true) return;
  rmAll(existing);
  log.success('Wiped.');
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function status() {
  const lines = [];
  const creds = process.env.CM_USER && process.env.CM_PASS;
  lines.push(`Case Manager credentials  ${creds ? pc.green('set') : pc.red('MISSING (.env CM_USER / CM_PASS)')}`);
  lines.push(`Importer URL              ${pc.cyan(IMPORT_URL)}`);
  lines.push('');

  if (!fs.existsSync(MAIN.caseList)) {
    lines.push(pc.dim('No caseList.txt yet — rebuild the case list to begin.'));
  } else {
    const t = tally();
    const stage = (done, failed, label) => {
      const pendingCount = t.listed - done - failed;
      let s = `${done}/${t.listed} done`;
      if (failed) s += pc.red(` · ${failed} failed`);
      if (pendingCount > 0) s += pc.dim(` · ${pendingCount} pending`);
      return `${label.padEnd(26)}${s}`;
    };
    lines.push(`${'Case list'.padEnd(26)}${t.listed} case(s)`);
    lines.push(stage(t.exported, t.exportFailed, 'Exported'));
    if (t.noClient) lines.push(`${''.padEnd(26)}${pc.dim(`${t.noClient} with no Client contact (not importable)`)}`);
    lines.push(stage(t.docsDone, t.docsFailed, 'Documents downloaded'));
    lines.push(`${'Uploaded to NotusPoint'.padEnd(26)}${t.uploaded}/${t.listed - t.noClient} importable case(s) fully uploaded`);
  }

  const singles = singleWorkspaces();
  if (singles.length) lines.push(`${'Single-case workspaces'.padEnd(26)}${singles.join(', ')}`);

  // Quick reachability probe so an upload isn't attempted against nothing.
  try {
    await fetch(IMPORT_URL, { method: 'OPTIONS', signal: AbortSignal.timeout(3000) });
    lines.push(`${'NotusPoint importer'.padEnd(26)}${pc.green('reachable')}`);
  } catch {
    lines.push(`${'NotusPoint importer'.padEnd(26)}${pc.red('not reachable')} ${pc.dim('(is the dev server on :8080 running?)')}`);
  }

  note(lines.join('\n'), 'Migration status');
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

(async () => {
  console.clear();
  intro(pc.bgCyan(pc.black(' Case Manager → NotusPoint — Migration Machine ')));

  if (!process.env.CM_USER || !process.env.CM_PASS) {
    log.warn(pc.yellow('CM_USER / CM_PASS not set in .env — Case Manager steps will fail.'));
  }

  for (;;) {
    console.log('');
    const action = await select({
      message: 'What do you want to do?',
      options: [
        { value: 'full', label: '🚀 Full migration (fresh)', hint: 'wipes state, then case list → export → documents → upload' },
        { value: 'resume', label: '▶️  Resume / retry', hint: 'continue where it left off; retries failed cases' },
        { value: 'single', label: '🎯 Migrate one case', hint: 'isolated workspace, full run untouched' },
        { value: 'export', label: '📦 Export case data', hint: 'runAll.js → data/<caseId>.json (resumes)' },
        { value: 'docs', label: '📄 Download documents', hint: 'downloadDocuments.js → documents/ (resumes)' },
        { value: 'upload', label: '⬆️  Upload to NotusPoint', hint: 'uploadCases.js → importer API (resumes)' },
        { value: 'verify', label: '✅ Verify migration', hint: 'cross-check ledger vs case list vs files on disk' },
        { value: 'status', label: '📊 Status', hint: 'per-stage progress and importer reachability' },
        { value: 'wipe', label: '🧹 Wipe migration state', hint: 'start afresh, or reset upload records after a DB clear' },
        { value: 'purge', label: '🔒 Purge sensitive data', hint: 'delete ALL scraped client data + docs (before sharing the repo)' },
        { value: 'exit', label: '🚪 Exit' },
      ],
    });
    if (isCancel(action) || action === 'exit') break;

    switch (action) {
      case 'full': await runPipeline({ fresh: true }); break;
      case 'resume': await runPipeline({ fresh: false }); break;
      case 'single': await singleCase(); break;
      case 'export': {
        if (!fs.existsSync(MAIN.caseList)) { log.error('No caseList.txt — create it with one case ID per line first.'); break; }
        await step('Export case data', 'runAll.js');
        break;
      }
      case 'docs': {
        if (!fs.existsSync(MAIN.caseList)) { log.error('No caseList.txt — create it with one case ID per line first.'); break; }
        await step('Download documents', 'downloadDocuments.js');
        break;
      }
      case 'upload': await uploadMenu(); break;
      case 'verify': await verify(); break;
      case 'status': await status(); break;
      case 'wipe': await wipeMenu(); break;
      case 'purge': await purgeSensitiveData(); break;
    }
  }

  outro(pc.dim('Bye — nothing was left running.'));
})();
