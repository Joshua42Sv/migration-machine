require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { login, captureCase, getAllLookups } = require('./lib/apiClient');

const USERNAME = process.env.CM_USER || '';
const PASSWORD = process.env.CM_PASS || '';
const LIST_FILE = process.argv[2] || path.join(__dirname, 'caseList.txt');
const OUTPUT_FILE = path.join(__dirname, 'cases.json');
const STRUCTURED_FILE = path.join(__dirname, 'structuredData.json');

if (!USERNAME || !PASSWORD) {
  console.error('Set CM_USER and CM_PASS environment variables');
  process.exit(1);
}

if (!fs.existsSync(LIST_FILE)) {
  console.error(`Case list file not found: ${LIST_FILE}`);
  console.error('Create caseList.txt with one case ID per line');
  process.exit(1);
}

function saveCases(data, lookups) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
  saveStructuredData(data, lookups);
}

function buildLookupMap(lookups) {
  const map = {};
  for (const list of Object.values(lookups)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item.ID && item.Description) map[item.ID] = item.Description;
    }
  }
  return map;
}

function nullId(id) {
  return !id || id === '00000000-0000-0000-0000-000000000000';
}

function resolveId(map, id) {
  if (nullId(id)) return '';
  return map[id] ?? '';
}

function formatDate(iso) {
  if (!iso) return '';
  return iso.split('T')[0];
}

function saveStructuredData(data, lookups) {
  const lookup = buildLookupMap(lookups);
  const cases = [];
  const causesMap = {};
  const conditionsMap = {};
  const employmentStatusesMap = {};

  for (const [caseId, caseData] of Object.entries(data)) {
    if (caseData.error) continue;

    const contacts = caseData.endpoints?.['/CaseContact/_List'];
    if (!contacts) continue;
    const contactList = Array.isArray(contacts[0]?.data) ? contacts[0].data : [];
    const client = contactList.find(c => c.PrimaryRoleName === 'Client');
    if (!client) continue;

    const caseInfo = caseData.endpoints?.['/Case/GetData']?.[0] ?? {};
    const titlePart = client.ContactName?.split(', ')[2] ?? '';

    const causeId = nullId(caseInfo.CauseID) ? '' : caseInfo.CauseID;
    const causeDescription = resolveId(lookup, caseInfo.CauseID);
    const conditionId = nullId(caseInfo.ConditionID) ? '' : caseInfo.ConditionID;
    const conditionDescription = resolveId(lookup, caseInfo.ConditionID);
    const employmentStatusId = nullId(caseInfo.EmploymentStatusID) ? '' : caseInfo.EmploymentStatusID;
    const employmentStatusDescription = resolveId(lookup, caseInfo.EmploymentStatusID);

    if (causeId) causesMap[causeId] = causeDescription;
    if (conditionId) conditionsMap[conditionId] = conditionDescription;
    if (employmentStatusId) employmentStatusesMap[employmentStatusId] = employmentStatusDescription;

    cases.push({
      caseId,
      title: titlePart,
      firstName: client.FirstName ?? '',
      lastName: client.LastName ?? '',
      email: client.Email ?? '',
      phone: client.Phone ?? '',
      referralDate: formatDate(caseInfo.DateOfReferral),
      dateClosed: formatDate(caseInfo.DateClosed),
      employmentStatusId,
      employmentStatusDescription,
      causeId,
      causeDescription,
      conditionId,
      conditionDescription,
    });
  }

  const causes = Object.entries(causesMap).map(([id, description]) => ({ id, description }));
  const conditions = Object.entries(conditionsMap).map(([id, description]) => ({ id, description }));
  const employmentStatuses = Object.entries(employmentStatusesMap).map(([id, description]) => ({ id, description }));

  fs.writeFileSync(STRUCTURED_FILE, JSON.stringify({ cases, causes, conditions, employmentStatuses }, null, 2));
}

function readCaseList() {
  return fs.readFileSync(LIST_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

(async () => {
  const caseIds = readCaseList();
  const cases = {};

  console.error(`Total: ${caseIds.length} cases to fetch`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  console.error('Logging in...');
  const token = await login(context, USERNAME, PASSWORD);
  console.error('Logged in\n');

  console.error('Fetching lookup lists...');
  const lookups = await getAllLookups(context, token);
  console.error('Done fetching lookups\n');

  let done = 0;
  for (const caseId of caseIds) {
    done++;
    const progress = `[${done}/${caseIds.length}]`;
    try {
      process.stderr.write(`${progress} Capturing case ${caseId}... `);
      const endpoints = await captureCase(context, token, caseId);
      cases[caseId] = { fetchedAt: new Date().toISOString(), endpoints };
      saveCases(cases, lookups);
      console.error('done');
    } catch (err) {
      console.error(`FAILED: ${err.message}`);
      cases[caseId] = { fetchedAt: new Date().toISOString(), error: err.message };
      saveCases(cases, lookups);
    }
  }

  console.error(`\nFinished. ${done}/${caseIds.length} cases processed.`);
  await browser.close();
})();
