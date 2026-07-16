const path = require('path');

// Every pipeline output hangs off one root so an isolated workspace (e.g. a
// single-case run under single/<caseId>/) only needs MIGRATION_ROOT pointed
// somewhere else — no per-file overrides.
function roots(root = process.env.MIGRATION_ROOT || path.join(__dirname, '..')) {
  return {
    root,
    caseList: path.join(root, 'caseList.txt'),
    dataDir: path.join(root, 'data'),
    documentsDir: path.join(root, 'documents'),
    sharedFile: path.join(root, 'shared.json'),
    ledgerFile: path.join(root, 'migrationState.json'),
  };
}

module.exports = { roots };
