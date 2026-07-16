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
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  // The downloader and uploader run at the same time against the same ledger
  // (each stage only writes its own section). A lock file serialises their
  // read-merge-write cycles; a crash can leave the lock behind, so a holder
  // older than LOCK_STALE_MS is stolen, and rather than deadlock forever a
  // write eventually proceeds unlocked (worst case one concurrent patch is
  // lost and that stage simply reruns on the next resume).
  const LOCK_STALE_MS = 5000;
  const lockFile = `${file}.lock`;
  function withLock(fn) {
    const deadline = Date.now() + LOCK_STALE_MS * 2;
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        try {
          return fn();
        } finally {
          fs.closeSync(fd);
          fs.rmSync(lockFile, { force: true });
        }
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(lockFile, { force: true });
          }
        } catch {}
        if (Date.now() > deadline) return fn();
        // Synchronous ~5ms sleep; these scripts have nothing else to do while
        // a ledger write is pending, so blocking the event loop is fine
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
  }

  // Re-reads the file, applies one mutation to the fresh state, and persists —
  // so concurrent processes never erase each other's sections. In-memory state
  // is replaced by the fresh copy (exposed via the `state` getter below).
  function patchAndSave(apply) {
    withLock(() => {
      try {
        const fresh = JSON.parse(fs.readFileSync(file, 'utf8'));
        fresh.staff ??= {};
        fresh.cases ??= {};
        state = fresh;
      } catch {} // missing/unreadable: keep our in-memory state
      apply();
      save();
    });
  }

  return {
    get state() { return state; },
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
      patchAndSave(() => {
        const caseEntry = (state.cases[caseId] ??= {});
        caseEntry[stage] = { ...caseEntry[stage], ...patch, at: new Date().toISOString() };
      });
    },
    setStaff(employeeId, record) {
      patchAndSave(() => {
        state.staff[employeeId] = { ...record, at: new Date().toISOString() };
      });
    },
  };
}

module.exports = { loadLedger, LEDGER_NAME };
