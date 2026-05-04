const express = require('express');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));
app.use('/output', express.static(path.join(__dirname, 'output')));

const CONFIG_PATH = path.resolve('config.json');
const COOKIES_PATH = path.resolve('cookies.json');

let currentBrowser = null;
let currentContext = null;
let currentPage = null;
let auditProcess = null;
let sseClients = [];

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  }
  return {
    url: '',
    authMode: 'cookies',
    cookies: [],
    clerkEmail: '',
    signInUrl: '',
    maxDepth: 3,
    maxStates: 200,
    viewport: { width: 1280, height: 800 }
  };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function loadCookies() {
  if (fs.existsSync(COOKIES_PATH)) {
    return JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
  }
  return [];
}

function saveCookies(cookies) {
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
}

function broadcast(event, data) {
  try {
    const safeData = {};
    for (const key in data) {
      safeData[key] = data[key] === undefined ? null : data[key];
    }
    const safe = JSON.stringify(safeData);
    if (safe === undefined) return;
    sseClients.forEach(client => {
      try {
        client.res.write(`event: ${event}\ndata: ${safe}\n\n`);
      } catch(e) {}
    });
  } catch(e) {}
}

async function runCrawl(config, isDryRun) {
  if (currentBrowser) {
    await currentBrowser.close();
    currentBrowser = null;
    currentContext = null;
    currentPage = null;
  }

  try {
    broadcast('status', { status: 'starting', message: 'Launching browser...' });

    currentBrowser = await chromium.launch({ headless: true });
    currentContext = await currentBrowser.newContext({
      viewport: config.viewport,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });

    currentPage = await currentContext.newPage();
    broadcast('status', { status: 'auth', message: 'Setting up authentication...' });

    if (config.authMode === 'clerk') {
      await handleClerkAuth(config);
    } else if (config.cookies && config.cookies.length > 0) {
      await currentContext.addCookies(config.cookies);
      broadcast('log', { message: '✅ Cookies injected' });
    }

    broadcast('status', { status: 'navigating', message: `Navigating to ${config.url}...` });
    await currentPage.goto(config.url, { waitUntil: 'networkidle', timeout: 60000 });

    const currentUrl = currentPage.url();
    if (currentUrl.includes('/sign-in') || currentUrl.includes('/login')) {
      broadcast('error', { message: '❌ Authentication failed - redirected to login' });
      broadcast('status', { status: 'failed', message: 'Authentication failed' });
      return;
    }

    broadcast('log', { message: `✅ Page loaded: ${currentUrl}` });

    if (isDryRun) {
      await runDryRun(config);
    } else {
      await runFullAudit(config);
    }

  } catch (error) {
    broadcast('error', { message: `❌ Error: ${error.message}` });
    broadcast('status', { status: 'failed', message: error.message });
  } finally {
    if (currentBrowser) {
      await currentBrowser.close();
      currentBrowser = null;
      currentContext = null;
      currentPage = null;
    }
  }
}

