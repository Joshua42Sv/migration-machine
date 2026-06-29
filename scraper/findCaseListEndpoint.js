require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const USERNAME = process.env.CM_USER || '';
const PASSWORD = process.env.CM_PASS || '';

if (!USERNAME || !PASSWORD) {
  console.error('Set CM_USER and CM_PASS environment variables');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Intercept WebSocket frames to catch the SignalR data push
  page.on('websocket', ws => {
    console.error(`WebSocket opened: ${ws.url()}`);
    ws.on('framesent', f => {
      const data = f.payload?.toString() ?? '';
      if (data.length > 10 && data.length < 500) console.log(`[WS sent] ${data.slice(0, 200)}`);
    });
    ws.on('framereceived', f => {
      const data = f.payload?.toString() ?? '';
      // Only log frames that look like they contain case data (large frames or contain CaseNumber)
      if (data.includes('CaseNumber') || data.includes('caseNumber')) {
        console.log(`[WS recv - CASE DATA] length=${data.length} preview: ${data.slice(0, 300)}`);
      } else if (data.length > 50 && data.length < 1000) {
        console.log(`[WS recv] ${data.slice(0, 200)}`);
      }
    });
  });

  console.error('Logging in...');
  await page.goto('https://workcom.casemanager.biz/Account/LogOn?ReturnUrl=%2F');
  await page.getByRole('textbox', { name: 'Username or email' }).fill(USERNAME);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(url => !url.toString().includes('/LogOn'), { timeout: 15000 });
  console.error('Logged in\n');

  await page.goto('https://workcom.casemanager.biz/#!/home');
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Read data directly from the Kendo DataSource in memory
  console.error('\n--- Reading case data from Kendo DataSource ---');
  const result = await page.evaluate(() => {
    const grid = $('#casegrid').data('kendocmGrid') || $('#casegrid').data('kendoGrid');
    if (!grid) return { error: 'no grid widget found' };

    const ds = grid.dataSource;
    const total = ds.total();

    // data() returns currently loaded items
    const loaded = ds.data();
    const loadedArr = loaded.toJSON ? loaded.toJSON() : Array.from(loaded);

    // Get a sample of the first item to see field names
    const sample = loadedArr[0] ? Object.keys(loadedArr[0]) : [];

    // Try to get all case numbers from loaded data
    const caseNumbers = loadedArr.map(item =>
      item.CaseNumber ?? item.caseNumber ?? item.CaseID ?? item.caseId ?? item.ID ?? item.id
    ).filter(Boolean);

    return { total, loadedCount: loadedArr.length, sampleFields: sample, caseNumbers: caseNumbers.slice(0, 20), allCaseNumbers: caseNumbers };
  });

  console.log('Total in dataSource:', result.total);
  console.log('Items loaded in memory:', result.loadedCount);
  console.log('Field names on items:', result.sampleFields);
  console.log('First 20 case numbers:', result.caseNumbers);

  if (result.allCaseNumbers && result.allCaseNumbers.length > 0) {
    const outFile = path.join(__dirname, 'caseList.txt');
    fs.writeFileSync(outFile, result.allCaseNumbers.join('\n') + '\n');
    console.error(`\nWrote ${result.allCaseNumbers.length} case IDs to caseList.txt`);
  } else {
    console.error('\nNo case numbers found in loaded data — data may be server-paged. Checking view()...');
    const viewResult = await page.evaluate(() => {
      const grid = $('#casegrid').data('kendocmGrid') || $('#casegrid').data('kendoGrid');
      const view = grid?.dataSource?.view();
      const viewArr = view?.toJSON ? view.toJSON() : Array.from(view ?? []);
      return { viewCount: viewArr.length, sample: viewArr[0] };
    });
    console.log('view() count:', viewResult.viewCount);
    console.log('view() first item:', JSON.stringify(viewResult.sample, null, 2));
  }

  await browser.close();
})();
