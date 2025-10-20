# 💱 Lemfi Exchange Rate Fetcher

> A lightweight, automated tool to fetch real-time exchange rates from Lemfi's internal API. Available in both Node.js CLI and Google Apps Script versions.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![Google Apps Script](https://img.shields.io/badge/Google%20Apps%20Script-V8-blue)](https://developers.google.com/apps-script)

## 🎯 What This Does

Fetches **150+ currency exchange rates** from Lemfi (formerly Lemonade Finance) and outputs them in an easy-to-use format:
- **Node.js**: Saves to JSON file
- **Google Apps Script**: Writes to Google Sheets with currency formatting

## 🔍 The Challenge: Reverse Engineering Lemfi's API

While Lemfi provides a public website for checking exchange rates, they don't offer a public API. This project reverse-engineers their internal API to programmatically fetch rates.

**The biggest challenge?** Decoding the cryptic rate calculation hidden in their minified JavaScript. The API returns rates in an encoded format that requires a specific formula to decode - a formula that took hours of reverse engineering to discover.

### Discovery Process

1. **Traffic Analysis**: Inspected network requests on `lemfi.com/en-ca/international-money-transfer`
2. **Config Extraction**: Found `window.__NUXT__.config` embedded in the HTML containing:
   - All supported countries
   - Sender currencies (countries with signup enabled)
   - Receiver currencies (supported transfer destinations)
3. **API Endpoint**: Discovered the exchange rate endpoint: `https://lemfi.com/api/lemonade/v2/exchange`
4. **🔍 Rate Calculation Mystery**: This was the hardest part - the API response didn't make sense at first
5. **Rate Limiting**: Identified 403 responses → exponential backoff strategy
6. **Unsupported Pairs**: 412 status codes for invalid currency combinations

### Technical Deep Dive

#### Config Parsing
```javascript
// The config is JavaScript object notation (not JSON)
const html = await fetch('https://lemfi.com/en-ca/international-money-transfer').text();
const config = eval('(' + html.match(/window\.__NUXT__\.config\s*=\s*(\{[^<]+)/)[1] + ')');
```

#### Dynamic Currency Discovery
```javascript
const senders = new Map();    // Currencies that can send money
const receivers = new Set();  // Currencies that can receive money

config.public.countries.forEach(country => {
  if (country.customer?.signup && country.currency) {
    senders.set(country.currency, country.name);  // e.g., USD, CAD, GBP
  }
  if (country.customer?.transfer?.enabled) {
    country.customer.transfer.supported_currencies?.forEach(sc => {
      receivers.add(sc.code);  // e.g., INR, NGN, PKR
    });
  }
});
```

#### Exchange Rate API
```http
POST https://lemfi.com/api/lemonade/v2/exchange
Content-Type: application/json

{
  "from": "USD",
  "to": "INR",
  "sender_currency": "United States"
}
```

**Response:**
```json
{
  "data": {
    "rate": "8760.00",
    "ID": "100",
    "currency": "INR"
  }
}
```

**❓ The Problem:**
The `rate` value of `8760.00` doesn't match the actual USD→INR rate (~87.60). What's going on?

**🔍 The Breakthrough: Reverse Engineering Lemfi's Minified JavaScript**

This was the **hardest part to figure out**. The API response format wasn't documented, and the numbers didn't make sense. Here's how I cracked it:

1. **Inspected the minified JavaScript bundle** (`_nuxt/[hash].js`)
2. **Found the rate calculation logic** buried in thousands of lines of obfuscated code
3. **Discovered the formula**: The `ID` field is a divisor!

**The Hidden Formula:**
```javascript
const actualRate = parseFloat(data.rate) / parseInt(data.ID.replace(/\D/g, ''));
// Example: 8760.00 / 100 = 87.60 INR per USD
```

**Why this encoding?**
- `ID` field serves as a precision multiplier
- Common values: `"100"`, `"1000"`, `"10000"` 
- Different currencies use different precision levels
- The `.replace(/\D/g, '')` removes any non-digit characters from ID
- This allows Lemfi to represent rates without floating-point precision issues

**Real Examples:**
```javascript
// USD to INR
rate: "8760.00", ID: "100" → 8760 / 100 = 87.60 INR

// USD to JPY (higher precision)
rate: "140250", ID: "1000" → 140250 / 1000 = 140.25 JPY

// GBP to NGN (very large rate)
rate: "1985000", ID: "1000" → 1985000 / 1000 = 1985.00 NGN
```

Without reverse-engineering this formula, the API responses would be completely unusable. This was a critical discovery that made the entire project possible.

### Rate Limiting Strategy

The API enforces rate limits (403 status). Our solution:

