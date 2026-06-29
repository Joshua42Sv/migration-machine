// Endpoints to ignore (analytics, assets, auth noise)
const IGNORE_PATTERNS = ['/Account/', '/Content/', '/Scripts/', '/fonts/', 'google', '_ga'];

function shouldCapture(url) {
  if (!url.includes('workcom.casemanager.biz')) return false;
  return !IGNORE_PATTERNS.some(p => url.includes(p));
}

async function clickTab(page, namePattern) {
  // Match tab by text content, ignoring leading/trailing whitespace
  const tab = page.getByRole('tab').filter({ hasText: namePattern });
  await tab.waitFor({ timeout: 5000 });
  await tab.click();
}

async function waitForNetworkIdle(page, timeout = 5000) {
  // Wait until no new requests for 800ms, up to timeout
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
}

async function captureCase(page, caseId) {
  const captured = {};

  const onResponse = async res => {
    const url = res.url();
    if (!shouldCapture(url)) return;
    if (!['POST', 'GET'].includes(res.request().method())) return;

    try {
      const urlPath = new URL(url).pathname;
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      if (!captured[urlPath]) captured[urlPath] = [];
      captured[urlPath].push(body);
    } catch { /* ignore */ }
  };

  page.on('response', onResponse);

  await page.goto(`https://workcom.casemanager.biz/#!/home/case/${caseId}/caseInfo`);

  await page.waitForResponse(
    res => res.url().includes('/Case/GetData') && res.request().method() === 'POST',
    { timeout: 20000 }
  );
  await waitForNetworkIdle(page);

  // Click Contacts tab, then click the first contact row to trigger _List POST
  try {
    await clickTab(page, 'Contacts');
    // Wait for at least one row to appear in the contacts table
    const firstRow = page.locator('table tbody tr').first();
    await firstRow.waitFor({ timeout: 10000 });
    await firstRow.click();
    // Wait for the _List response (contains all contacts for the case)
    await page.waitForResponse(
      res => res.url().includes('/CaseContact/_List') && res.request().method() === 'POST',
      { timeout: 10000 }
    );
    await waitForNetworkIdle(page, 5000);
  } catch {
    // No Contacts tab or no contacts for this case
  }

  page.off('response', onResponse);
  return captured;
}

module.exports = { captureCase };
