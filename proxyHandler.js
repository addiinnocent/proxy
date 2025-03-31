const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
const cors = require('@koa/cors');
const URL = require('url').URL;
const axios = require('axios');
const os = require('os');
const logger = require('koa-morgan'); // Koa-compatible morgan logger

chromium.use(stealth);

const validateUrl = (url) => {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch (error) {
    return false;
  }
};

let browser;

const startBrowser = async () => {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
      ignoreHTTPSErrors: true,
    });

    process.on('exit', async () => {
      if (browser) await browser.close();
    });
  }
  return browser;
};

// Utility function to download assets (JS, CSS, Images)
const downloadAsset = async (assetUrl, baseUrl) => {
  try {
    const fileUrl = new URL(assetUrl.trim(), baseUrl); // Trim spaces
    if (!fileUrl.pathname) return null; // Skip invalid URLs

    const filePath = path.join(os.tmpdir(), path.basename(fileUrl.pathname));

    if (!fs.existsSync(filePath)) {
      const response = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
      fs.writeFileSync(filePath, response.data);
    }

    return filePath;
  } catch (error) {
    console.error(`❌ Failed to download asset: ${assetUrl}`, error.message);
    return null; // Skip invalid assets
  }
};

// Rewrite asset URLs in the HTML content
const rewriteUrlsInContent = (content, baseUrl) => {
  content = content.replace(/\s+srcset="[^"]*"/g, '');

  return content.replace(/(["' ])(\/[^"'>]+)/g, (match, quote, relativeUrl) => {
    return `${quote}${baseUrl}${relativeUrl}`;
  });
};

const handler = async (ctx) => {
  if (ctx.method !== 'GET') {
    ctx.status = 405;
    ctx.body = { status: 'error', message: 'Only GET requests are allowed.' };
    return;
  }

  const targetUrl = ctx.query.url;
  if (!targetUrl || !validateUrl(targetUrl)) {
    ctx.status = 400;
    ctx.body = { status: 'error', message: 'Invalid URL.' };
    return;
  }

  const targetUrlObj = new URL(targetUrl);
  const baseUrl = `${targetUrlObj.protocol}//${targetUrlObj.host}`;

  try {
    // ✅ Fix CORS issues
    ctx.set('Access-Control-Allow-Origin', '*');
    ctx.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    ctx.set('Access-Control-Allow-Credentials', 'true');

    // ✅ Remove restrictive security headers
    const securityHeaders = [
      'x-frame-options',
      'content-security-policy',
      'permissions-policy',
      'strict-transport-security',
      'x-content-type-options',
      'feature-policy',
      'referrer-policy',
    ];

    securityHeaders.forEach(header => ctx.set(header, ''));

    // Start the browser and fetch page content
    const browser = await startBrowser();
    const page = await browser.newPage();

    await page.setExtraHTTPHeaders({
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent':
        ctx.get('User-Agent') ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Referer: baseUrl,
      Accept: '*/*',
      Origin: baseUrl,
    });

    // ✅ Download the page content
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('body', { timeout: 10000 });

    // Get the HTML content
    let content = await page.content();

    // ✅ Rewrite URLs for assets
    content = await rewriteUrlsInContent(content, baseUrl);

    // Download assets (e.g., JS, CSS, images)
    const assetUrls = [
      ...new Set([...content.matchAll(/(["' ])(\/[^"'>]+)/g)].map(match => match[2]))
    ];

    const downloadedAssets = [];

    for (let assetUrl of assetUrls) {
      const localPath = await downloadAsset(assetUrl, baseUrl);
      downloadedAssets.push({ assetUrl, localPath });
    }

    // Serve the content with asset links updated
    content = await rewriteUrlsInContent(content, '/assets/'); // Rewriting the base URL to local '/assets/'

    // Inject the script to disable console errors in the client
    content += `<script>
      window.console.log = function() {};
      window.console.warn = function() {};
      window.console.error = function() {};
      window.onerror = function() { return true; };
      window.addEventListener('error', function(e) { e.stopImmediatePropagation(); e.preventDefault(); return false; }, true);
      window.addEventListener('unhandledrejection', function(e) { e.preventDefault(); }, true);
    </script>`;

    await page.close();
    ctx.body = content;
    ctx.status = 200;
  } catch (error) {
    ctx.status = 500;
    ctx.body = { status: 'error', message: 'Failed to load page through proxy', details: error.message };
  }
};

module.exports.register = (router) => {
  router.get('/', cors(), handler);
};
