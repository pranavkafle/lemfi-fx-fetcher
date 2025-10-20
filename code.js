/**
 * Lemfi Exchange Rate Fetcher for Google Sheets
 * Fetches currency exchange rates and writes them to the active sheet
 */

// Main menu
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('💱 FX Rates')
    .addItem('🔄 Fetch Latest Rates', 'fetchAndWriteRates')
    .addToUi();
}

// Main function - fetch rates and write to sheet
function fetchAndWriteRates() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const ui = SpreadsheetApp.getUi();
  const startTime = new Date();
  
  try {
    Logger.log('⏳ Fetching currency config...');
    
    // Fetch currency configuration
    const html = UrlFetchApp.fetch('https://lemfi.com/en-ca/international-money-transfer').getContentText();
    const configMatch = html.match(/window\.__NUXT__\.config\s*=\s*(\{[^<]+)/);
    if (!configMatch) throw new Error('Failed to extract config');
    
    // Use sandboxed evaluation for JavaScript object notation
    const config = evalJavaScriptObject(configMatch[1]);
    
    // Build currency pairs dynamically from config
    const senders = new Map();
    const receivers = new Set();
    
    config.public.countries.forEach(country => {
      // Add currencies that can send money (signup enabled)
      if (country.customer?.signup && country.currency) {
        senders.set(country.currency, country.name);
      }
      // Add currencies that can receive money (transfer enabled)
      if (country.customer?.transfer?.enabled) {
        country.customer.transfer.supported_currencies?.forEach(sc => {
          receivers.add(sc.code);
        });
      }
    });
    
    Logger.log(`Found ${senders.size} sender currencies and ${receivers.size} receiver currencies`);
    
    const pairs = [];
    senders.forEach((countryName, fromCurrency) => {
      receivers.forEach(toCurrency => {
        if (fromCurrency !== toCurrency) {
          pairs.push({ from: fromCurrency, to: toCurrency, country: countryName });
        }
      });
    });
    
    Logger.log(`✅ Found ${pairs.length} pairs\n`);
    Logger.log('🚀 Fetching rates (3 req/2sec)...\n');
    
    // Fetch all rates
    const rates = [];
    const batchSize = 3;
    
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      const rate = getRate(pair.from, pair.to, pair.country);
      
      if (rate) {
        rates.push({
          from: pair.from,
          to: pair.to,
          rate: rate
        });
        Logger.log(`${i + 1}/${pairs.length} ✅ 1 ${pair.from} = ${rate.toFixed(4)} ${pair.to}`);
      } else {
        Logger.log(`${i + 1}/${pairs.length} ❌ ${pair.from}→${pair.to}`);
      }
      
      // Rate limiting: 3 requests per 2 seconds
      if ((i + 1) % batchSize === 0 && i < pairs.length - 1) {
        Utilities.sleep(2000);
      }
    }
    
    const elapsed = Math.round((new Date() - startTime) / 1000);
    const elapsedMin = Math.floor(elapsed / 60);
    const elapsedSec = elapsed % 60;
    const timeStr = elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec}s` : `${elapsedSec}s`;
    
    // Write to sheet
    writeRatesToSheet(sheet, rates);
    
    const successRate = Math.round(rates.length / pairs.length * 100);
    
    Logger.log(`\n✅ Done in ${elapsed}s! Saved ${rates.length} rates to sheet`);
    Logger.log(`📊 Success rate: ${successRate}% (${rates.length}/${pairs.length})`);
    
    // Show summary alert at the END
    ui.alert(
      '✅ FX Rates Updated!',
      `Completed in ${timeStr}\n\n` +
      `📊 Total Pairs: ${pairs.length}\n` +
      `✅ Successful: ${rates.length}\n` +
      `❌ Failed: ${pairs.length - rates.length}\n` +
      `📈 Success Rate: ${successRate}%`,
      ui.ButtonSet.OK
    );
    
  } catch (error) {
    Logger.log('❌ Error: ' + error.message);
    // Show error alert
    ui.alert('❌ Error', error.message, ui.ButtonSet.OK);
    throw error;
  }
}

// Safely evaluate JavaScript object notation using HtmlService sandbox
function evalJavaScriptObject(jsObjectString) {
  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <script>
          function evaluateObject() {
            try {
              const obj = ${jsObjectString};
              return JSON.stringify(obj);
            } catch (e) {
              return JSON.stringify({ error: e.message });
            }
          }
        </script>
      </head>
    </html>
  `;
  
  const htmlOutput = HtmlService.createHtmlOutput(htmlContent);
  const blob = htmlOutput.getBlob();
  const html = blob.getDataAsString();
  
  // Execute in sandboxed context
  const result = HtmlService.createHtmlOutput(
    `<script>google.script.host.setHeight(1); google.script.run.processResult(evaluateObject());</script>` + htmlContent
  );
  
  // Alternative: Use direct evaluation with Function constructor
  try {
    const cleanedJs = jsObjectString.trim();
    // Wrap in parentheses and use Function constructor (safer than eval)
    const func = new Function('return (' + cleanedJs + ')');
    return func();
  } catch (e) {
    Logger.log('Eval error: ' + e.message);
    throw new Error('Failed to parse config: ' + e.message);
  }
}

