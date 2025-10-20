#!/usr/bin/env node
import { writeFileSync } from 'fs';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Fetch rate with smart retry
async function getRate(from, to, country) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch('https://lemfi.com/api/lemonade/v2/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, sender_currency: country })
      });

      // 412 = unsupported pair, abort immediately
      if (res.status === 412) return null;

      // 403 = rate limited, wait and retry with exponential backoff
      if (res.status === 403) {
        const wait = 15 * Math.pow(2, attempt - 1); // 15s, 30s, 60s, 120s
        console.log(`   ⏳ Rate limited, waiting ${wait}s...`);
        await delay(wait * 1000);
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (!data.data?.rate || !data.data?.ID) return null;

      const rate = parseFloat(data.data.rate) / parseInt(data.data.ID.replace(/\D/g, ''));
      return { from, to, rate, formatted: `1 ${from} = ${rate.toFixed(4)} ${to}` };

    } catch (error) {
      if (attempt === 5) return null;
      await delay(1000);
    }
  }
  return null;
}

// Main
(async () => {
  console.log('⏳ Fetching currency config...');
  
  // Get currency configuration
  const html = await (await fetch('https://lemfi.com/en-ca/international-money-transfer')).text();
  const config = eval('(' + html.match(/window\.__NUXT__\.config\s*=\s*(\{[^<]+)/)[1] + ')');
  
  // Build currency pairs dynamically from config
  const senders = new Map();
  const receivers = new Set();
  
  config.public.countries.forEach(c => {
    // Add currencies that can send money (signup enabled)
    if (c.customer?.signup && c.currency) {
      senders.set(c.currency, c.name);
    }
    // Add currencies that can receive money (transfer enabled)
    if (c.customer?.transfer?.enabled) {
      c.customer.transfer.supported_currencies?.forEach(sc => receivers.add(sc.code));
    }
  });
  
  console.log(`Found ${senders.size} sender currencies and ${receivers.size} receiver currencies`);
  
  const pairs = [];
  senders.forEach((country, from) => {
    receivers.forEach(to => {
      if (from !== to) pairs.push({ from, to, country });
    });
  });
  
  console.log(`✅ Found ${pairs.length} pairs\n`);
  console.log('🚀 Fetching rates (3 req/2sec)...\n');
  
  // Fetch sequentially with rate limiting
  const rates = [];
  const startTime = Date.now();
  
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const rate = await getRate(p.from, p.to, p.country);
    
    if (rate) {
      rates.push(rate);
      console.log(`${i + 1}/${pairs.length} ✅ ${rate.formatted}`);
    } else {
      console.log(`${i + 1}/${pairs.length} ❌ ${p.from}→${p.to}`);
    }
    
    // Rate limit: 3 requests per 2 seconds (wait 667ms between requests)
    if ((i + 1) % 3 === 0 && i < pairs.length - 1) {
      await delay(2000);
    }
  }
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  
  // Save results
  writeFileSync('exchange-rates.json', JSON.stringify({
    metadata: {
      fetched_at: new Date().toISOString(),
      total_pairs_attempted: pairs.length,
      successful_pairs: rates.length,
      failed_pairs: pairs.length - rates.length,
      success_rate: `${Math.round(rates.length / pairs.length * 100)}%`,
      duration_seconds: elapsed
    },
    rates: rates.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
  }, null, 2));
  
  console.log(`\n✅ Done in ${elapsed}s! Saved ${rates.length} rates → exchange-rates.json`);
})();