```javascript
// Base strategy: 3 requests per 2 seconds
await delay(2000);  // After every 3 requests

// When rate limited: exponential backoff
if (status === 403) {
  const wait = 15 * Math.pow(2, attempt - 1);  // 15s, 30s, 60s, 120s, 240s
  await delay(wait * 1000);
}
```

**Result**: Successfully fetches 150 pairs in ~6-7 minutes with minimal failures.

## ⚠️ Important: Rate Limiting Notice

**This script is intentionally VERY conservative with rate limiting to avoid getting blocked by Lemfi's API.**

- **Default setting**: 3 requests per 2 seconds
- **Full fetch time**: ~6-7 minutes for all 150 currency pairs
- **Why so slow?**: Lemfi's API rate limits aggressively (403 errors) if you go faster

### 🔧 Want faster results?

If you only need a few specific currency pairs, you can:
1. **Reduce the wait time** in the code (at your own risk):
   ```javascript
   // Change this line in both index.js and code.js:
   await delay(1000);  // Instead of 2000 (1 second instead of 2)
   ```
2. **Modify sender/receiver lists** to fetch only the pairs you need

⚠️ **Warning**: Being too aggressive with requests may result in temporary IP bans or failed fetches. The current settings are tested and reliable.

## 🚀 Quick Start

### Option 1: Node.js (CLI)

#### Prerequisites
- Node.js 18+ (uses native fetch API)
- No dependencies required!

#### Installation
```bash
git clone https://github.com/yourusername/lemfi-fx-fetcher.git
cd lemfi-fx-fetcher
```

#### Usage
```bash
node index.js
```

**Output:**
```
⏳ Fetching currency config...
Found 6 sender currencies and 26 receiver currencies
✅ Found 150 pairs

🚀 Fetching rates (3 req/2sec)...

1/150 ✅ 1 AED = 0.2320 EUR
2/150 ✅ 1 AED = 33.7000 BDT
3/150 ✅ 1 AED = 152.5000 XOF
...
150/150 ❌ USD→GBP

✅ Done in 416s! Saved 118 rates → exchange-rates.json
```

**Output File (`exchange-rates.json`):**
```json
{
  "metadata": {
    "fetched_at": "2025-10-20T23:41:30.123Z",
    "total_pairs_attempted": 150,
    "successful_pairs": 118,
    "failed_pairs": 32,
    "success_rate": "79%",
    "duration_seconds": "416"
  },
  "rates": [
    { "from": "AED", "to": "BDT", "rate": 33.7, "formatted": "1 AED = 33.7000 BDT" },
    { "from": "AED", "to": "BRL", "rate": 1.4704, "formatted": "1 AED = 1.4704 BRL" }
  ]
}
```

### Option 2: Google Apps Script (Sheets)

#### Setup

