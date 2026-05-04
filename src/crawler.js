const crypto = require('crypto');
const { ConsoleMonitor, NetworkMonitor } = require('./monitor');
const { captureScreenshot } = require('./screenshot');
const { verifyAuth } = require('./auth');

function hashState(url, domState) {
  const hashInput = `${url}|||${JSON.stringify(domState)}`;
  return crypto.createHash('sha256').update(hashInput).digest('hex');
}

function extractDomState(page) {
  return page.evaluate(() => {
    const state = {
      modals: [],
      dropdowns: [],
      collapsed: [],
      active: []
    };

    document.querySelectorAll('[class*="modal"], [class*="dialog"], [role="dialog"]').forEach((el, i) => {
      if (el.offsetParent !== null) {
        state.modals.push(i);
      }
    });

    document.querySelectorAll('select, [role="listbox"], [class*="dropdown"], [class*="menu"]').forEach((el, i) => {
      if (el.offsetParent !== null) {
        state.dropdowns.push(i);
      }
    });

    document.querySelectorAll('details, [class*="collapse"], [class*="accordion"]').forEach((el, i) => {
      if (el.hasAttribute('open') || el.offsetParent !== null) {
        state.collapsed.push(i);
      }
    });

    document.querySelectorAll('[class*="active"], [aria-current]').forEach((el, i) => {
      state.active.push(i);
    });

    return state;
  });
}

function extractAllLinks(page, baseUrl) {
  return page.evaluate((baseUrl) => {
    const base = new URL(baseUrl);
    const links = [];
    const seen = new Set();

    document.querySelectorAll('a[href]').forEach(el => {
      try {
        const href = el.href;
        if (!href || href.startsWith('javascript:') || href.startsWith('mailto:')) return;

        const url = new URL(href);
        if (url.hostname === base.hostname && !seen.has(href)) {
          seen.add(href);
          links.push(href);
        }
      } catch (e) {}
    });

    return links;
  }, baseUrl);
}

function findClickables(page) {
  return page.evaluate(() => {
    const clickables = [];

    const buttons = document.querySelectorAll('button, input[type="button"], input[type="submit"]');
    buttons.forEach(el => {
      if (el.offsetParent !== null && !el.disabled) {
        clickables.push({ type: 'button', selector: getSelector(el), text: el.innerText?.trim().substring(0, 50) });
      }
    });

    const links = document.querySelectorAll('a[href]');
    links.forEach(el => {
      if (el.offsetParent !== null && el.href && !el.href.startsWith('javascript:')) {
        clickables.push({ type: 'link', selector: getSelector(el), text: el.innerText?.trim().substring(0, 50), href: el.href });
      }
    });

    const roles = document.querySelectorAll('[role="button"]');
    roles.forEach(el => {
      if (el.offsetParent !== null && !el.hasAttribute('disabled')) {
        clickables.push({ type: 'role-button', selector: getSelector(el), text: el.innerText?.trim().substring(0, 50) });
      }
    });

    return clickables;
  });

  function getSelector(el) {
    if (el.id) return `#${el.id}`;
    if (el.className && typeof el.className === 'string' && el.className.trim()) {
      return `.${el.className.trim().split(' ')[0]}`;
    }
    return el.tagName.toLowerCase();
  }
}

async function clickElement(page, clickable) {
  try {
    const locator = page.locator(clickable.selector).first();
    await locator.click({ timeout: 5000 });
    await page.waitForTimeout(800);
    return true;
  } catch (e) {
    return false;
  }
}

async function isSessionExpired(page) {
  const currentUrl = page.url();
  const authPaths = ['/sign-in', '/login', '/signin', '/sign_up', '/register'];

  for (const authPath of authPaths) {
    if (currentUrl.includes(authPath)) {
      return true;
    }
  }

  return false;
}

