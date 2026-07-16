// One-off repair: earlier downloads classified every unknown extension as
// CASE_NOTE, which the importer UTF-8-decodes into noteText (binary archives
// then fail with "invalid byte sequence for encoding UTF8: 0x00"). Genuine
// notes are always built as <Title>.html, so any CASE_NOTE manifest entry
// whose filename is not .html/.htm is a real file and becomes OTHER.
//
// Usage: node fixManifestFileTypes.js [--dry-run]
const fs = require('fs');
const path = require('path');
const { roots } = require('./lib/paths');

const paths = roots();
const DRY_RUN = process.argv.includes('--dry-run');

let patched = 0;
let casesTouched = 0;

for (const caseId of fs.readdirSync(paths.documentsDir)) {
  const manifestPath = path.join(paths.documentsDir, caseId, 'manifest.json');
  if (!fs.existsSync(manifestPath)) continue;

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let changed = 0;
  for (const entry of manifest) {
    if (entry.fileType === 'CASE_NOTE' && !/\.html?$/i.test(entry.filename)) {
      entry.fileType = 'OTHER';
      changed++;
    }
  }

  if (changed) {
    if (!DRY_RUN) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.error(`${caseId}: ${changed} entr${changed === 1 ? 'y' : 'ies'} -> OTHER`);
    patched += changed;
    casesTouched++;
  }
}

console.error(
  `${DRY_RUN ? '[dry-run] would patch' : 'Patched'} ${patched} entr${patched === 1 ? 'y' : 'ies'} across ${casesTouched} case(s)`,
);