1. **Create a Google Sheet**
   - Go to [sheets.google.com](https://sheets.google.com)
   - Create a new blank spreadsheet

2. **Add the Script**
   - Go to **Extensions** → **Apps Script**
   - Delete existing code
   - Copy contents of `code.js` from this repo
   - Save (Ctrl+S / Cmd+S)

3. **Authorize**
   - Click **Run** → select `onOpen`
   - Authorize when prompted

4. **Use It**
   - Refresh your Google Sheet
   - Click **💱 FX Rates** → **🔄 Fetch Latest Rates**
   - Wait 5-7 minutes for completion

#### Output Format

| Send | Receive | Exchange Rate |
|------|---------|---------------|
| AED  | BDT     | BDT 33.70     |
| AED  | BRL     | BRL 1.47      |
| CAD  | INR     | INR 62.50     |
| USD  | NGN     | NGN 1,475.00  |

**Features:**
- ✅ Automatic currency formatting (e.g., `$`, `€`, `£`, `₹`)
- ✅ Color-coded headers
- ✅ Alternating row colors
- ✅ Frozen header row
- ✅ Auto-resized columns
- ✅ Metadata footer (total pairs, last updated)

## 📊 Technical Details

### Supported Currencies

**Senders (6):** AED, CAD, EUR, GBP, NGN, USD  
**Receivers (26):** AED, BDT, BRL, CAD, CNY, EGP, ETB, EUR, GBP, GHS, GMD, INR, KES, LKR, MAD, NGN, NPR, PKR, PHP, RWF, TND, TZS, UGX, USD, XAF, XOF

**Total Pairs:** 150 (6 × 26, excluding same-currency pairs)

### API Behavior

| Status Code | Meaning | Action |
|-------------|---------|--------|
| 200 | Success | Parse and return rate |
| 403 | Rate limited | Exponential backoff retry |
| 412 | Unsupported pair | Skip immediately |
| Other | Network/server error | Retry up to 5 times |

### Performance

- **Average Duration:** 6-7 minutes for 150 pairs ⚠️ *Intentionally conservative*
- **Success Rate:** ~79% (118/150 pairs)
- **Rate Limiting:** 3 requests per 2 seconds (can be adjusted but not recommended)
- **Retry Strategy:** Up to 5 attempts with exponential backoff (15s → 30s → 60s → 120s → 240s)

**Why 6-7 minutes?**
- 150 pairs ÷ 3 requests per batch = 50 batches
- 50 batches × 2 seconds = 100 seconds base time (~1.7 minutes)
- Add rate limit penalties (403 errors) = ~5-6 extra minutes
- Total: 6-7 minutes

This conservative approach ensures high reliability and avoids IP bans.

### Architecture

```
┌─────────────────────────────────────────────────┐
│  Lemfi Website (lemfi.com)                      │
│  └─ window.__NUXT__.config (embedded in HTML)   │
└─────────────────────────────────────────────────┘
                    ▼
┌─────────────────────────────────────────────────┐
│  Config Parser                                   │
│  ├─ Extract sender currencies                    │
│  ├─ Extract receiver currencies                  │
│  └─ Generate currency pairs                      │
└─────────────────────────────────────────────────┘
                    ▼
┌─────────────────────────────────────────────────┐
│  Rate Fetcher (with rate limiting)              │
│  └─ POST /api/lemonade/v2/exchange              │
└─────────────────────────────────────────────────┘
                    ▼
┌─────────────────────────────────────────────────┐
│  Output                                          │
│  ├─ Node.js → JSON file                         │
│  └─ Google Apps Script → Google Sheets          │
└─────────────────────────────────────────────────┘
```

## 🔧 Customization

### Change Rate Limiting
```javascript
// In both index.js and code.js
const batchSize = 3;  // Requests per batch
await delay(2000);    // Wait time between batches (ms)
```

### Modify Retry Logic
```javascript
const maxAttempts = 5;  // Max retry attempts
const wait = 15 * Math.pow(2, attempt - 1);  // Backoff multiplier
```

### Add More Output Formats
```javascript
// Example: CSV export
const csv = rates.map(r => `${r.from},${r.to},${r.rate}`).join('\n');
writeFileSync('rates.csv', csv);
```

## 📝 Use Cases

1. **Currency Comparison**: Compare Lemfi's rates with other providers
2. **Rate Monitoring**: Track rate changes over time
3. **Integration**: Feed rates into your own application
4. **Analysis**: Analyze currency pair availability and trends
5. **Automation**: Schedule regular rate fetches via cron/triggers

## ⚠️ Important Notes

### Legal & Ethical
- ✅ This uses Lemfi's **public-facing** API (same as their website)
- ✅ Respects rate limits with exponential backoff
- ✅ No authentication bypass or security circumvention
- ⚠️ For **personal/educational use** only
- ⚠️ Not affiliated with or endorsed by Lemfi

### Limitations
- ⚠️ **Slow by design**: 6-7 minutes for all pairs (conservative rate limiting)
- API may change without notice (Lemfi controls it)
- Rate limiting hits fast and hard if you're too aggressive
- Some currency pairs are unsupported (412 status)
- No guarantee of data accuracy (always verify critical rates)
- Reducing wait times may result in failed fetches or temporary bans

## 🛠️ Development

### Project Structure
```
lemfi-fx-fetcher/
├── index.js              # Node.js CLI version
├── code.js               # Google Apps Script version
├── package.json          # Node.js metadata
├── exchange-rates.json   # Output file (generated)
└── README.md            # This file
```

### Technologies Used
- **Node.js 18+**: Native fetch API, ES modules
- **Google Apps Script V8**: Modern JavaScript runtime
- **No external dependencies**: Pure JavaScript implementation

### Code Quality
- ✅ Clean, readable code with comments
- ✅ Error handling with retry logic
- ✅ Rate limiting to be respectful
- ✅ Dynamic currency discovery (future-proof)
- ✅ Consistent formatting and structure

## 🤝 Contributing

Found a bug? Have an improvement? Contributions are welcome!

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📜 License

MIT License - feel free to use this project for personal or commercial purposes.

## 🙏 Acknowledgments

- **Lemfi (Lemonade Finance)** for providing transparent exchange rate information
- The open-source community for inspiration and tools

## 📧 Contact

Have questions? Found this useful? Let me know!

---

**⭐ If you find this project useful, please consider giving it a star!**

---

*Disclaimer: This is an independent project and is not affiliated with, endorsed by, or connected to Lemfi or Lemonade Finance in any way. Use at your own risk.*