// Fetch single rate with retry logic
function getRate(from, to, country) {
  const maxAttempts = 5;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const options = {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          from: from,
          to: to,
          sender_currency: country
        }),
        muteHttpExceptions: true
      };
      
      const response = UrlFetchApp.fetch('https://lemfi.com/api/lemonade/v2/exchange', options);
      const statusCode = response.getResponseCode();
      
      // 412 = unsupported pair, skip
      if (statusCode === 412) return null;
      
      // 403 = rate limited, wait and retry
      if (statusCode === 403) {
        const wait = 15 * Math.pow(2, attempt - 1); // exponential backoff
        Logger.log(`   ⏳ Rate limited, waiting ${wait}s...`);
        Utilities.sleep(wait * 1000);
        continue;
      }
      
      if (statusCode !== 200) {
        throw new Error(`HTTP ${statusCode}`);
      }
      
      const data = JSON.parse(response.getContentText());
      if (!data.data?.rate || !data.data?.ID) return null;
      
      // Calculate rate
      const rateValue = parseFloat(data.data.rate);
      const id = parseInt(data.data.ID.replace(/\D/g, ''));
      const rate = rateValue / id;
      
      return rate;
      
    } catch (error) {
      Logger.log(`Attempt ${attempt} failed: ${error.message}`);
      if (attempt === maxAttempts) return null;
      Utilities.sleep(1000);
    }
  }
  
  return null;
}

// Write rates to sheet with formatting
function writeRatesToSheet(sheet, rates) {
  // Clear existing content
  sheet.clear();
  
  // Set headers
  const headers = [
    ['Send', 'Receive', 'Exchange Rate']
  ];
  sheet.getRange(1, 1, 1, 3).setValues(headers);
  
  // Format headers
  sheet.getRange(1, 1, 1, 3)
    .setFontWeight('bold')
    .setBackground('#4285f4')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center');
  
  // Sort rates by FROM then TO currency
  rates.sort((a, b) => {
    if (a.from !== b.from) return a.from.localeCompare(b.from);
    return a.to.localeCompare(b.to);
  });
  
  // Prepare data rows
  const data = rates.map(r => [
    r.from,
    r.to,
    r.rate
  ]);
  
  // Write data
  if (data.length > 0) {
    const dataRange = sheet.getRange(2, 1, data.length, 3);
    dataRange.setValues(data);
    
    // Format FROM column (currency codes)
    sheet.getRange(2, 1, data.length, 1)
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
    
    // Format TO column (currency codes)
    sheet.getRange(2, 2, data.length, 1)
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
    
    // Format Rate column with currency based on TO currency
    for (let i = 0; i < rates.length; i++) {
      const currencyCode = rates[i].to;
      const cellRow = i + 2; // +2 because row 1 is header, data starts at row 2
      
      // Apply currency format with currency code
      // Using [$XXX] notation for dynamic currency formatting
      sheet.getRange(cellRow, 3)
        .setNumberFormat(`[$${currencyCode}] #,##0.00`)
        .setHorizontalAlignment('right');
    }
  }
  
  // Auto-resize columns
  sheet.autoResizeColumns(1, 3);
  
  // Freeze header row
  sheet.setFrozenRows(1);
  
  // Add metadata at the bottom
  const metadataRow = data.length + 3;
  const timestamp = new Date();
  
  sheet.getRange(metadataRow, 1).setValue('Total Pairs:');
  sheet.getRange(metadataRow, 2).setValue(data.length);
  sheet.getRange(metadataRow, 1).setFontWeight('bold');
  
  sheet.getRange(metadataRow + 1, 1).setValue('Last Updated:');
  sheet.getRange(metadataRow + 1, 2).setValue(timestamp);
  sheet.getRange(metadataRow + 1, 1).setFontWeight('bold');
  sheet.getRange(metadataRow + 1, 2).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  
  // Add alternating row colors for better readability
  if (data.length > 0) {
    sheet.getRange(2, 1, data.length, 3)
      .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY);
  }
}
