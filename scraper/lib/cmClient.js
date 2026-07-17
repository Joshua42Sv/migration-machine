// Concurrent Case Manager API client. Owns the browser session and pushes
// every HTTP call through one global in-flight cap (CM_MAX_INFLIGHT) — that
// cap IS the rate limiter, replacing the old fixed sleeps. Transient failures
// (WAF 429s, 5xx, network blips) retry with exponential backoff while still
// holding their limiter slot, so errors naturally slow the whole run down;
// an expired session/anti-forgery token triggers one shared re-login that
// concurrent requests wait on, then they retry transparently.
//
// apiClient.js keeps the original sequential functions for the legacy
// scripts (getCase.js); `login` is reused from there.
const { chromium } = require('playwright');
const { login, LOOKUP_TYPES } = require('./apiClient');
const { createLimiter } = require('./pool');

const BASE_URL = 'https://workcom.casemanager.biz';
const MAX_ATTEMPTS = 5;
// CM queues requests server-side under load, so slow outliers are normal at
// full saturation; Playwright's default 30s failed real GetData calls.
const REQUEST_TIMEOUT_MS = 120000;
const JSON_CT = 'application/json; charset=UTF-8';
const FORM_CT = 'application/x-www-form-urlencoded; charset=UTF-8';

function isBrowserGone(err) {
  return /browser has been closed|Request context disposed/i.test(err.message ?? '');
}

class SessionExpiredError extends Error {
  constructor(label) {
    super(`${label}: session expired (login page returned)`);
    this.sessionExpired = true;
  }
}

function buildHeaders(token, contentType) {
  return {
    'Content-Type': contentType,
    'Accept': 'text/plain, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    [token.name]: token.value,
  };
}

