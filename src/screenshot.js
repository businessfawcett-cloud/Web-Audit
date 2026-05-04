const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUTPUT_DIR = path.resolve('output/screenshots');

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function sanitizeFilename(url) {
  try {
    const urlObj = new URL(url);
    let filename = urlObj.pathname.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 100);
    if (!filename || filename === '_') {
      filename = 'index';
    }
    return filename + '_' + Date.now();
  } catch {
    return 'page_' + Date.now();
  }
}

async function captureScreenshot(page, consoleMonitor, networkMonitor) {
  ensureOutputDir();

  const url = page.url();
  const filename = sanitizeFilename(url);
  const tempPath = path.join(OUTPUT_DIR, `${filename}_temp.png`);
  const finalPath = path.join(OUTPUT_DIR, `${filename}.png`);

  await page.screenshot({
    path: tempPath,
    fullPage: true
  });

  const errorCount = consoleMonitor.getErrors().length + networkMonitor.getFailedRequests().length;

  if (errorCount > 0) {
    await addErrorOverlay(tempPath, finalPath, errorCount, consoleMonitor.getErrors().length, networkMonitor.getFailedRequests().length);
    fs.unlinkSync(tempPath);
  } else {
    fs.renameSync(tempPath, finalPath);
  }

  return {
    path: finalPath,
    relativePath: `screenshots/${path.basename(finalPath)}`,
    errorCount
  };
}

async function addErrorOverlay(inputPath, outputPath, totalErrors, consoleErrors, networkErrors) {
  const metadata = await sharp(inputPath).metadata();
  const width = metadata.width;
  const bannerHeight = 40;

  const text = `⚠️ ${totalErrors} ISSUES: ${consoleErrors} console errors, ${networkErrors} failed requests`;

  const svgOverlay = `
    <svg width="${width}" height="${bannerHeight}">
      <rect width="100%" height="100%" fill="#dc2626"/>
      <text x="20" y="26" font-family="Arial, sans-serif" font-size="16" fill="white" font-weight="bold">${text}</text>
    </svg>
  `;

  await sharp(inputPath)
    .extend({
      top: bannerHeight,
      background: '#dc2626'
    })
    .composite([{
      input: Buffer.from(svgOverlay),
      top: 0,
      left: 0
    }])
    .toFile(outputPath);
}

async function captureDryRunScreenshot(page) {
  ensureOutputDir();

  const filename = 'dryrun_' + Date.now();
  const filepath = path.join(OUTPUT_DIR, `${filename}.png`);

  await page.screenshot({
    path: filepath,
    fullPage: true
  });

  return filepath;
}

module.exports = {
  captureScreenshot,
  captureDryRunScreenshot,
  ensureOutputDir
};