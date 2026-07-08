require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { login, captureCase, getAllLookups, getEmployeeList } = require('./lib/apiClient');

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

function saveCases(data, lookups, employeeList) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
  saveStructuredData(data, lookups, employeeList);
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

function buildEmployeeMap(employeeList) {
  const map = {};
  for (const employee of employeeList) {
    if (!employee.ID) continue;
    map[employee.ID] = {
      firstName: employee.FirstName ?? '',
      lastName: employee.LastName ?? '',
      email: employee.UserID ?? '',
      phone: employee.Phone1 ?? '',
      qualifications: employee.ServicesDescription ?? '',
    };
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

function buildAddress(map, { street, suburb, postalCode, regionId, countryId }) {
  return {
    addressLine1: street ?? '',
    addressLine2: '',
    suburb: suburb ?? '',
    state: resolveId(map, regionId),
    postcode: postalCode ?? '',
    country: resolveId(map, countryId),
  };
}

function saveStructuredData(data, lookups, employeeList) {
  const lookup = buildLookupMap(lookups);
  const employeeMap = buildEmployeeMap(employeeList);
  const cases = [];
  const causesMap = {};
  const conditionsMap = {};
  const employmentStatusesMap = {};
  const statusesMap = {};
  const categoriesMap = {};
  const requirementsMap = {};
  const usedEmployeeIds = new Set();

  for (const [caseId, caseData] of Object.entries(data)) {
    if (caseData.error) continue;

    const contacts = caseData.endpoints?.['/CaseContact/_List'];
    if (!contacts) continue;
    const contactList = Array.isArray(contacts[0]?.data) ? contacts[0].data : [];
    const client = contactList.find(c => c.PrimaryRoleName === 'Client');
    if (!client) continue;

    const caseInfo = caseData.endpoints?.['/Case/GetData']?.[0] ?? {};
    const titlePart = client.ContactName?.split(', ')[2] ?? '';
    const contactInfo = caseData.endpoints?.['/CaseContact/GetData']?.[0]?.ContactInfo ?? {};
    const referrerInfo = caseData.endpoints?.referrerContact?.[0]?.ContactInfo ?? {};

    const causeId = nullId(caseInfo.CauseID) ? '' : caseInfo.CauseID;
    const causeDescription = resolveId(lookup, caseInfo.CauseID);
    const conditionId = nullId(caseInfo.ConditionID) ? '' : caseInfo.ConditionID;
    const conditionDescription = resolveId(lookup, caseInfo.ConditionID);
    const employmentStatusId = nullId(caseInfo.EmploymentStatusID) ? '' : caseInfo.EmploymentStatusID;
    const employmentStatusDescription = resolveId(lookup, caseInfo.EmploymentStatusID);
    const statusId = nullId(caseInfo.StatusID) ? '' : caseInfo.StatusID;
    const statusDescription = resolveId(lookup, caseInfo.StatusID);
    const categoryId = nullId(caseInfo.CategoryID) ? '' : caseInfo.CategoryID;
    const categoryDescription = resolveId(lookup, caseInfo.CategoryID);
    const requirementId = nullId(caseInfo.RequirementID) ? '' : caseInfo.RequirementID;
    const requirementDescription = resolveId(lookup, caseInfo.RequirementID);

    if (causeId) causesMap[causeId] = causeDescription;
    if (conditionId) conditionsMap[conditionId] = conditionDescription;
    if (employmentStatusId) employmentStatusesMap[employmentStatusId] = employmentStatusDescription;
    if (statusId) statusesMap[statusId] = statusDescription;
    if (categoryId) categoriesMap[categoryId] = categoryDescription;
    if (requirementId) requirementsMap[requirementId] = requirementDescription;

    const assignedUserId = nullId(caseInfo.AssignedToID) ? '' : caseInfo.AssignedToID;
    const assignedUser = employeeMap[assignedUserId];
    const assignedUserName = assignedUser ? `${assignedUser.firstName} ${assignedUser.lastName}`.trim() : '';
    const assignedUserEmail = assignedUser?.email ?? '';
    if (assignedUserId) usedEmployeeIds.add(assignedUserId);

    const clientAddress = buildAddress(lookup, {
      street: contactInfo.Street,
      suburb: contactInfo.Suburb,
      postalCode: contactInfo.PostalCode,
      regionId: contactInfo.RegionID,
      countryId: contactInfo.CountryID,
    });

    const clientBillingAddress = contactInfo.Address2UsePrimary === false
      ? buildAddress(lookup, {
        street: contactInfo.Street2,
        suburb: contactInfo.Suburb2,
        postalCode: contactInfo.PostalCode2,
        regionId: contactInfo.RegionID2,
        countryId: contactInfo.CountryID2,
      })
      : null;

    const referrer = {
      firstName: referrerInfo.FirstName ?? '',
      lastName: referrerInfo.LastName ?? '',
      email: referrerInfo.Email1 ?? '',
      phone: referrerInfo.Phone1 ?? '',
      fax: referrerInfo.Fax ?? '',
      position: resolveId(lookup, referrerInfo.PositionID),
    };

    cases.push({
      caseId,
      clientTitle: titlePart,
      clientFirstName: client.FirstName ?? '',
      clientLastName: client.LastName ?? '',
      clientEmail: client.Email ?? '',
      clientPhone: client.Phone ?? '',
      claimNumber: caseInfo.ClaimNo ?? '',
      referralDate: formatDate(caseInfo.DateOfReferral),
      dateClosed: formatDate(caseInfo.DateClosed),
      statusId,
      statusDescription,
      categoryId,
      categoryDescription,
      requirementId,
      requirementDescription,
      assignedUserId,
      assignedUserName,
      assignedUserEmail,
      clientAddress,
      clientBillingAddress,
      referrer,
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
  const statuses = Object.entries(statusesMap).map(([id, description]) => ({ id, description }));
  const categories = Object.entries(categoriesMap).map(([id, description]) => ({ id, description }));
  const requirements = Object.entries(requirementsMap).map(([id, description]) => ({ id, description }));
  const employees = Object.entries(employeeMap)
    .filter(([id]) => usedEmployeeIds.has(id))
    .map(([id, employee]) => ({ id, ...employee }));

  fs.writeFileSync(STRUCTURED_FILE, JSON.stringify({ cases, causes, conditions, employmentStatuses, statuses, categories, requirements, employees }, null, 2));
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

  console.error('Fetching employee list...');
  const employeeList = await getEmployeeList(context, token);
  console.error('Done fetching employees\n');

  let done = 0;
  for (const caseId of caseIds) {
    done++;
    const progress = `[${done}/${caseIds.length}]`;
    try {
      process.stderr.write(`${progress} Capturing case ${caseId}... `);
      const endpoints = await captureCase(context, token, caseId);
      cases[caseId] = { fetchedAt: new Date().toISOString(), endpoints };
      saveCases(cases, lookups, employeeList);
      console.error('done');
    } catch (err) {
      console.error(`FAILED: ${err.message}`);
      cases[caseId] = { fetchedAt: new Date().toISOString(), error: err.message };
      saveCases(cases, lookups, employeeList);
    }
  }

  console.error(`\nFinished. ${done}/${caseIds.length} cases processed.`);
  await browser.close();
})();