// CM serves the login page (HTML, often as 200) when the session has died;
// anything HTML-shaped where JSON was expected means "log in again".
function jsonOrThrow(status, ok, text, label) {
  if (status === 401) throw new SessionExpiredError(label);
  if (/^\s*</.test(text)) throw new SessionExpiredError(label);
  if (!ok) {
    const err = new Error(`${label} ${status}: ${text.slice(0, 120)}`);
    err.status = status;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: unparseable response: ${text.slice(0, 120)}`);
  }
}

async function createClient({
  username,
  password,
  // Measured 2026-07-16: CM tops out around ~10 requests/sec server-side
  // regardless of concurrency — a 64 in-flight trial moved throughput not at
  // all, just pushed per-request latency into request timeouts. 24 keeps the
  // server saturated with headroom; raising this further buys nothing.
  maxInFlight = Number(process.env.CM_MAX_INFLIGHT ?? 24),
} = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  let token = null;
  let loginInFlight = null;

  // Single shared login: when many concurrent requests hit an expired session
  // at once, only one re-login runs and they all wait on it.
  const relogin = () => {
    loginInFlight ??= login(context, username, password)
      .then((t) => { token = t; })
      .finally(() => { loginInFlight = null; });
    return loginInFlight;
  };
  await relogin();

  const limiter = createLimiter(maxInFlight);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function request(label, fn) {
    return limiter(async () => {
      let lastErr;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          return await fn(token);
        } catch (err) {
          if (isBrowserGone(err)) throw err;
          lastErr = err;
          if (err.sessionExpired) {
            await relogin();
          } else {
            await sleep(Math.min(500 * 2 ** attempt, 15000) + Math.random() * 250);
          }
        }
      }
      const err = new Error(`${label} failed after ${MAX_ATTEMPTS} attempts: ${lastErr.message}`);
      err.status = lastErr.status; // callers distinguish CM HTTP errors from network/timeouts
      throw err;
    });
  }

  const postJson = (label, path, data) => request(label, async (t) => {
    const res = await context.request.post(`${BASE_URL}${path}`, {
      headers: buildHeaders(t, JSON_CT),
      data,
      timeout: REQUEST_TIMEOUT_MS,
    });
    return jsonOrThrow(res.status(), res.ok(), await res.text(), label);
  });

  const postForm = (label, path, form) => request(label, async (t) => {
    const res = await context.request.post(`${BASE_URL}${path}`, {
      headers: buildHeaders(t, FORM_CT),
      form,
      timeout: REQUEST_TIMEOUT_MS,
    });
    return jsonOrThrow(res.status(), res.ok(), await res.text(), label);
  });

  // Binary downloads: the login page comes back as 200 text/html with no
  // content-disposition; a real .html document download always has one.
  async function binaryOrThrow(res, label, fallbackName) {
    const status = res.status();
    if (!res.ok()) {
      const text = await res.text().catch(() => '');
      if (status === 401 || /LogOn/i.test(text)) throw new SessionExpiredError(label);
      const err = new Error(`${label} ${status}: ${text.slice(0, 120)}`);
      err.status = status;
      throw err;
    }
    const contentType = res.headers()['content-type'] || '';
    const disposition = res.headers()['content-disposition'] || '';
    if (!disposition && /text\/html/i.test(contentType)) {
      const text = await res.text().catch(() => '');
      if (/LogOn|antiForgery|sign in/i.test(text)) throw new SessionExpiredError(label);
    }
    const buffer = await res.body();
    const match = disposition.match(/filename="?([^";]+)"?/);
    return { buffer, filename: match ? match[1] : fallbackName, contentType };
  }

  const client = {
    getCaseData: (caseId) => postJson('/Case/GetData', '/Case/GetData', { ID: caseId }),

    getCaseContacts: (caseId) => postForm('/CaseContact/_List', '/CaseContact/_List', { caseNumber: caseId }),

    getCaseContactData: (caseId, contactId) => postJson('/CaseContact/GetData', '/CaseContact/GetData', {
      component: 'case', caseNumber: caseId, tabID: 'contacts', ID: contactId,
    }),

    getLookupList: (lookupType) => postForm('/Lookup/GetLookupList', '/Lookup/GetLookupList/', { lookupType }),

    getAllLookups: async () => {
      const lookups = {};
      await Promise.all(LOOKUP_TYPES.map(async (type) => {
        lookups[type] = await client.getLookupList(type);
      }));
      return lookups;
    },

    getEmployeeList: async () => {
      // Inactive employees included: historical documents/costs are often
      // created by staff who have since left, and attribution must resolve
      // to the real person (only employees actually referenced get imported)
      const body = await postForm('/EmployeeList/_List', '/EmployeeList/_List', { ShowInactive: true });
      return body.data ?? [];
    },

    getCaseEstimates: (caseId) => request('/CaseEstimate/_List', async (t) => {
      const res = await context.request.post(`${BASE_URL}/CaseEstimate/_List`, {
        headers: buildHeaders(t, FORM_CT),
        form: { caseNumber: caseId },
        timeout: REQUEST_TIMEOUT_MS,
      });
      const text = await res.text();
      // Responds 500 with a plain-text message when a case has no estimates
      if (text.includes('There are no estimates')) return [];
      const body = jsonOrThrow(res.status(), res.ok(), text, '/CaseEstimate/_List');
      return body.data ?? [];
    }),

    getCaseEstimateData: (caseId, estimateId) => postJson('/CaseEstimate/GetData', '/CaseEstimate/GetData', {
      component: 'case', caseNumber: caseId, tabID: 'estimates', ID: estimateId,
    }),

    getCaseCosts: (caseId) => request('/CaseCost/_List', async (t) => {
      const res = await context.request.post(`${BASE_URL}/CaseCost/_List`, {
        headers: buildHeaders(t, FORM_CT),
        form: { caseNumber: caseId },
        timeout: REQUEST_TIMEOUT_MS,
      });
      const text = await res.text();
      // Mirrors /CaseEstimate/_List, which 500s with a plain-text message when there is no data
      if (!res.ok() && /there are no/i.test(text)) return [];
      const body = jsonOrThrow(res.status(), res.ok(), text, '/CaseCost/_List');
      return body.data ?? [];
    }),

    getCaseCostData: (caseId, costId) => postJson('/CaseCost/GetData', '/CaseCost/GetData', {
      component: 'case', caseNumber: caseId, tabID: 'costs', ID: costId,
    }),

    getCaseDocuments: async (caseId) => {
      const body = await postForm('/CaseDocument/_List', '/CaseDocument/_List', { caseNumber: caseId });
      return body.data ?? [];
    },

    getCaseDocumentData: (caseId, documentId) => postJson('/CaseDocument/GetData', '/CaseDocument/GetData', {
      component: 'case', caseNumber: caseId, tabID: 'documents', ID: documentId,
    }),

    downloadDocumentFile: (documentId) => request('/CaseDocument/GetFile', async () => {
      const res = await context.request.get(`${BASE_URL}/CaseDocument/GetFile/${documentId}`, {
        timeout: REQUEST_TIMEOUT_MS,
      });
      return binaryOrThrow(res, '/CaseDocument/GetFile', documentId);
    }),

    // Attachments on in-app documents (emails/notes) need both IDs as query
    // params; the path-parameter form used by GetFile errors on this endpoint
    downloadDocumentAttachment: (documentId, attachmentId) => request('/CaseDocument/GetAttachment', async () => {
      const res = await context.request.get(`${BASE_URL}/CaseDocument/GetAttachment/`, {
        params: { documentID: documentId, attachmentID: attachmentId },
        timeout: REQUEST_TIMEOUT_MS,
      });
      return binaryOrThrow(res, '/CaseDocument/GetAttachment', attachmentId);
    }),

    // Full capture of one case. Detail fetches fire together but every HTTP
    // call goes through the global limiter, so it's bounded, not a burst.
    captureCase: async (caseId) => {
      const [caseData, contacts] = await Promise.all([
        client.getCaseData(caseId),
        client.getCaseContacts(caseId),
      ]);

      const endpoints = {
        '/Case/GetData': [caseData],
        '/CaseContact/_List': [contacts],
      };

      const contactRows = Array.isArray(contacts?.data) ? contacts.data : [];
      const hasRole = (row, role) => (row.RoleNames ?? '').split(',').map(r => r.trim()).includes(role);

      // Full detail (ContactInfo: phones, emails, address, DOB, ...) for every
      // contact; consumers pick records out by case contact ID
      const contactDetails = await Promise.all(
        contactRows.filter(r => r.ID).map(r => client.getCaseContactData(caseId, r.ID)),
      );
      endpoints['/CaseContact/GetData'] = contactDetails;

      const referrer = contactRows.find(c => hasRole(c, 'Referrer'));
      if (referrer) {
        const contactDetail = contactDetails.find(cd => cd.ID === referrer.ID);
        if (contactDetail) endpoints['referrerContact'] = [contactDetail];
      }

      const [estimateList, costList] = await Promise.all([
        client.getCaseEstimates(caseId),
        client.getCaseCosts(caseId),
      ]);
      endpoints['/CaseEstimate/_List'] = [estimateList];
      endpoints['/CaseCost/_List'] = [costList];

      const [estimateDetails, costDetails] = await Promise.all([
        Promise.all(estimateList.filter(e => e.ID).map(e => client.getCaseEstimateData(caseId, e.ID))),
        Promise.all(costList.filter(c => c.ID).map(c => client.getCaseCostData(caseId, c.ID))),
      ]);
      endpoints['/CaseEstimate/GetData'] = estimateDetails;
      endpoints['/CaseCost/GetData'] = costDetails;

      return endpoints;
    },

    close: () => browser.close(),
  };

  return client;
}

module.exports = { createClient, isBrowserGone };
