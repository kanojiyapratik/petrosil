// Probe 2: do the pages that plain fetch could NOT read work under a real
// browser? These were the two failures: OPEC = Cloudflare 403, oilprice = JS-rendered.
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';

const TARGETS = [
  'https://www.opec.org/opec_web/en/press_room/basket.htm',
  'https://oilprice.com/oil-price-charts',
];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  locale: 'en-US',
});

for (const url of TARGETS) {
  const t0 = process.hrtime.bigint();
  const page = await ctx.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500); // let client-side price widgets settle
    const text = (await page.innerText('body')).replace(/\s+/g, ' ').trim();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    const prices = [...text.matchAll(/\$?\s?\d{1,3}(?:,\d{3})*\.\d{2}\b/g)].map((m) => m[0].trim()).slice(0, 10);
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);

    console.log(`\n=== ${url}`);
    console.log(`    status ${res?.status()}  rendered text ${text.length}b  ${ms.toFixed(0)}ms`);
    console.log(`    content hash: ${hash}   <-- this is what daily change-detection compares`);
    console.log(`    price-shaped tokens: ${prices.length ? prices.join(' | ') : '(none)'}`);
    console.log(`    text sample: ${text.slice(0, 260)}`);
  } catch (e) {
    console.log(`\n=== ${url}`);
    console.log(`    FAILED: ${e.name}: ${e.message.split('\n')[0]}`);
  } finally {
    await page.close();
  }
}

await browser.close();
