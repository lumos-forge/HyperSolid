// Render an HTML file's .stage element to PNG using puppeteer-core + the cached
// Chromium (no browser download). Usage: node render-core.js in.html out.png
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

function findChrome() {
  const base = path.join(require('os').homedir(), '.cache/puppeteer/chrome');
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if (fs.existsSync(p)) return p;
    }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

(async () => {
  const inFile = process.argv[2] || 'redesign.html';
  const outFile = process.argv[3] || 'redesign.png';
  const browser = await puppeteer.launch({ headless: 'new', executablePath: findChrome(), args: ['--no-sandbox', '--font-render-hinting=none'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1320, height: 1000, deviceScaleFactor: 2 });
  await page.goto('file://' + path.join(__dirname, inFile), { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 700));
  const el = await page.$('.stage');
  await el.screenshot({ path: path.join(__dirname, outFile) });
  await browser.close();
  console.log('wrote ' + outFile);
})();