async function crawlPage(page, config, visited, results, pendingUrls, depth = 0) {
  if (depth > config.maxDepth) {
    return;
  }

  if (visited.size >= config.maxStates) {
    console.log(`⚠️  Reached max states limit (${config.maxStates})`);
    return;
  }

  const url = page.url();

  if (await isSessionExpired(page)) {
    console.log('\n⚠️  Session expired - redirected to login page');
    console.log('Please refresh cookies and run again.');
    process.exit(1);
  }

  const domState = await extractDomState(page);
  const stateHash = hashState(url, domState);

  if (visited.has(stateHash)) {
    return;
  }

  visited.add(stateHash);

  const consoleMonitor = new ConsoleMonitor();
  const networkMonitor = new NetworkMonitor();
  consoleMonitor.setup(page);
  networkMonitor.setup(page);

  await page.waitForTimeout(500);

  const screenshot = await captureScreenshot(page, consoleMonitor, networkMonitor);

  const errors = consoleMonitor.getErrors();
  const warnings = consoleMonitor.getWarnings();
  const failedRequests = networkMonitor.getFailedRequests();

  let status = 'success';
  if (errors.length > 0 || failedRequests.some(r => r.status >= 500)) {
    status = 'error';
  } else if (warnings.length > 0 || failedRequests.some(r => r.status >= 400)) {
    status = 'warning';
  }

  const pageData = {
    url,
    stateHash,
    depth,
    screenshot: screenshot.path,
    screenshotRelative: screenshot.relativePath,
    consoleErrors: errors,
    consoleWarnings: warnings,
    networkErrors: failedRequests,
    status,
    timestamp: new Date().toISOString()
  };

  results.pages.push(pageData);
  console.log(`  [${depth}] ${status === 'error' ? '🔴' : status === 'warning' ? '🟡' : '🟢'} ${url} (${screenshot.errorCount} issues)`);

  if (depth >= config.maxDepth) {
    return;
  }

  const links = await extractAllLinks(page, url);
  for (const link of links) {
    if (visited.size >= config.maxStates) break;
    if (!pendingUrls.has(link)) {
      pendingUrls.add(link);
    }
  }

  const clickables = await findClickables(page);
  const initialUrl = page.url();
  const initialDomState = domState;

  for (const clickable of clickables) {
    if (visited.size >= config.maxStates) {
      break;
    }

    await page.goto(initialUrl, { waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(300);

    const clicked = await clickElement(page, clickable);
    if (!clicked) continue;

    if (await isSessionExpired(page)) {
      console.log('\n⚠️  Session expired during crawl');
      process.exit(1);
    }

    const newDomState = await extractDomState(page);
    const newHash = hashState(page.url(), newDomState);

    if (!visited.has(newHash) && page.url() !== initialUrl) {
      await crawlPage(page, config, visited, results, pendingUrls, depth + 1);
    }
  }
}

async function startCrawl(page, config) {
  console.log('\n🚀 Starting crawl...\n');
  
  console.log('📋 Config received:', JSON.stringify({
    url: config.url,
    seedUrls: config.seedUrls,
    maxDepth: config.maxDepth,
    maxStates: config.maxStates,
    authMode: config.authMode
  }, null, 2));

  const visited = new Set();
  const pendingUrls = new Set();
  const results = {
    pages: [],
    summary: {
      totalPages: 0,
      totalErrors: 0,
      totalWarnings: 0,
      startedAt: new Date().toISOString(),
      completedAt: null
    }
  };

  const initialUrl = config.url;
  pendingUrls.add(initialUrl);

  if (config.seedUrls && config.seedUrls.length > 0) {
    config.seedUrls.forEach(url => pendingUrls.add(url.trim()));
  }
  console.log(`📋 Initial queue size: ${pendingUrls.size} URLs`);

  while (pendingUrls.size > 0 && visited.size < config.maxStates) {
    const currentUrl = pendingUrls.values().next().value;
    pendingUrls.delete(currentUrl);

    if (visited.size >= config.maxStates) break;

    try {
      await page.goto(currentUrl, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(500);

      await crawlPage(page, config, visited, results, pendingUrls, 0);
    } catch (e) {
      console.log(`  ⚠️  Failed to load: ${currentUrl} - ${e.message}`);
    }
  }

  results.summary.totalPages = results.pages.length;
  results.summary.totalErrors = results.pages.filter(p => p.status === 'error').length;
  results.summary.totalWarnings = results.pages.filter(p => p.status === 'warning').length;
  results.summary.completedAt = new Date().toISOString();

  console.log(`\n✅ Crawl complete: ${results.summary.totalPages} pages, ${results.summary.totalErrors} errors, ${results.summary.totalWarnings} warnings`);

  return results;
}

async function dryRun(page, config) {
  console.log('🔍 DRY RUN MODE\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log(`✓ URL: ${config.url}`);
  console.log(`✓ Auth mode: ${config.authMode}`);
  console.log(`✓ Viewport: ${config.viewport.width}x${config.viewport.height}`);
  console.log(`✓ Max depth: ${config.maxDepth}`);
  console.log(`✓ Max states: ${config.maxStates}`);
  if (config.seedUrls && config.seedUrls.length > 0) {
    console.log(`✓ Seed URLs: ${config.seedUrls.length} configured`);
  }

  await page.goto(config.url, { waitUntil: 'networkidle', timeout: 30000 });
  console.log(`✓ Page loaded: ${page.url()}`);

  const authOk = await verifyAuth(page);
  if (!authOk) {
    console.log('⚠️  Not authenticated - check cookies or run with clerk auth');
  } else {
    console.log('✓ Auth verified: Session active');
  }

  const clickables = await findClickables(page);
  const allLinks = await extractAllLinks(page, config.url);

  const buttons = clickables.filter(c => c.type === 'button');
  const links = clickables.filter(c => c.type === 'link');
  const roleButtons = clickables.filter(c => c.type === 'role-button');

  console.log(`\n📊 Clickable elements found: ${clickables.length}`);
  console.log(`   ├─ Buttons: ${buttons.length}`);
  console.log(`   ├─ Links (clickable): ${links.length}`);
  console.log(`   └─ Role[button]: ${roleButtons.length}`);
  console.log(`\n🔗 Internal links discovered: ${allLinks.length}`);

  const maxPossible = (clickables.length + allLinks.length) * config.maxDepth;
  console.log(`\n⚠️  Crawl would visit up to ~${maxPossible} pages (capped at ${config.maxStates})`);

  console.log('\n✅ Config valid. Run without --dry-run to start audit.\n');

  return {
    url: config.url,
    authVerified: authOk,
    clickables: clickables.length,
    buttons: buttons.length,
    links: links.length,
    roleButtons: roleButtons.length,
    discoveredLinks: allLinks.length
  };
}

module.exports = {
  startCrawl,
  dryRun,
  findClickables,
  extractDomState,
  extractAllLinks
};