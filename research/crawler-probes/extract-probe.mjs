// Probe 3: the full no-browser path on a page that IS static --
// fetch -> strip -> hash (change detection) -> pull a real price table out.
import { createHash } from 'node:crypto';

const URL_ = 'https://www.eia.gov/petroleum/gasdiesel/';
const UA = 'Mozilla/5.0 (compatible; PetrosilPriceBot/0.1; +https://petrosil.com)';

// 1. robots.txt check -- the crawler must do this before every new source
const robots = await fetch('https://www.eia.gov/robots.txt', { headers: { 'user-agent': UA } })
  .then((r) => r.text())
  .catch(() => '');
console.log('robots.txt fetched:', robots.length, 'bytes');
console.log('  Disallow lines:', (robots.match(/^Disallow:.*/gim) || []).slice(0, 6).join(' | ') || '(none)');

// 2. fetch + normalise
const html = await fetch(URL_, { headers: { 'user-agent': UA } }).then((r) => r.text());
const text = html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// 3. change detection: hash today's text, compare to yesterday's stored hash
const hash = createHash('sha256').update(text).digest('hex');
console.log('\ncontent hash:', hash.slice(0, 32));
console.log('  -> stored per URL; identical hash tomorrow = no change, no AI call, no batch.');

// 4. the price region, as it would be handed to Gemini for extraction
const idx = text.search(/Regular Gasoline|Retail Prices|On-Highway Diesel/i);
const region = text.slice(Math.max(0, idx - 100), idx + 700);
console.log('\nprice region handed to the extractor:\n', region);
