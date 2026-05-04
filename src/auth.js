const { saveCookies, updateConfigAuthMode } = require('./config');

const CLERK_PATHS = ['/sign-in', '/login', '/signin'];
const CLERK_SELECTORS = [
  '[data-clerk-component]',
  '#clerk-components',
  '.clerk-card',
  '[data-clerk-organization-switcher]',
  '.clerk-root'
];

const EMAIL_INPUT_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[id="email"]',
  'input[autocomplete="email"]',
  'input[placeholder*="email" i]'
];

const OTP_INPUT_SELECTORS = [
  'input[name="code"]',
  'input[name="verification_code"]',
  'input[placeholder*="code" i]',
  'input[placeholder*="digit" i]',
  'input[aria-label*="code" i]',
  'input[class*="otp" i]',
  'input[class*="verification" i]'
];

const EMAIL_LINK_SELECTORS = [
  'text=Continue with email',
  'text=Use email',
  'text=Sign in with email',
  'text=Email sign in',
  'a:has-text("Continue with email")',
  'a:has-text("Use email")',
  '[class*="email-option"]',
  '[class*="email-link"]'
];

async function findClerkSignInPage(page) {
  const url = page.url();

  for (const clerkPath of CLERK_PATHS) {
    try {
      const testUrl = new URL(clerkPath, url).href;
      await page.goto(testUrl, { timeout: 5000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      const isClerk = await page.evaluate(() => {
        const selectors = document.querySelectorAll('[data-clerk-component], #clerk-components, .clerk-root, [class*="clerk"]');
        return selectors.length > 0 ||
               document.body.innerHTML.includes('clerk') ||
               document.querySelector('script[src*="clerk"]') !== null;
      });

      if (isClerk) {
        console.log(`✅ Found Clerk sign-in page: ${testUrl}`);
        return testUrl;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function findClerkSignInUrl(page, configUrl, configSignInUrl) {
  if (configSignInUrl) {
    const fullUrl = new URL(configSignInUrl, configUrl).href;
    console.log(`Using configured sign-in URL: ${fullUrl}`);
    return fullUrl;
  }

  console.log('🔍 Auto-detecting Clerk sign-in page...');
  return await findClerkSignInPage(page);
}

async function handleOAuthButton(page) {
  for (const selector of EMAIL_LINK_SELECTORS) {
    try {
      const link = await page.locator(selector).first();
      if (await link.isVisible({ timeout: 2000 })) {
        console.log('Found "Continue with email" link, clicking...');
        await link.click();
        await page.waitForTimeout(1500);
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

async function findEmailInput(page) {
  for (const selector of EMAIL_INPUT_SELECTORS) {
    try {
      const input = await page.locator(selector).first();
      if (await input.isVisible({ timeout: 2000 })) {
        return input;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function findOtpInput(page) {
  for (const selector of OTP_INPUT_SELECTORS) {
    try {
      const input = await page.locator(selector).first();
      if (await input.isVisible({ timeout: 3000 })) {
        return input;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function authenticateWithClerk(page, email) {
  console.log('\n🔐 Starting Clerk OTP authentication...\n');

  const signInUrl = await findClerkSignInUrl(page, page.url(), null);
  if (!signInUrl) {
    throw new Error('Could not find Clerk sign-in page. Please specify signInUrl in config.json');
  }

  await page.goto(signInUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const emailInput = await findEmailInput(page);
  if (!emailInput) {
    console.log('No email input found immediately, checking for OAuth buttons...');
    const clickedEmailLink = await handleOAuthButton(page);
    if (clickedEmailLink) {
      await page.waitForTimeout(1500);
    }

    const retryEmailInput = await findEmailInput(page);
    if (!retryEmailInput) {
      throw new Error('Could not find Clerk email input. Page structure may have changed.');
    }
    await retryEmailInput.fill(email);
  } else {
    await emailInput.fill(email);
  }

  const submitButton = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Sign in")').first();
  await submitButton.click();

  await page.waitForTimeout(2000);

  const otpInput = await findOtpInput(page);
  if (!otpInput) {
    throw new Error('OTP input not found. Clerk may have changed authentication flow.');
  }

  console.log('\n📧 OTP code sent to your email.');
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const otp = await new Promise((resolve) => {
    rl.question('Enter the 6-digit code from your email: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  if (!/^\d{6}$/.test(otp)) {
    throw new Error('Invalid OTP format. Expected 6 digits.');
  }

  await otpInput.fill(otp);
  await submitButton.click();

  await page.waitForTimeout(3000);

  const currentUrl = page.url();
  if (currentUrl.includes('/sign-in') || currentUrl.includes('/login')) {
    throw new Error('Authentication failed. Please try again.');
  }

  console.log('✅ Clerk authentication successful!');

  const cookies = await page.context().cookies();
  saveCookies(cookies);
  updateConfigAuthMode('cookies');

  return true;
}

async function injectCookies(page, cookies) {
  if (cookies && cookies.length > 0) {
    await page.context().addCookies(cookies);
    console.log(`✅ Injected ${cookies.length} cookies`);
    return true;
  }
  return false;
}

async function verifyAuth(page) {
  const currentUrl = page.url();
  const authPaths = ['/sign-in', '/login', '/signin', '/sign_up', '/register'];

  for (const authPath of authPaths) {
    if (currentUrl.includes(authPath)) {
      return false;
    }
  }

  return true;
}

module.exports = {
  authenticateWithClerk,
  injectCookies,
  verifyAuth,
  findClerkSignInUrl
};