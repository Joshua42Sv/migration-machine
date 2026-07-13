const BASE_URL = 'https://workcom.casemanager.biz';

const LOOKUP_TYPES = [
  'Category', 'Status', 'EmpStatus', 'Condition', 'CaseFlag', 'Cause',
  'Requirement', 'ReferralType', 'Outcome', 'Team', 'Office', 'InvoiceGroup',
  'Region', 'Country', 'Position',
];

async function login(context, username, password) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/Account/LogOn?ReturnUrl=%2F`);
  await page.getByRole('textbox', { name: 'Username or email' }).fill(username);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(url => !url.toString().includes('/LogOn'), { timeout: 15000 });
  const token = await page.evaluate(() => ({ name: antiForgeryTokenName, value: antiForgeryTokenValue }));
  await page.close();
  return token;
}

function buildHeaders(token, contentType) {
  return {
    'Content-Type': contentType,
    'Accept': 'text/plain, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    [token.name]: token.value,
  };
}

async function getCaseData(context, token, caseId) {
  const res = await context.request.post(`${BASE_URL}/Case/GetData`, {
    headers: buildHeaders(token, 'application/json; charset=UTF-8'),
    data: { ID: caseId },
  });
  return res.json();
}

async function getCaseContacts(context, token, caseId) {
  const res = await context.request.post(`${BASE_URL}/CaseContact/_List`, {
    headers: buildHeaders(token, 'application/x-www-form-urlencoded; charset=UTF-8'),
    form: { caseNumber: caseId },
  });
  return res.json();
}

async function getCaseContactData(context, token, caseId, contactId) {
  const res = await context.request.post(`${BASE_URL}/CaseContact/GetData`, {
    headers: buildHeaders(token, 'application/json; charset=UTF-8'),
    data: { component: 'case', caseNumber: caseId, tabID: 'contacts', ID: contactId },
  });
  return res.json();
}

async function getLookupList(context, token, lookupType) {
  const res = await context.request.post(`${BASE_URL}/Lookup/GetLookupList/`, {
    headers: buildHeaders(token, 'application/x-www-form-urlencoded; charset=UTF-8'),
    form: { lookupType },
  });
  return res.json();
}

async function getEmployeeList(context, token) {
  const res = await context.request.post(`${BASE_URL}/EmployeeList/_List`, {
    headers: buildHeaders(token, 'application/x-www-form-urlencoded; charset=UTF-8'),
    form: { ShowInactive: false },
  });
  const body = await res.json();
  return body.data ?? [];
}

async function getCaseEstimates(context, token, caseId) {
  const res = await context.request.post(`${BASE_URL}/CaseEstimate/_List`, {
    headers: buildHeaders(token, 'application/x-www-form-urlencoded; charset=UTF-8'),
    form: { caseNumber: caseId },
  });
  const text = await res.text();
  // Responds 500 with a plain-text message when a case has no estimates
  if (text.includes('There are no estimates')) return [];
  if (!res.ok()) throw new Error(`/CaseEstimate/_List ${res.status()}: ${text.slice(0, 100)}`);
  const body = JSON.parse(text);
  return body.data ?? [];
}

async function getCaseEstimateData(context, token, caseId, estimateId) {
  const res = await context.request.post(`${BASE_URL}/CaseEstimate/GetData`, {
    headers: buildHeaders(token, 'application/json; charset=UTF-8'),
    data: { component: 'case', caseNumber: caseId, tabID: 'estimates', ID: estimateId },
  });
  return res.json();
}

async function getAllLookups(context, token) {
  const lookups = {};
  for (const type of LOOKUP_TYPES) {
    lookups[type] = await getLookupList(context, token, type);
  }
  return lookups;
}

async function captureCase(context, token, caseId) {
  const [caseData, contacts] = await Promise.all([
    getCaseData(context, token, caseId),
    getCaseContacts(context, token, caseId),
  ]);

  const endpoints = {
    '/Case/GetData': [caseData],
    '/CaseContact/_List': [contacts],
  };

  const contactRows = Array.isArray(contacts?.data) ? contacts.data : [];
  const hasRole = (row, role) => (row.RoleNames ?? '').split(',').map(r => r.trim()).includes(role);

  const client = contactRows.find(c => c.PrimaryRoleName === 'Client');
  if (client) {
    const contactDetail = await getCaseContactData(context, token, caseId, client.ID);
    endpoints['/CaseContact/GetData'] = [contactDetail];
  }

  const referrer = contactRows.find(c => hasRole(c, 'Referrer'));
  if (referrer) {
    const contactDetail = await getCaseContactData(context, token, caseId, referrer.ID);
    endpoints['referrerContact'] = [contactDetail];
  }

  const estimateList = await getCaseEstimates(context, token, caseId);
  endpoints['/CaseEstimate/_List'] = [estimateList];
  const estimateDetails = [];
  for (const estimate of estimateList) {
    if (!estimate.ID) continue;
    estimateDetails.push(await getCaseEstimateData(context, token, caseId, estimate.ID));
  }
  endpoints['/CaseEstimate/GetData'] = estimateDetails;

  return endpoints;
}

async function getCaseDocuments(context, token, caseId) {
  const res = await context.request.post(`${BASE_URL}/CaseDocument/_List`, {
    headers: buildHeaders(token, 'application/x-www-form-urlencoded; charset=UTF-8'),
    form: { caseNumber: caseId },
  });
  const body = await res.json();
  return body.data ?? [];
}

async function getCaseDocumentData(context, token, caseId, documentId) {
  const res = await context.request.post(`${BASE_URL}/CaseDocument/GetData`, {
    headers: buildHeaders(token, 'application/json; charset=UTF-8'),
    data: { component: 'case', caseNumber: caseId, tabID: 'documents', ID: documentId },
  });
  return res.json();
}

async function downloadDocumentFile(context, documentId) {
  const res = await context.request.get(`${BASE_URL}/CaseDocument/GetFile/${documentId}`);
  const buffer = await res.body();
  const disposition = res.headers()['content-disposition'] || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : documentId;
  return { buffer, filename, contentType: res.headers()['content-type'] };
}

module.exports = {
  login, getCaseData, getCaseContacts, getCaseContactData, getLookupList, getAllLookups,
  getEmployeeList, captureCase,
  getCaseEstimates, getCaseEstimateData,
  getCaseDocuments, downloadDocumentFile, getCaseDocumentData, LOOKUP_TYPES,
};
