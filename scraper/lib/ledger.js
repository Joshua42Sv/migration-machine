const fs = require('fs');
const path = require('path');

const LEDGER_NAME = 'migrationState.json';

// One JSON file per migration root recording, per case, how far each pipeline
// stage got (export / documents / upload) plus the employeeId -> NotusPoint
// user mapping from the staff import. Kept deliberately compact — statuses and
// counts, no per-document detail — so rewriting it after every case stays
// cheap at thousands of cases. Per-file upload progress (documentId -> fileId)
// lives next to the files in documents/<caseId>/.uploadState.json.
//
// Stage statuses: absent/'pending' (not attempted), 'failed' (retried on the
// next resume run), 'done' (skipped on resume). Deleting this file makes every
// script start from scratch.
function loadLedger(root) {
  const file = path.join(root, LEDGER_NAME);
  let state = null;
  if (fs.existsSync(file)) {
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      const backup = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, backup);
      console.error(
        `WARNING: ${LEDGER_NAME} was unreadable (${err.message}); ` +
        `moved it to ${path.basename(backup)} and starting a fresh ledger.`,
      );
    }
  }
  state ??= {};
  state.staff ??= {};
  state.cases ??= {};

  function save() {
    // tmp + rename so a crash mid-write never leaves a half-written ledger
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    state,
    file,
    save,
    getCase(caseId) {
      return state.cases[caseId] ?? {};
    },
    stageStatus(caseId, stage) {
      return state.cases[caseId]?.[stage]?.status ?? 'pending';
    },
    // Shallow-merges patch into the stage section and persists immediately.
    // Pass an explicit `error: undefined` to clear a stale error on success.
    updateStage(caseId, stage, patch) {
      const caseEntry = (state.cases[caseId] ??= {});
      caseEntry[stage] = { ...caseEntry[stage], ...patch, at: new Date().toISOString() };
      save();
    },
    setStaff(employeeId, record) {
      state.staff[employeeId] = { ...record, at: new Date().toISOString() };
      save();
    },
  };
}

module.exports = { loadLedger, LEDGER_NAME };
