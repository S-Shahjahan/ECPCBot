import { chromium } from 'playwright';
import { publicFetch, externalUrl } from './outbound.js';

// Website code runs in a fresh browser context. Every request goes through the
// public-address DNS guard. No Relay credentials or browser profile are loaded.
// Public-site scripts may supply their own read-only API headers (e.g. a public
// catalogue's anonymous key); those are isolated to this fresh context.
export async function renderWebsite(url, fetchFn = publicFetch) {
  const origin = externalUrl(url).origin;
  const env = Object.fromEntries(
    [
      'PATH',
      'Path',
      'HOME',
      'USERPROFILE',
      'TEMP',
      'TMP',
      'SystemRoot',
      'LOCALAPPDATA',
      'PLAYWRIGHT_BROWSERS_PATH',
    ]
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
  const browser = await chromium.launch({ headless: true, env });
  const deadline = setTimeout(() => void browser.close(), 45000);
  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: false,
      userAgent: 'RelayKnowledgeBot/1.0',
      viewport: { width: 1366, height: 900 },
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    let requests = 0,
      bytes = 0;
    await context.route('**/*', async (route) => {
      try {
        const request = route.request();
        const target = externalUrl(request.url());
        if (
          ++requests > 180 ||
          bytes > 25000000 ||
          request.method() !== 'GET' ||
          ['image', 'media', 'font'].includes(request.resourceType()) ||
          (request.isNavigationRequest() && target.origin !== origin)
        )
          return await route.abort();
        const response = await fetchFn(target.href, {
          limit: 5000000,
          timeout: 15000,
          headers: {
            'User-Agent': 'RelayKnowledgeBot/1.0',
            ...Object.fromEntries(
              Object.entries(request.headers()).filter(([name]) =>
                [
                  'accept',
                  'origin',
                  'referer',
                  'apikey',
                  'authorization',
                  'x-client-info',
                ].includes(name),
              ),
            ),
          },
        });
        const body = Buffer.from(await response.arrayBuffer());
        bytes += body.length;
        const headers = {};
        for (const name of [
          'content-type',
          'location',
          'access-control-allow-origin',
        ])
          if (response.headers.has(name))
            headers[name] = response.headers.get(name);
        await route.fulfill({ status: response.status, headers, body });
      } catch {
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage();
    page.on('popup', (popup) => void popup.close());
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    if (!response?.ok())
      throw new Error(
        'Website returned HTTP ' + (response?.status() || 'error'),
      );
    await page
      .waitForLoadState('networkidle', { timeout: 7000 })
      .catch(() => {});
    await page
      .waitForFunction(
        () => (document.body?.innerText.length || 0) > 200,
        null,
        { timeout: 6000 },
      )
      .catch(() => {});
    // Trigger common lazy content while bounding work on any single infinite-scroll page.
    for (let i = 0; i < 12; i++) {
      const end = await page.evaluate(() => {
        window.scrollBy(0, 800);
        return window.scrollY + innerHeight >= document.body.scrollHeight;
      });
      if (end) break;
      await page.waitForTimeout(150);
    }
    return await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]')).map(
        (a) => a.href,
      );
      document
        .querySelectorAll(
          'script,style,noscript,iframe,form,#lovable-badge,[data-lovable-badge]',
        )
        .forEach((el) => el.remove());
      return {
        title: (
          document.querySelector('h1')?.innerText || document.title
        ).slice(0, 200),
        text: document.body.innerText.trim(),
        links,
      };
    });
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
}
