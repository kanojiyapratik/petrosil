// Probe: can plain Node fetch + parse real price-news pages? No deps at all.
const TARGETS = [
  'https://www.opec.org/opec_web/en/press_room/basket.htm',
  'https://oilprice.com/oil-price-charts',
  'https://www.eia.gov/petroleum/gasdiesel/',
];

const UA = 'Mozilla/5.0 (compatible; PetrosilPriceBot/0.1; +https://petrosil.com)';

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

for (const url of TARGETS) {
  const t0 = process.hrtime.bigint();
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html' },
      signal: AbortSignal.timeout(20000),
    });
    const html = await res.text();
    const text = stripTags(html);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    // crude price-shaped token scan, just to show real numbers land in the text
    const prices = [...text.matchAll(/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?/g)]
      .map((m) => m[0])
      .slice(0, 8);

    console.log(`\n=== ${url}`);
    console.log(`    status ${res.status}  html ${html.length}b  text ${text.length}b  ${ms.toFixed(0)}ms`);
    console.log(`    price-shaped tokens: ${prices.length ? prices.join(' | ') : '(none in static HTML -> JS-rendered)'}`);
    console.log(`    text sample: ${text.slice(0, 220)}`);
  } catch (e) {
    console.log(`\n=== ${url}`);
    console.log(`    FAILED: ${e.name}: ${e.message}`);
  }
}
