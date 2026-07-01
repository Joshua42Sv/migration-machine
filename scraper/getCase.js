require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { login, captureCase } = require('./lib/apiClient');

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
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  console.error('Logging in...');
  const token = await login(context, USERNAME, PASSWORD);
  console.error('Logged in');

  console.error(`Capturing case ${CASE_ID}...`);
  const endpoints = await captureCase(context, token, CASE_ID);

  const cases = loadCases();
  cases[CASE_ID] = { fetchedAt: new Date().toISOString(), endpoints };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(cases, null, 2));

  console.error(`Done. Captured: ${Object.keys(endpoints).join(', ')}`);
  await browser.close();
})();
