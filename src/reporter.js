const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.resolve('output');

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function generateJsonReport(results, config) {
  ensureOutputDir();

  const report = {
    config: {
      url: config.url,
      maxDepth: config.maxDepth,
      maxStates: config.maxStates,
      viewport: config.viewport
    },
    summary: results.summary,
    pages: results.pages.map(p => ({
      url: p.url,
      status: p.status,
      screenshot: p.screenshotRelative,
      depth: p.depth,
      consoleErrors: p.consoleErrors.length,
      consoleWarnings: p.consoleWarnings.length,
      networkErrors: p.networkErrors.map(n => ({
        url: n.url,
        status: n.status,
        statusText: n.statusText
      })),
      timestamp: p.timestamp
    }))
  };

  const jsonPath = path.join(OUTPUT_DIR, 'audit-data.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`📄 JSON report saved: ${jsonPath}`);

  return jsonPath;
}

function generateHtmlReport(results, config) {
  ensureOutputDir();

  const errors = results.pages.filter(p => p.status === 'error');
  const warnings = results.pages.filter(p => p.status === 'warning');
  const success = results.pages.filter(p => p.status === 'success');

  const formatTime = (iso) => {
    const d = new Date(iso);
    return d.toLocaleTimeString();
  };

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Web Audit Report - ${config.url}</title>
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
    .section h2 { font-size: 20px; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; }
    .error-list, .warning-list { list-style: none; }
    .error-item, .warning-item { padding: 15px; border-radius: 8px; margin-bottom: 10px; }
    .error-item { background: #fef2f2; border-left: 4px solid #dc2626; }
    .warning-item { background: #fffbeb; border-left: 4px solid #f59e0b; }
    .error-item code, .warning-item code { background: rgba(0,0,0,0.05); padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    .page-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
    .page-card { background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); transition: transform 0.2s; }
    .page-card:hover { transform: translateY(-3px); box-shadow: 0 4px 12px rgba(0,0,0,0.12); }
    .page-screenshot { width: 100%; height: 180px; object-fit: cover; background: #e5e5e5; }
    .page-content { padding: 15px; }
    .page-url { font-size: 14px; color: #666; word-break: break-all; margin-bottom: 10px; }
    .page-meta { display: flex; justify-content: space-between; align-items: center; }
    .status-chip { padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .status-success { background: #dcfce7; color: #166534; }
    .status-warning { background: #fef3c7; color: #92400e; }
    .status-error { background: #fee2e2; color: #991b1b; }
    .issue-count { font-size: 12px; color: #999; }
    .empty { text-align: center; padding: 40px; color: #999; }
    .download-btn { background: #3b82f6; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; margin-left: auto; }
    .download-btn:hover { background: #2563eb; }
    .download-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .banner-header { display: flex; align-items: center; justify-content: space-between; }
    .banner-header h1 { display: flex; align-items: center; gap: 12px; }
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
    .lightbox-prev { left: 20px; }
    .lightbox-next { right: 20px; }
    .page-card { cursor: pointer; }
  </style>
</head>
<body>
  <div class="container">
    <div class="banner">
      <div class="banner-header">
        <h1>📊 Web Audit Report</h1>
        <button class="download-btn" onclick="downloadAllScreenshots()">📥 Download All Screenshots</button>
      </div>
      <p>${config.url}</p>
      <div class="stats">
        <div class="stat">
          <div class="stat-value">${results.summary.totalPages}</div>
          <div class="stat-label">Total Pages</div>
        </div>
        <div class="stat" style="background: rgba(220,38,38,0.3);">
          <div class="stat-value">${results.summary.totalErrors}</div>
          <div class="stat-label">Errors</div>
        </div>
        <div class="stat" style="background: rgba(245,158,11,0.3);">
          <div class="stat-value">${results.summary.totalWarnings}</div>
          <div class="stat-label">Warnings</div>
        </div>
      </div>
    </div>`;

  if (errors.length > 0) {
    html += `
    <div class="section">
      <h2>🔴 Errors (${errors.length})</h2>
      <ul class="error-list">`;
    errors.forEach(p => {
      const networkErrors = p.networkErrors.map(n => `<code>${n.status} ${n.statusText}</code>`).join(', ');
      html += `
        <li class="error-item">
          <strong>${new URL(p.url).pathname || '/'}</strong><br>
          <code>${p.url}</code><br>
          <span>Console: ${p.consoleErrors.length} | Network: ${networkErrors || 'none'}</span>
        </li>`;
    });
    html += `</ul>
    </div>`;
  }

  if (warnings.length > 0) {
    html += `
    <div class="section">
      <h2>🟡 Warnings (${warnings.length})</h2>
      <ul class="warning-list">`;
    warnings.forEach(p => {
      html += `
        <li class="warning-item">
          <strong>${new URL(p.url).pathname || '/'}</strong><br>
          <code>${p.url}</code>
        </li>`;
    });
    html += `</ul>
    </div>`;
  }

  html += `
    <div class="section">
      <h2>📄 Pages (${results.summary.totalPages})</h2>
      <div class="page-grid">`;

  results.pages.forEach((p, idx) => {
    const statusClass = p.status === 'error' ? 'status-error' : p.status === 'warning' ? 'status-warning' : 'status-success';
    const statusLabel = p.status === 'error' ? '🔴 Error' : p.status === 'warning' ? '🟡 Warning' : '🟢 Success';
    const issueCount = p.consoleErrors.length + p.networkErrors.length;
    const pageName = new URL(p.url).pathname || '/';
    const fileName = pageName === '/' ? 'home' : pageName.replace(/^\//, '').replace(/\//g, '-');

    html += `
        <div class="page-card">
          <img class="page-screenshot" src="${p.screenshotRelative}" alt="${pageName}" style="cursor:pointer;" onclick="openLightbox(${idx})" onerror="this.style.display='none'">
          <div class="page-content">
            <div class="page-url">${pageName}</div>
            <div class="page-meta">
              <span class="status-chip ${statusClass}">${statusLabel}</span>
              <span class="issue-count">${issueCount} issues</span>
            </div>
          </div>
        </div>`;
  });

  html += `
      </div>
    </div>
  </div>
</body>

<div class="lightbox" id="lightbox">
  <button class="lightbox-close" onclick="closeLightbox()">&times;</button>
  <button class="lightbox-nav lightbox-prev" onclick="navigateLightbox(-1)">&#10094;</button>
  <div class="lightbox-content">
    <img class="lightbox-img" id="lightbox-img" src="" alt="">
  </div>
  <button class="lightbox-nav lightbox-next" onclick="navigateLightbox(1)">&#10095;</button>
  <div class="lightbox-info">
    <div class="lightbox-url" id="lightbox-url"></div>
    <span class="lightbox-status" id="lightbox-status"></span>
  </div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<script>
  const pages = ${JSON.stringify(results.pages.map(p => ({
    url: p.url,
    pathname: p.url ? new URL(p.url).pathname : '/',
    status: p.status,
    screenshot: p.screenshotRelative
  })))};

  let currentIdx = 0;

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
    const p = pages[currentIdx];
    const statusClass = p.status === 'error' ? 'status-error' : p.status === 'warning' ? 'status-warning' : 'status-success';
    const statusLabel = p.status === 'error' ? '🔴 Error' : p.status === 'warning' ? '🟡 Warning' : '🟢 Success';
    document.getElementById('lightbox-img').src = p.screenshot;
    document.getElementById('lightbox-url').textContent = p.pathname;
    const statusEl = document.getElementById('lightbox-status');
    statusEl.textContent = statusLabel;
    statusEl.className = 'lightbox-status ' + statusClass;
  }

  document.getElementById('lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });

  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('lightbox').classList.contains('active')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') navigateLightbox(-1);
    if (e.key === 'ArrowRight') navigateLightbox(1);
  });

  async function downloadAllScreenshots() {
    const btn = document.querySelector('.download-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Creating ZIP...';
    
    try {
      const zip = new JSZip();
      
      for (const p of pages) {
        if (!p.screenshot) continue;
        const pageName = p.pathname === '/' ? 'home' : p.pathname.replace(/^\//, '').replace(/\//g, '-');
        const ext = p.screenshot.split('.').pop() || 'png';
        const fileName = pageName + '.' + ext;
        
        try {
          const resp = await fetch(p.screenshot);
          const blob = await resp.blob();
          zip.file(fileName, blob);
        } catch (e) {
          console.warn('Failed to fetch', p.screenshot, e);
        }
      }
      
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'audit-screenshots.zip';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Failed to create ZIP: ' + e.message);
    }
    
    btn.disabled = false;
    btn.textContent = '📥 Download All Screenshots';
  }
</script>
</html>`;

  const htmlPath = path.join(OUTPUT_DIR, 'audit-report.html');
  fs.writeFileSync(htmlPath, html);
  console.log(`📄 HTML report saved: ${htmlPath}\n`);

  return htmlPath;
}

module.exports = {
  generateJsonReport,
  generateHtmlReport
};