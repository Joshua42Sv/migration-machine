require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { captureCase } = require('./lib/captureCase');

const USERNAME = process.env.CM_USER || '';
const PASSWORD = process.env.CM_PASS || '';
const CASE_ID = process.argv[2] || '13098';
const OUTPUT_FILE = path.join(__dirname, 'cases.json');

if (!USERNAME || !PASSWORD) {
  console.error('Set CM_USER and CM_PASS environment variables');
  process.exit(1);
}

function loadCases() {
  if (!fs.existsSync(OUTPUT_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')); } catch { return {}; }
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.error('Logging in...');
  await page.goto('https://workcom.casemanager.biz/Account/LogOn?ReturnUrl=%2F');
  await page.getByRole('textbox', { name: 'Username or email' }).fill(USERNAME);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(url => !url.toString().includes('/LogOn'), { timeout: 15000 });
  console.error('Logged in');

  console.error(`Capturing case ${CASE_ID}...`);
  const endpoints = await captureCase(page, CASE_ID);

  const cases = loadCases();
  cases[CASE_ID] = { fetchedAt: new Date().toISOString(), endpoints };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(cases, null, 2));

  console.error(`Done. Captured: ${Object.keys(endpoints).join(', ')}`);
  await browser.close();
})();