async function handleClerkAuth(config) {
  const savedCookies = loadCookies();

  if (savedCookies.length > 0) {
    await currentContext.addCookies(savedCookies);
    broadcast('log', { message: '✅ Using saved cookies' });

    await currentPage.goto(config.url, { waitUntil: 'networkidle', timeout: 30000 });
    const currentUrl = currentPage.url();

    if (!currentUrl.includes('/sign-in') && !currentUrl.includes('/login')) {
      broadcast('log', { message: '✅ Session valid from saved cookies' });
      return;
    }

    broadcast('log', { message: '⚠️ Saved cookies expired, re-authenticating...' });
  }

  broadcast('log', { message: '🔐 Starting Clerk authentication...' });

  const baseUrl = new URL(config.url).origin;
  const signInPaths = ['/sign-in', '/signin', '/login'];
  let signInUrl = null;

  for (const p of signInPaths) {
    try {
      const testUrl = baseUrl + p;
      await currentPage.goto(testUrl, { timeout: 5000, waitUntil: 'domcontentloaded' });
      await currentPage.waitForTimeout(1000);
      const hasClerk = await currentPage.evaluate(() => {
        return document.body.innerHTML.includes('clerk') ||
               document.querySelector('[data-clerk]') !== null ||
               document.querySelector('.clerk') !== null ||
               document.querySelector('[class*="clerk"]') !== null;
      });
      if (hasClerk) {
        signInUrl = testUrl;
        broadcast('log', { message: `✅ Found Clerk sign-in at ${signInUrl}` });
        break;
      }
    } catch {
      continue;
    }
  }

  if (!signInUrl) {
    signInUrl = baseUrl + '/sign-in';
    await currentPage.goto(signInUrl, { waitUntil: 'networkidle', timeout: 30000 });
    broadcast('log', { message: `Navigated to ${signInUrl}` });
  }

  await currentPage.waitForTimeout(1500);

  const emailInputSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[id="email"]',
    'input[autocomplete="email"]',
    'input[placeholder*="email" i]'
  ];

  let emailInput = null;
  for (const sel of emailInputSelectors) {
    try {
      const input = currentPage.locator(sel).first();
      if (await input.isVisible({ timeout: 2000 })) {
        emailInput = input;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!emailInput) {
    broadcast('log', { message: 'No email input visible, checking for "Continue with email" link...' });

    const emailLinkSelectors = [
      'text=Continue with email',
      'text=Use email',
      'text=Sign in with email',
      'a:has-text("Continue with email")',
      'a:has-text("Use email")',
      '[class*="email"]'
    ];

    for (const sel of emailLinkSelectors) {
      try {
        const link = currentPage.locator(sel).first();
        if (await link.isVisible({ timeout: 2000 })) {
          await link.click();
          broadcast('log', { message: 'Clicked "Continue with email" link' });
          await currentPage.waitForTimeout(1500);
          break;
        }
      } catch {
        continue;
      }
    }

    for (const sel of emailInputSelectors) {
      try {
        const input = currentPage.locator(sel).first();
        if (await input.isVisible({ timeout: 2000 })) {
          emailInput = input;
          break;
        }
      } catch {
        continue;
      }
    }
  }

  if (!emailInput) {
    throw new Error('Could not find Clerk email input');
  }

  broadcast('log', { message: `📧 Entering email: ${config.clerkEmail}` });
  await emailInput.fill(config.clerkEmail);
  await currentPage.waitForTimeout(500);

  const continueButtonSelectors = [
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Continue with email")',
    'button:has-text("Sign in")',
    'button:has-text("Continue to sign in")'
  ];

  let continueButton = null;
  for (const sel of continueButtonSelectors) {
    try {
      const btn = currentPage.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        continueButton = btn;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!continueButton) {
    throw new Error('Could not find continue/submit button');
  }

  broadcast('log', { message: 'Clicking continue button...' });
  await continueButton.click();

  broadcast('log', { message: 'Waiting for Clerk to send OTP email...' });
  await currentPage.waitForTimeout(3000);

  broadcast('status', { status: 'clerk-otp', message: 'Enter OTP code from your email' });
  broadcast('clerk-prompt', { email: config.clerkEmail });
}

async function submitClerkOtp(otp) {
  try {
    const otpInput = await currentPage.locator('input[name="code"], input[placeholder*="code"], input[class*="otp"]').first();
    await otpInput.fill(otp);

    const submitButton = await currentPage.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Sign in")').first();
    await submitButton.click();

    await currentPage.waitForTimeout(3000);

    const currentUrl = currentPage.url();
    if (currentUrl.includes('/sign-in') || currentUrl.includes('/login')) {
      broadcast('error', { message: '❌ OTP verification failed' });
      return false;
    }

    const cookies = await currentContext.cookies();
    saveCookies(cookies);
    broadcast('log', { message: '✅ Clerk authentication successful, cookies saved' });

    const config = loadConfig();
    config.authMode = 'cookies';
    saveConfig(config);

    return true;
  } catch (error) {
    broadcast('error', { message: `❌ OTP error: ${error.message}` });
    return false;
  }
}

async function runDryRun(config) {
  broadcast('log', { message: '🔍 DRY RUN MODE' });

  const clickables = await currentPage.evaluate(() => {
    const clickables = [];

    document.querySelectorAll('button, input[type="button"], input[type="submit"]').forEach(el => {
      if (el.offsetParent !== null && !el.disabled) {
        clickables.push({ type: 'button', text: el.innerText?.trim().substring(0, 30) });
      }
    });

    document.querySelectorAll('a[href]').forEach(el => {
      if (el.offsetParent !== null && el.href) {
        clickables.push({ type: 'link', text: el.innerText?.trim().substring(0, 30) });
      }
    });

    document.querySelectorAll('[role="button"]').forEach(el => {
      if (el.offsetParent !== null) {
        clickables.push({ type: 'role-button', text: el.innerText?.trim().substring(0, 30) });
      }
    });

    return clickables;
  });

  const buttons = clickables.filter(c => c.type === 'button').length;
  const links = clickables.filter(c => c.type === 'link').length;
  const roleButtons = clickables.filter(c => c.type === 'role-button').length;
  const maxPossible = clickables.length * config.maxDepth;

  broadcast('log', { message: `📊 Clickable elements: ${clickables.length} (Buttons: ${buttons}, Links: ${links}, Role: ${roleButtons})` });
  broadcast('log', { message: `⚠️ Max pages: ~${maxPossible} (capped at ${config.maxStates})` });
  broadcast('log', { message: '✅ Dry run complete - config valid!' });
  broadcast('status', { status: 'complete', message: 'Dry run finished' });
}

async function runFullAudit(config) {
  broadcast('status', { status: 'crawling', message: 'Starting crawl...' });

  broadcast('log', { message: `📋 Config received - url: ${config.url}, seedUrls: ${config.seedUrls?.length || 0}` });

  const visited = new Set();
  let pageCount = 0;
  const results = { pages: [] };

  const pages = [{ url: config.url, depth: 0 }];
  let sessionExpired = false;

  if (config.seedUrls && config.seedUrls.length > 0) {
    broadcast('log', { message: `📥 Adding ${config.seedUrls.length} seed URLs to queue` });
    config.seedUrls.forEach(url => {
      pages.push({ url: url.trim(), depth: 0 });
    });
  }

  broadcast('log', { message: `📋 Initial queue size: ${pages.length} URLs` });

  while (pages.length > 0 && pageCount < config.maxStates) {
    const current = pages.shift();
    const { url, depth } = current;

    if (depth > config.maxDepth || visited.size >= config.maxStates) continue;

    const currentPageUrl = currentPage.url();
    if (currentPageUrl.includes('/sign-in') || currentPageUrl.includes('/login')) {
      broadcast('error', { message: '❌ Session expired - redirected to login' });
      sessionExpired = true;
      break;
    }

    await currentPage.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    const consoleErrors = [];
    const pageErrors = [];
    const networkErrors = [];
    const consoleWarnings = [];

    currentPage.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
      if (msg.type() === 'warning') consoleWarnings.push(msg.text());
    });

    currentPage.on('pageerror', err => {
      pageErrors.push(err.message);
    });

    currentPage.on('requestfailed', request => {
      pageErrors.push(`Request failed: ${request.url()} - ${request.failure()?.errorText || 'Unknown'}`);
    });

    currentPage.on('response', response => {
      if (response.status() >= 400) {
        networkErrors.push({ url: response.url(), status: response.status() });
      }
    });

    await currentPage.evaluate(() => {
      window.__auditErrors = window.__auditErrors || [];
      const originalError = console.error;
      console.error = (...args) => {
        window.__auditErrors.push(args.join(' '));
        originalError.apply(console, args);
      };
    });

    await currentPage.waitForTimeout(3000);

    const reactErrors = await currentPage.evaluate(() => window.__auditErrors || []);
    reactErrors.forEach(err => {
      if (err.includes('Hydration') || err.includes('hydration') || err.includes('Error:') || err.includes('warning')) {
        consoleWarnings.push(err);
      }
    });

    const domState = await extractDomState();

    const screenshotName = `page_${pageCount}_${Date.now()}`;
    const screenshotPath = path.join(__dirname, 'output/screenshots', `${screenshotName}.png`);

    const ssDir = path.join(__dirname, 'output/screenshots');
    if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });

    await currentPage.screenshot({ path: screenshotPath, fullPage: true });

    let status = 'success';
    if (pageErrors.length > 0 || networkErrors.some(n => n.status >= 500)) {
      status = 'error';
    } else if (consoleErrors.length > 0 || consoleWarnings.length > 0 || networkErrors.length > 0) {
      status = 'warning';
    }

    results.pages.push({
      url,
      status,
      screenshot: `screenshots/${screenshotName}.png`,
      consoleErrors,
      consoleWarnings,
      pageErrors,
      networkErrors,
      timestamp: new Date().toISOString()
    });

    pageCount++;
    broadcast('progress', { current: pageCount, max: config.maxStates, url });
    broadcast('log', { message: `[${depth}] ${status === 'error' ? '🔴' : status === 'warning' ? '🟡' : '🟢'} ${url} (${consoleErrors.length + consoleWarnings.length + pageErrors.length + networkErrors.length} issues)` });

    if (depth < config.maxDepth && pageCount < config.maxStates) {
      const clickables = await currentPage.evaluate(() => {
        const list = [];
        document.querySelectorAll('button, a[href], [role="button"]').forEach(el => {
          if (el.offsetParent !== null && el.href && !el.href.startsWith('javascript:')) {
            list.push(el.href);
          }
        });
        return [...new Set(list)].slice(0, 20);
      });

      clickables.forEach(href => {
        if (!visited.has(href) && href.startsWith(config.url)) {
          pages.push({ url: href, depth: depth + 1 });
        }
      });
    }
  }

  broadcast('log', { message: 'DEBUG: After while loop' });
  broadcast('log', { message: `✅ Crawl complete: ${pageCount} pages` });

  if (sessionExpired) {
    broadcast('log', { message: '⚠️ Crawl stopped: Session expired' });
  }

  const summary = {
    totalPages: results.pages.length,
    totalErrors: results.pages.filter(p => p.status === 'error').length,
    totalWarnings: results.pages.filter(p => p.status === 'warning').length,
    completedAt: new Date().toISOString()
  };

  broadcast('log', { message: 'DEBUG: About to generate report' });

  try {
    console.log('Generating report...');
    generateReport(results, config, summary);
    console.log('Report written to output/audit-report.html');
  } catch (err) {
    broadcast('error', { message: `❌ Report generation failed: ${err.message}` });
  }
  broadcast('status', { status: 'complete', message: 'Audit complete', summary });
}

