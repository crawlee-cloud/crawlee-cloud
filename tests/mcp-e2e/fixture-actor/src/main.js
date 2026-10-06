import { Actor } from 'apify';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { query, maxItems = 3, sleepSecs = 0 } = input;
if (typeof query !== 'string' || query.length === 0) {
  throw new Error('query is required');
}

console.log(`echo-scraper: query="${query}" maxItems=${maxItems} sleepSecs=${sleepSecs}`);

const items = Array.from({ length: maxItems }, (_, i) => ({
  rank: i + 1,
  title: `${query} #${i + 1}`,
  price: (i + 1) * 10,
}));
if (items.length > 0) await Actor.pushData(items);

if (sleepSecs > 0) await new Promise((resolve) => setTimeout(resolve, sleepSecs * 1000));

await Actor.setValue('OUTPUT', { query, itemCount: items.length });
console.log(`echo-scraper: pushed ${items.length} items`);

await Actor.exit();
