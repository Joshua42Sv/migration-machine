require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient, isBrowserGone } = require('./lib/cmClient');
const { mapPool } = require('./lib/pool');
const { roots } = require('./lib/paths');
const { loadLedger } = require('./lib/ledger');
const { buildLookupMap, buildEmployeeMap, buildStructuredCase, countsFor } = require('./lib/structured');

const USERNAME = process.env.CM_USER || '';
const PASSWORD = process.env.CM_PASS || '';
const paths = roots();
const LIST_FILE = process.argv[2] || paths.caseList;
// How many cases capture concurrently. Total CM load is governed by the
// client's global CM_MAX_INFLIGHT cap either way; this just keeps enough
// case work queued to fill it.
const CASE_CONCURRENCY = Number(process.env.CM_CASE_CONCURRENCY ?? 12);

if (!USERNAME || !PASSWORD) {
  console.error('Set CM_USER and CM_PASS environment variables');
  process.exit(1);
}

if (!fs.existsSync(LIST_FILE)) {
  console.error(`Case list file not found: ${LIST_FILE}`);
  console.error('Create caseList.txt with one case ID per line');
  process.exit(1);
}

function readCaseList() {
  return fs.readFileSync(LIST_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

(async () => {
  const ledger = loadLedger(paths.root);
  const caseIds = readCaseList();
  // Resume: 'done' cases are skipped; 'failed' and never-attempted cases run.
  // Wipe via the CLI (or delete migrationState.json) to re-export everything.
  const pending = caseIds.filter(id => ledger.stageStatus(id, 'export') !== 'done');

  console.error(`Total: ${caseIds.length} case(s) in list, ${caseIds.length - pending.length} already exported, ${pending.length} to fetch`);

  if (!pending.length) {
    console.error('Nothing to export — all cases are already done.');
    return;
  }

  fs.mkdirSync(paths.dataDir, { recursive: true });

  console.error('Logging in...');
  const client = await createClient({ username: USERNAME, password: PASSWORD });
  console.error('Logged in\n');

  console.error('Fetching lookup + employee lists...');
  const [lookups, employeeList] = await Promise.all([
    client.getAllLookups(),
    client.getEmployeeList(),
  ]);
  const lookup = buildLookupMap(lookups);
  const employeeMap = buildEmployeeMap(employeeList);
  fs.writeFileSync(paths.sharedFile, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    lookups,
    employees: Object.entries(employeeMap).map(([id, e]) => ({ id, ...e })),
  }, null, 2));
  console.error(`Saved lookups + ${employeeList.length} employee(s) to ${path.basename(paths.sharedFile)}\n`);

  let completed = 0;
  let failed = 0;
  await mapPool(pending, CASE_CONCURRENCY, async (caseId) => {
    try {
      const endpoints = await client.captureCase(caseId);
      const structured = buildStructuredCase(caseId, endpoints, lookup, employeeMap);
      fs.writeFileSync(
        path.join(paths.dataDir, `${caseId}.json`),
        JSON.stringify({ fetchedAt: new Date().toISOString(), endpoints, structured }, null, 2),
      );
      ledger.updateStage(caseId, 'export', {
        status: 'done',
        hasClient: !!structured,
        counts: countsFor(structured),
        error: undefined,
      });
      completed++;
      console.error(`[${completed + failed}/${pending.length}] Case ${caseId} exported${structured ? '' : ' (no Client contact — not importable)'}`);
    } catch (err) {
      if (isBrowserGone(err)) {
        console.error('\nAborted: the browser was closed mid-run (Ctrl+C?). Re-run to resume.');
        process.exit(1);
      }
      failed++;
      ledger.updateStage(caseId, 'export', { status: 'failed', error: err.message });
      console.error(`[${completed + failed}/${pending.length}] Case ${caseId} FAILED: ${err.message}`);
    }
  });

  console.error(`\nFinished. ${completed}/${pending.length} case(s) exported${failed ? `, ${failed} FAILED (re-run to retry)` : ''}.`);
  if (failed) process.exitCode = 1;
  await client.close();
})();
