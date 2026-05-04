const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  maxDepth: 3,
  maxStates: 200,
  viewport: { width: 1280, height: 800 },
  authMode: 'cookies',
  seedUrls: []
};

function loadConfig(configPath = 'config.json') {
  const configFile = path.resolve(configPath);

  if (!fs.existsSync(configFile)) {
    console.error(`❌ Config file not found: ${configFile}`);
    console.log('Please create a config.json file in the project root.');
    process.exit(1);
  }

  const rawConfig = fs.readFileSync(configFile, 'utf-8');
  let config;

  try {
    config = JSON.parse(rawConfig);
  } catch (e) {
    console.error('❌ Invalid JSON in config file');
    process.exit(1);
  }

  config = { ...DEFAULT_CONFIG, ...config };

  if (!config.url) {
    console.error('❌ Config must include "url" property');
    process.exit(1);
  }

  config.url = normalizeUrl(config.url);

  if (!config.viewport || !config.viewport.width || !config.viewport.height) {
    config.viewport = DEFAULT_CONFIG.viewport;
  }

  return config;
}

function normalizeUrl(url) {
  url = url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url;
}

function getClerkCookies() {
  const cookiesPath = path.resolve('cookies.json');
  if (fs.existsSync(cookiesPath)) {
    try {
      return JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
    } catch {
      return [];
    }
  }
  return [];
}

function saveCookies(cookies) {
  const cookiesPath = path.resolve('cookies.json');
  fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
  console.log('✅ Cookies saved to cookies.json');
}

function updateConfigAuthMode(newMode) {
  const configPath = path.resolve('config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    config.authMode = newMode;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
}

module.exports = {
  loadConfig,
  getClerkCookies,
  saveCookies,
  updateConfigAuthMode
};