function extractDomState() {
  return currentPage.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetParent !== null;
    };
    const selects = Array.from(document.querySelectorAll('select')).filter(isVisible);
    const dropdowns = Array.from(document.querySelectorAll('[class*="dropdown"]')).filter(el => {
      if (el.style.display === 'none') return false;
      return isVisible(el);
    });
    return {
      modals: Array.from(document.querySelectorAll('[class*="modal"]')).filter(el => {
        if (el.style.display === 'none') return false;
        return isVisible(el);
      }).length,
      dropdowns: selects.length + dropdowns.length
    };
  });
}

function hashState(url, domState) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(`${url}|||${JSON.stringify(domState)}`).digest('hex');
}

function generateReport(results, config, summary) {
  try {
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const errors = results.pages.filter(p => p.status === 'error');
    const warnings = results.pages.filter(p => p.status === 'warning');
    const safeUrl = String(config.url || '');
    const safeTotalPages = String(summary.totalPages || 0);
    const safeTotalErrors = String(summary.totalErrors || 0);
    const safeTotalWarnings = String(summary.totalWarnings || 0);

    // Build pages data as JSON string for the browser
    const pagesJson = JSON.stringify(results.pages.map(p => {
      let pathname = '/';
      try { pathname = new URL(p.url).pathname || '/' } catch(e) {}
      return { url: p.url, pathname, status: p.status, screenshot: p.screenshot };
    }));

    // Build the entire HTML as a single template literal
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Web Audit Report - ${safeUrl}</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; padding: 20px; }
    .container { max-width: 1400px; margin: 0 auto; }
    .banner { background: linear-gradient(135deg, #1e3a5f, #2d5a87); color: white; padding: 30px; border-radius: 12px; margin-bottom: 30px; }
    .banner h1 { font-size: 28px; margin-bottom: 10px; }
    .stats { display: flex; gap: 30px; margin-top: 20px; }
    .stat { background: rgba(255,255,255,0.15); padding: 15px 25px; border-radius: 8px; }
    .stat-value { font-size: 32px; font-weight: bold; }
    .stat-label { font-size: 14px; opacity: 0.8; }
    .section { background: white; border-radius: 12px; padding: 25px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .section h2 { font-size: 20px; margin-bottom: 20px; }
    .page-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
    .page-card { background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .page-screenshot { width: 100%; height: 180px; object-fit: cover; background: #e5e5e5; cursor: pointer; }
    .page-content { padding: 15px; }
    .page-url { font-size: 14px; color: #666; word-break: break-all; }
    .status-chip { padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; display: inline-block; margin-top: 10px; }
    .status-success { background: #dcfce7; color: #166534; }
    .status-warning { background: #fef3c7; color: #92400e; }
    .status-error { background: #fee2e2; color: #991b1b; }
    .download-btn { background: #3b82f6; color: white; border: none; padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; margin-left: auto; }
    .download-btn:hover { background: #2563eb; }
    .download-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.9); z-index: 1000; align-items: center; justify-content: center; flex-direction: column; }
    .lightbox.active { display: flex; }
    .lightbox-content { max-width: 90%; max-height: 80vh; position: relative; }
    .lightbox-img { max-width: 100%; max-height: 80vh; object-fit: contain; border-radius: 8px; }
    .lightbox-info { color: white; text-align: center; margin-top: 20px; }
    .lightbox-url { font-size: 18px; margin-bottom: 10px; word-break: break-all; }
    .lightbox-status { display: inline-block; padding: 6px 16px; border-radius: 20px; font-size: 14px; font-weight: 600; }
    .lightbox-close { position: absolute; top: 20px; right: 30px; color: white; font-size: 40px; cursor: pointer; background: none; border: none; }
    .lightbox-nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255,255,255,0.2); color: white; border: none; font-size: 30px; padding: 20px; cursor: pointer; border-radius: 8px; }
    .lightbox-nav:hover { background: rgba(255,255,255,0.3); }
  </style>
</head>
<body>
  <div class="container">
    <div class="banner">
      <h1>Web Audit Report</h1>
      <p>${safeUrl}</p>
      <div class="stats">
        <div class="stat"><div class="stat-value">${safeTotalPages}</div><div class="stat-label">Total Pages</div></div>
        <div class="stat" style="background: rgba(220,38,38,0.3);"><div class="stat-value">${safeTotalErrors}</div><div class="stat-label">Errors</div></div>
        <div class="stat" style="background: rgba(245,158,11,0.3);"><div class="stat-value">${safeTotalWarnings}</div><div class="stat-label">Warnings</div></div>
        <button id="downloadBtn" class="download-btn" onclick="downloadAllScreenshots()">Download All Screenshots</button>
      </div>
    </div>
${errors.length > 0 ? `<div class="section"><h2>Errors (${errors.length})</h2>` + errors.map(p => {
  let pathname = '/';
  try { pathname = new URL(p.url).pathname } catch(e) {}
  return `<div class="page-card"><div class="page-content"><strong>${pathname}</strong><br><code>${p.url}</code></div></div>`;
}).join('') + '</div>' : ''}
${warnings.length > 0 ? `<div class="section"><h2>Warnings (${warnings.length})</h2>` + warnings.map(p => {
  let pathname = '/';
  try { pathname = new URL(p.url).pathname } catch(e) {}
  return `<div class="page-card"><div class="page-content"><strong>${pathname}</strong></div></div>`;
}).join('') + '</div>' : ''}
    <div class="section"><h2>All Pages (${results.pages.length})</h2><div class="page-grid">
${results.pages.map((p, idx) => {
  let pathname = '/';
  try { pathname = new URL(p.url).pathname } catch(e) {}
  const statusClass = p.status === 'error' ? 'status-error' : p.status === 'warning' ? 'status-warning' : 'status-success';
  const statusLabel = p.status === 'error' ? 'Error' : p.status === 'warning' ? 'Warning' : 'Success';
  const issueCount = (p.consoleErrors || []).length + (p.consoleWarnings || []).length + (p.pageErrors || []).length + (p.networkErrors || []).length;
  return `<div class="page-card">
    <img class="page-screenshot" src="${p.screenshot || ''}" alt="${pathname}" onclick="openLightbox(${idx})" onerror="this.style.display='none'">
    <div class="page-content">
      <div class="page-url">${pathname}</div>
      <span class="status-chip ${statusClass}">${statusLabel}</span>
      <span style="font-size:12px;color:#999;margin-left:10px;">${issueCount} issues</span>
    </div>
  </div>`;
}).join('')}
    </div></div>
  </div>
</body>
<div class="lightbox" id="lightbox" onclick="if(event.target.id==='lightbox')closeLightbox()">
  <button class="lightbox-close" onclick="closeLightbox()">&times;</button>
  <button class="lightbox-nav" style="left:20px;" onclick="navigateLightbox(-1)">&#10094;</button>
  <div class="lightbox-content">
    <img class="lightbox-img" id="lightbox-img" src="" alt="">
  </div>
  <button class="lightbox-nav" style="right:20px;" onclick="navigateLightbox(1)">&#10095;</button>
  <div class="lightbox-info">
    <div class="lightbox-url" id="lightbox-url"></div>
    <span class="lightbox-status" id="lightbox-status"></span>
  </div>
</div>
<script>
var pages = ${pagesJson};
var currentIdx = 0;

function openLightbox(idx) {
  currentIdx = idx;
  updateLightbox();
  document.getElementById('lightbox').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('active');
  document.body.style.overflow = '';
}

function navigateLightbox(dir) {
  currentIdx = (currentIdx + dir + pages.length) % pages.length;
  updateLightbox();
}

function updateLightbox() {
  var p = pages[currentIdx];
  var statusClass = p.status === 'error' ? 'status-error' : p.status === 'warning' ? 'status-warning' : 'status-success';
  var statusLabel = p.status === 'error' ? 'Error' : p.status === 'warning' ? 'Warning' : 'Success';
  document.getElementById('lightbox-img').src = p.screenshot || '';
  document.getElementById('lightbox-url').textContent = p.pathname;
  var statusEl = document.getElementById('lightbox-status');
  statusEl.textContent = statusLabel;
  statusEl.className = 'lightbox-status ' + statusClass;
}

document.addEventListener('keydown', function(e) {
  if (!document.getElementById('lightbox').classList.contains('active')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') navigateLightbox(-1);
  if (e.key === 'ArrowRight') navigateLightbox(1);
});

async function downloadAllScreenshots() {
  var btn = document.getElementById('downloadBtn');
  btn.disabled = true;
  btn.textContent = 'Zipping...';
  try {
    var zip = new JSZip();
    for (var i = 0; i < pages.length; i++) {
      var p = pages[i];
      if (!p.screenshot) continue;
      var fileName = p.pathname === '/' ? 'home' : p.pathname.replace(/^\//, '').replace(/\//g, '-');
      var ext = p.screenshot.split('.').pop() || 'png';
      fileName = fileName + '.' + ext;
      try {
        var resp = await fetch(p.screenshot);
        var blob = await resp.blob();
        zip.file(fileName, blob);
      } catch(e) { console.warn('Failed to fetch', p.screenshot, e); }
    }
    var content = await zip.generateAsync({type: 'blob'});
    var url = URL.createObjectURL(content);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'audit-screenshots.zip';
    a.click();
    URL.revokeObjectURL(url);
  } catch(e) { alert('Failed to create ZIP: ' + e.message); }
  btn.disabled = false;
  btn.textContent = 'Download All Screenshots';
}
</script>
`;

    const outputPath = path.join(__dirname, 'output', 'audit-report.html');
    fs.writeFileSync(outputPath, html, 'utf8');

    const jsonPath = path.join(__dirname, 'output', 'audit-data.json');
    const jsonReport = { config, summary, pages: results.pages };
    fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf8');

    try {
      broadcast('report-ready', { htmlPath: 'output/audit-report.html', jsonPath: 'output/audit-data.json' });
    } catch(e) {}
  } catch (err) {
    try {
      broadcast('error', { message: 'Report generation failed: ' + err.message });
    } catch(e) {}
  }
}

app.get('/api/config', (req, res) => {
  res.json(loadConfig());
});

app.post('/api/config', (req, res) => {
  saveConfig(req.body);
  res.json({ success: true });
});

app.get('/api/cookies', (req, res) => {
  res.json(loadCookies());
});

app.post('/api/audit/start', async (req, res) => {
  const config = req.body;
  saveConfig(config);

  runCrawl(config, false);
  res.json({ success: true });
});

app.post('/api/audit/dry-run', async (req, res) => {
  const config = req.body;
  saveConfig(config);

  runCrawl(config, true);
  res.json({ success: true });
});

app.post('/api/audit/stop', async (req, res) => {
  if (currentBrowser) {
    await currentBrowser.close();
    currentBrowser = null;
    currentContext = null;
    currentPage = null;
    broadcast('status', { status: 'stopped', message: 'Audit stopped by user' });
  }
  res.json({ success: true });
});

app.post('/api/clerk/submit-otp', async (req, res) => {
  const { otp } = req.body;
  const success = await submitClerkOtp(otp);
  res.json({ success });
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  sseClients.push({ req, res });

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.res !== res);
  });
});

app.get('/output/*', (req, res) => {
  const filePath = path.join(__dirname, req.params[0]);
  res.sendFile(filePath);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  const address = server.address();
  console.log(`\n🕷️  Web Audit Agent UI\n=====================\n`);
  console.log(`   Server running at http://localhost:${PORT}`);
  console.log(`   Or http://127.0.0.1:${PORT}`);
  console.log(`   Press Ctrl+C to stop\n`);
});

