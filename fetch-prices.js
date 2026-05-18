#!/usr/bin/env node
'use strict';

// ─── NAS Drive Price Tracker — fetch-prices.js v2.1.0 ────────────────────────
// Runs via GitHub Actions on a daily schedule.
// Queries SerpAPI (Google Shopping + Amazon engine), filters to confirmed
// new-condition drives from trusted retailers, writes prices.json, sends email.

const VERSION = '2.2.0';
const fs   = require('fs');
const path = require('path');

// ─── ENVIRONMENT ─────────────────────────────────────────────────────────────
const SERP_API_KEY  = process.env.SERP_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_EMAIL   = process.env.ALERT_EMAIL;
const SITE_URL      = process.env.SITE_URL || 'https://etlarson55-hub.github.io/nas-tracker/';

if (!SERP_API_KEY)   { console.error('FATAL: SERP_API_KEY not set');   process.exit(1); }
if (!RESEND_API_KEY) { console.error('FATAL: RESEND_API_KEY not set'); process.exit(1); }
if (!ALERT_EMAIL)    { console.error('FATAL: ALERT_EMAIL not set');    process.exit(1); }

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const MIN_CREDITS_REQUIRED = 12;   // Abort run if fewer credits than this remain
const MIN_PRICE_USD        = 30;
const MAX_PRICE_USD        = 700;
const MIN_PRICE_PER_TB     = 12;   // Below this is an enclosure, bundle, or data error
const MAX_DRIVES_DISPLAY   = 20;
const QUERY_DELAY_MS       = 900;  // Polite delay between API calls

// Trusted retailer substrings (checked AFTER the deny list)
const ALLOWED_RETAILERS = [
  'amazon', 'best buy', 'b&h', 'bhphotovideo',
  'adorama', 'costco', 'micro center', 'antonline',
];

// Explicitly denied — checked FIRST, before the allow list.
// This is what fixed the Newegg-on-main-list bug from v13.
const DENIED_RETAILERS = [
  'newegg', 'walmart', 'wd store', 'ebay', 'poshmark', 'mercari',
  'orange hardwares', 'tech atlantix', 'serverblink', 'drivestolutions',
  'disctech', 'avendor', 'pcnation', 'neobits', 'serversupply',
  'govconnection', 'serverorbit', 'genuinemodules', 'provantage',
  'shi international', 'journeyed', 'dihuni', 'directdial', 'hssl',
  'fishersci', 'tiedex', 'wb mason', 'w.b. mason', 'server tech supply',
  'tristatecamera', 'tour supply', 'serverpartdeals',
];

// SMR drive patterns — reject if title matches any of these.
// WD Red (base) is SMR; WD Red Plus and WD Red Pro are CMR — handled by
// the negative lookahead in the first pattern.
const SMR_PATTERNS = [
  { re: /\bWD\s+Red(?!\s+(?:Plus|Pro))/i,   label: 'WD Red base (SMR)'         },
  { re: /\bWD\s+Blue\b/i,                    label: 'WD Blue (SMR)'             },
  { re: /\bWD\s+Purple\b/i,                  label: 'WD Purple (SMR)'           },
  { re: /\bWD\s+Green\b/i,                   label: 'WD Green (SMR)'            },
  { re: /\bSeagate\s+Barracuda\b/i,          label: 'Barracuda (SMR)'           },
  { re: /\bSeagate\s+SkyHawk\b/i,            label: 'SkyHawk (SMR)'             },
  { re: /\bSeagate\s+Pipeline\b/i,           label: 'Pipeline (SMR)'            },
  { re: /\bSeagate\s+Archive\b/i,            label: 'Archive HDD (SMR)'         },
  { re: /\bSeagate\s+Expansion\b/i,          label: 'Expansion (external)'      },
  { re: /\bWD\s+Elements\b/i,                label: 'WD Elements (external)'    },
  { re: /\bWD\s+Easystore\b/i,               label: 'Easystore (external)'      },
  { re: /\bToshiba\s+P300\b/i,               label: 'Toshiba P300 (SMR)'        },
  { re: /\bToshiba\s+L200\b/i,               label: 'Toshiba L200 (SMR)'        },
  { re: /\bToshiba\s+S300\b/i,               label: 'Toshiba S300 (surveillance)'},
  { re: /\bSA500\b/i,                         label: 'WD Red SA500 (SSD)'        },
  { re: /\bSSD\b/i,                           label: 'SSD (not HDD)'             },
  { re: /\bSolid.?State\b/i,                  label: 'Solid State (not HDD)'     },
  { re: /\bNVMe\b/i,                          label: 'NVMe (not HDD)'            },
  { re: /\bM\.2\b/i,                          label: 'M.2 (not HDD)'             },
  { re: /\bSMR\b/i,                           label: 'SMR explicitly stated'     },
  { re: /\bShingled\b/i,                      label: 'Shingled (SMR)'            },
];

// Condition keywords that signal used / refurbished items.
// For Google Shopping this is the primary defense for trusted retailers.
// For Amazon this is a safety net on top of the server-side condition filter.
const CONDITION_KEYWORDS = [
  'refurb', 'refurbished', 'recertified', 'renewed', 'reconditioned',
  'open box', 'open-box', 'openbox', 'pre-owned', 'preowned', 'pre owned',
  'oem pull', 'remanufactured', 'surplus', 'second-hand', 'secondhand',
  'scratch', 'dent', 'damaged', 'as-is', 'as is', 'grade b', 'grade c',
  'warehouse deal', '(recertified)', '(renewed)', '(refurbished)', '(used)',
];

// Drive model catalog for identification from title text.
// IMPORTANT: Western Digital model names must NOT include the "WD" prefix here
// because the name builder prepends shortBrand ("WD") automatically.
// "WD Red Plus" → name would be "WD WD Red Plus 8TB" — wrong.
// "Red Plus"    → name becomes  "WD Red Plus 8TB"    — correct.
const KNOWN_MODELS = [
  { brand: 'Seagate',         model: 'IronWolf Pro', patterns: [/ironwolf\s+pro/i]              },
  { brand: 'Seagate',         model: 'IronWolf',     patterns: [/ironwolf(?!\s*pro)/i]           },
  { brand: 'Seagate',         model: 'Exos',         patterns: [/\bexos\b/i]                    },
  { brand: 'Western Digital', model: 'Red Pro',      patterns: [/\bred\s+pro\b/i]               },
  { brand: 'Western Digital', model: 'Red Plus',     patterns: [/\bred\s+plus\b/i]              },
  { brand: 'Western Digital', model: 'Gold',         patterns: [/\b(?:wd\s+)?gold\b(?!\s+ssd)/i] },
  { brand: 'Toshiba',         model: 'N300',         patterns: [/\bn300\b/i]                    },
  { brand: 'Toshiba',         model: 'MG',           patterns: [/\bMG\d{2}/i, /toshiba\s+mg\b/i] },
];

// ─── QUERIES ──────────────────────────────────────────────────────────────────
// 6 Google Shopping + 3 Amazon = 9 credits per run
// 250 credits / 9 = ~27 runs/month = refresh roughly every 27 hours

const GOOGLE_QUERIES = [
  'Seagate IronWolf NAS internal hard drive',
  'Seagate IronWolf Pro NAS internal hard drive',
  'Seagate Exos enterprise internal hard drive',
  'WD Red Plus NAS internal hard drive CMR',
  'WD Red Pro NAS internal hard drive',
  'WD Gold enterprise internal hard drive',
];

const AMAZON_QUERIES = [
  // rh=p_n_condition-type:2224371011 forces new-condition at Amazon's level
  'Seagate IronWolf NAS hard drive',
  'Seagate Exos enterprise hard drive',
  'WD Red NAS internal hard drive CMR',
];

const TOTAL_QUERIES = GOOGLE_QUERIES.length + AMAZON_QUERIES.length;

// ─── PATHS ────────────────────────────────────────────────────────────────────
const ROOT      = __dirname;
const DATA_DIR  = path.join(ROOT, 'data');
const RAW_DIR   = path.join(DATA_DIR, 'raw');
const LOGS_DIR  = path.join(DATA_DIR, 'logs');
const PRICES_F  = path.join(DATA_DIR, 'prices.json');
const RUNLOG_F  = path.join(LOGS_DIR, 'run-log.json');

[DATA_DIR, RAW_DIR, LOGS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── UTILITIES ────────────────────────────────────────────────────────────────
const log = msg => console.log(`${new Date().toISOString()}  ${msg}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { log(`⚠  Could not parse ${path.basename(file)}: ${e.message}`); return fallback; }
}

function extractPrice(item) {
  if (typeof item.extracted_price === 'number') return item.extracted_price;
  if (typeof item.price === 'number') return item.price;
  if (typeof item.price === 'string') {
    const n = parseFloat(item.price.replace(/[^0-9.]/g, ''));
    return isNaN(n) ? null : n;
  }
  if (item.price && typeof item.price === 'object') {
    return item.price.extracted ?? item.price.value ?? null;
  }
  return null;
}

function extractCapacityTB(title) {
  const tb = title.match(/\b(\d+(?:\.\d+)?)\s*TB\b/i);
  if (tb) return parseFloat(tb[1]);
  const gb = title.match(/\b(\d{4,6})\s*GB\b/i);
  if (gb) {
    const v = parseFloat(gb[1]);
    if (v >= 1000) return Math.round(v / 1000);
  }
  return null;
}

function identifyModel(title) {
  for (const { brand, model, patterns } of KNOWN_MODELS) {
    for (const p of patterns) {
      if (p.test(title)) return { brand, model };
    }
  }
  return { brand: 'Unknown', model: 'Unknown' };
}

function classifyRetailer(source) {
  const s = (source || '').toLowerCase().trim();
  // Deny list checked first — this is what prevents Newegg from slipping through
  for (const denied of DENIED_RETAILERS) {
    if (s.includes(denied)) return { ok: false, reason: `Retailer not accepted: ${source}` };
  }
  // Allow list
  for (const allowed of ALLOWED_RETAILERS) {
    if (s.includes(allowed)) return { ok: true };
  }
  return { ok: false, reason: `Retailer unlisted: ${source}` };
}

function displayRetailer(source) {
  const s = (source || '').toLowerCase();
  if (s.includes('amazon'))       return 'Amazon';
  if (s.includes('best buy'))     return 'Best Buy';
  if (s.includes('b&h') || s.includes('bhphoto')) return 'B&H Photo';
  if (s.includes('adorama'))      return 'Adorama';
  if (s.includes('costco'))       return 'Costco';
  if (s.includes('micro center')) return 'Micro Center';
  if (s.includes('antonline'))    return 'Antonline';
  return source;
}

// ─── FILTER PIPELINE ─────────────────────────────────────────────────────────
// Returns { pass: true, drive: {...} } or { pass: false, reason, title, ... }

function filterResult({ title, source, price, url, asin, isAmazonEngine }) {
  // 1. Retailer (Google Shopping only — Amazon engine results are implicitly Amazon)
  if (!isAmazonEngine) {
    const r = classifyRetailer(source);
    if (!r.ok) return { pass: false, reason: r.reason, title, retailer: source, price, url };
  }

  // 2. SMR / SSD denylist
  for (const { re, label } of SMR_PATTERNS) {
    if (re.test(title)) return { pass: false, reason: `SMR/SSD: ${label}`, title, retailer: source, price, url };
  }

  // 3. Condition keyword scan
  const lower = (title || '').toLowerCase();
  for (const kw of CONDITION_KEYWORDS) {
    if (lower.includes(kw)) return { pass: false, reason: `Condition keyword: "${kw}"`, title, retailer: source, price, url };
  }

  // 4. Capacity extraction
  const capacityTB = extractCapacityTB(title);
  if (!capacityTB) return { pass: false, reason: 'No capacity detected in title', title, retailer: source, price, url };

  // 5. Price sanity
  if (!price || price < MIN_PRICE_USD || price > MAX_PRICE_USD) {
    return { pass: false, reason: `Price out of range: $${price}`, title, retailer: source, price, url };
  }

  // ── PASS ──────────────────────────────────────────────────────────────────
  const { brand, model } = identifyModel(title);

  // Reject unrecognized models — prevents NAS enclosures, accessories, and
  // mystery items from slipping through on capacity + price alone.
  if (brand === 'Unknown') {
    return { pass: false, reason: 'Unrecognized drive model', title, retailer: source, price, url };
  }

  const retailer = isAmazonEngine ? 'Amazon' : displayRetailer(source);
  const pricePerTB = +(price / capacityTB).toFixed(2);

  // Reject impossibly cheap $/TB — catches enclosures, bundles, and data errors
  // like the 64TB listing at $3.12/TB that appeared in the first live run.
  if (pricePerTB < MIN_PRICE_PER_TB) {
    return { pass: false, reason: `$/TB too low to be a bare drive: $${pricePerTB}/TB`, title, retailer: source, price, url };
  }
  const shortBrand = brand === 'Western Digital' ? 'WD' : brand;

  return {
    pass: true,
    drive: {
      name:       `${shortBrand} ${model} ${capacityTB}TB`,
      brand,
      model,
      capacity:   capacityTB,
      price,
      pricePerTB,
      retailer,
      url,
      asin:       asin || null,
      source:     isAmazonEngine ? 'amazon_engine' : 'google_shopping',
    }
  };
}

// ─── DEDUPLICATION ────────────────────────────────────────────────────────────
// Per retailer + model + capacity, keep the lowest price seen in this run.
function deduplicateDrives(drives) {
  const map = new Map();
  for (const d of drives) {
    const key = `${d.retailer}|${d.model}|${d.capacity}`;
    if (!map.has(key) || d.price < map.get(key).price) {
      map.set(key, d);
    }
  }
  return [...map.values()];
}

// ─── SERPAPI ──────────────────────────────────────────────────────────────────
async function serpGet(params) {
  const u = new URL('https://serpapi.com/search.json');
  Object.entries({ ...params, api_key: SERP_API_KEY }).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await fetch(u.toString());
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function checkCredits() {
  const res = await fetch(`https://serpapi.com/account.json?api_key=${SERP_API_KEY}`);
  if (!res.ok) throw new Error(`Account check HTTP ${res.status}`);
  const d = await res.json();
  // plan_searches_left = credits remaining this month
  return {
    remaining: d.plan_searches_left ?? d.searches_per_month,
    used:      d.this_month_usage ?? 0,
  };
}

// ─── EMAIL ────────────────────────────────────────────────────────────────────
async function sendEmail({ drives, runStatus, today }) {
  const top = drives.slice(0, 5);
  const isPartial = runStatus.partial;
  const best = drives[0];
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  let subject;
  if (isPartial)  subject = `⚠️ NAS Tracker (Partial Data) · ${dateStr}`;
  else if (best)  subject = `NAS Tracker · Best $${best.pricePerTB.toFixed(2)}/TB · ${dateStr}`;
  else            subject = `NAS Tracker · No drives found · ${dateStr}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
</head>
<body bgcolor="#030712" style="margin:0;padding:0;background:#030712;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#030712" style="background:#030712;">
  <tr><td align="center" style="padding:24px 16px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">

    <!-- Header -->
    <tr><td align="center" style="padding:16px 0 20px;background:#030712;">
      <div style="font-size:28px;margin-bottom:6px;">🖴</div>
      <div style="font-size:20px;font-weight:800;color:#f1f5f9;">NAS Drive Tracker</div>
      <div style="font-size:13px;color:#64748b;margin-top:4px;">${dateStr} · ${drives.length} drive${drives.length !== 1 ? 's' : ''} tracked</div>
    </td></tr>

    ${isPartial ? `
    <!-- Partial warning -->
    <tr><td style="padding:0 0 16px;">
      <table width="100%" cellpadding="12" cellspacing="0" style="background:#431407;border:1px solid #7c2d12;border-radius:8px;">
        <tr><td>
          <div style="font-weight:700;color:#fb923c;">⚠️ Partial data this run</div>
          <div style="font-size:13px;color:#fdba74;margin-top:4px;">${runStatus.queriesCompleted} of ${runStatus.queriesPlanned} queries completed. Some brands may be missing. ${runStatus.creditsRemaining} credits remaining.</div>
        </td></tr>
      </table>
    </td></tr>` : ''}

    <!-- Section label -->
    <tr><td style="padding:0 0 10px;">
      <div style="font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:1.5px;">Top Deals by $/TB</div>
    </td></tr>

    <!-- Drive cards -->
    ${top.length === 0
      ? `<tr><td style="text-align:center;padding:32px;color:#64748b;background:#0f172a;border:1px solid #1e293b;border-radius:10px;">No drives passed filters this run.</td></tr>`
      : top.map((d, i) => `
    <tr><td style="padding:0 0 10px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;">
        <tr><td style="padding:16px;">
          <!-- Top row: rank + retailer badge -->
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:11px;font-weight:700;color:#475569;letter-spacing:1px;text-transform:uppercase;">#${i + 1}</td>
              <td align="right"><span style="background:#1e3a5f;color:#93c5fd;font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;">${d.retailer}</span></td>
            </tr>
          </table>
          <!-- Drive name -->
          <div style="font-size:16px;font-weight:700;color:#f1f5f9;margin:8px 0 10px;">${d.name}</div>
          <!-- Price row -->
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td valign="bottom">
                <span style="font-size:30px;font-weight:800;color:#22c55e;">$${d.pricePerTB.toFixed(2)}</span>
                <span style="font-size:13px;color:#64748b;">/TB</span>
              </td>
              <td align="right" valign="bottom">
                <div style="font-size:18px;font-weight:700;color:#f1f5f9;">$${d.price.toFixed(2)}</div>
                <div style="font-size:12px;color:#64748b;">${d.capacity}TB drive</div>
              </td>
            </tr>
          </table>
          <!-- Buy button -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
            <tr><td align="center" bgcolor="#1d4ed8" style="background:#1d4ed8;border-radius:6px;">
              <a href="${d.url}" style="display:block;padding:11px 16px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">Buy Now →</a>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>`).join('')}

    <!-- Links row -->
    <tr><td style="padding:6px 0 0;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="49%" bgcolor="#0f172a" style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;">
            <a href="${SITE_URL}" style="display:block;padding:12px 8px;font-size:13px;font-weight:600;color:#cbd5e1;text-decoration:none;text-align:center;">📊 Full Dashboard</a>
          </td>
          <td width="2%"></td>
          <td width="49%" bgcolor="#0f172a" style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;">
            <a href="${SITE_URL}skipped.html" style="display:block;padding:12px 8px;font-size:13px;font-weight:600;color:#cbd5e1;text-decoration:none;text-align:center;">🔍 Skipped Items</a>
          </td>
        </tr>
      </table>
    </td></tr>

    <!-- Footer -->
    <tr><td align="center" style="padding:16px 0 0;">
      <div style="font-size:11px;color:#334155;">${runStatus.creditsRemaining} SerpAPI credits remaining · v${VERSION}</div>
    </td></tr>

  </table>
  </td></tr>
</table>
</body>
</html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'NAS Tracker <onboarding@resend.dev>',
      // NOTE: Once you verify a domain at resend.com/domains, replace the line
      // above with: from: 'NAS Tracker <tracker@yourdomain.com>'
      to: [ALERT_EMAIL],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error: ${err}`);
  }
  log(`✉  Email sent · "${subject}"`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = new Date();
  const today     = startTime.toISOString().split('T')[0];

  console.log(`\n${'='.repeat(60)}`);
  console.log(` NAS Drive Price Tracker  v${VERSION}`);
  console.log(` ${startTime.toISOString()}`);
  console.log(`${'='.repeat(60)}\n`);

  const errors          = [];
  const rawArchive      = {};       // Saved to data/raw/YYYY-MM-DD.json verbatim
  const acceptedDrives  = [];
  const skippedItems    = [];
  let   queriesCompleted = 0;
  let   creditsRemaining = '?';

  // ── Load existing data ────────────────────────────────────────────────────
  const existing = loadJson(PRICES_F, { history: [], skipped: [], dealsLog: [], drives: [] });
  const history  = existing.history  || [];
  const dealsLog = existing.dealsLog || [];

  // Track first-seen dates so we can badge new drives
  const firstSeenMap = {};
  (existing.drives || []).forEach(d => {
    if (d.firstSeen) firstSeenMap[`${d.model}|${d.capacity}`] = d.firstSeen;
  });
  log(`Existing: ${history.length} history entries, ${dealsLog.length} deal log entries`);

  // ── Credit pre-check ─────────────────────────────────────────────────────
  log('\nChecking SerpAPI credits…');
  try {
    const credits = await checkCredits();
    creditsRemaining = credits.remaining;
    log(`Credits: ${credits.remaining} remaining (${credits.used} used this month)`);

    if (credits.remaining < MIN_CREDITS_REQUIRED) {
      log(`✗ Insufficient credits (${credits.remaining} < ${MIN_CREDITS_REQUIRED} required). Aborting.`);
      await sendLowCreditEmail(credits.remaining);
      process.exit(0);
    }
  } catch (e) {
    log(`⚠  Credit check failed: ${e.message} — proceeding cautiously`);
    errors.push(`Credit check failed: ${e.message}`);
  }

  // ── Google Shopping queries ───────────────────────────────────────────────
  for (const query of GOOGLE_QUERIES) {
    log(`\n[Google Shopping] "${query}"`);
    await sleep(QUERY_DELAY_MS);
    try {
      const data    = await serpGet({ engine: 'google_shopping', q: query, gl: 'us', hl: 'en', num: '40' });
      rawArchive[`google::${query}`] = data;
      const results = data.shopping_results || [];
      log(`  → ${results.length} raw results`);

      for (const item of results) {
        const title  = item.title || '';
        const source = item.source || item.seller || '';
        const price  = extractPrice(item);
        const url    = item.link || '';

        const r = filterResult({ title, source, price, url, isAmazonEngine: false });
        if (r.pass) {
          log(`  ✓  ${r.drive.name} — $${r.drive.price} ($${r.drive.pricePerTB}/TB) at ${r.drive.retailer}`);
          acceptedDrives.push(r.drive);
        } else {
          log(`  ✗  [${r.reason}] ${title.slice(0, 80)}`);
          skippedItems.push({ ...r, timestamp: startTime.toISOString(), query, engine: 'google_shopping' });
        }
      }
      queriesCompleted++;
    } catch (e) {
      const msg = `Google "${query}" failed: ${e.message}`;
      log(`  ✗  ${msg}`);
      errors.push(msg);
      if (e.message.includes('run out of searches')) {
        log('  → Out of credits. Stopping all queries.');
        break;
      }
    }
  }

  // ── Amazon engine queries ─────────────────────────────────────────────────
  for (const query of AMAZON_QUERIES) {
    log(`\n[Amazon Engine] "${query}"`);
    await sleep(QUERY_DELAY_MS);
    try {
      // rh param applies Amazon's own new-condition filter server-side
      const data    = await serpGet({
        engine:        'amazon',
        k:             query,
        amazon_domain: 'amazon.com',
        rh:            'p_n_condition-type:2224371011',
        language:      'en_US',
      });
      rawArchive[`amazon::${query}`] = data;
      const results = data.organic_results || [];
      log(`  → ${results.length} raw results`);

      for (const item of results) {
        const title = item.title || '';
        const price = extractPrice(item);
        const url   = item.link_clean || item.link || '';
        const asin  = item.asin || null;

        const r = filterResult({ title, source: 'Amazon', price, url, asin, isAmazonEngine: true });
        if (r.pass) {
          log(`  ✓  ${r.drive.name} — $${r.drive.price} ($${r.drive.pricePerTB}/TB) at Amazon`);
          acceptedDrives.push(r.drive);
        } else {
          log(`  ✗  [${r.reason}] ${title.slice(0, 80)}`);
          skippedItems.push({ ...r, timestamp: startTime.toISOString(), query, engine: 'amazon' });
        }
      }
      queriesCompleted++;
    } catch (e) {
      const msg = `Amazon "${query}" failed: ${e.message}`;
      log(`  ✗  ${msg}`);
      errors.push(msg);
      if (e.message.includes('run out of searches')) {
        log('  → Out of credits. Stopping all queries.');
        break;
      }
    }
  }

  // ── Archive raw API responses ─────────────────────────────────────────────
  const rawFile = path.join(RAW_DIR, `${today}.json`);
  fs.writeFileSync(rawFile, JSON.stringify({ timestamp: startTime.toISOString(), rawArchive }, null, 2));
  log(`\n✓  Raw responses archived → data/raw/${today}.json`);

  // Update credits to reflect what was actually spent in this run
  if (typeof creditsRemaining === 'number') {
    creditsRemaining = Math.max(0, creditsRemaining - queriesCompleted);
  }

  // ── Deduplicate and sort ──────────────────────────────────────────────────
  const deduped = deduplicateDrives(acceptedDrives);
  const sorted  = deduped
    .sort((a, b) => a.pricePerTB - b.pricePerTB)
    .slice(0, MAX_DRIVES_DISPLAY);

  // Stamp firstSeen date
  sorted.forEach(d => {
    const key = `${d.model}|${d.capacity}`;
    d.firstSeen = firstSeenMap[key] || today;
  });

  // ── Update history ────────────────────────────────────────────────────────
  const todayEntry = {
    date:           today,
    bestPricePerTB: sorted.length ? sorted[0].pricePerTB : null,
    bestDriveName:  sorted.length ? sorted[0].name       : null,
    bestRetailer:   sorted.length ? sorted[0].retailer   : null,
    avgPricePerTB:  sorted.length
      ? +(sorted.reduce((s, d) => s + d.pricePerTB, 0) / sorted.length).toFixed(2)
      : null,
    driveCount:    sorted.length,
  };
  const updatedHistory = [todayEntry, ...history.filter(h => h.date !== today)].slice(0, 30);

  // ── Run status ────────────────────────────────────────────────────────────
  const runStatus = {
    queriesPlanned:    TOTAL_QUERIES,
    queriesCompleted,
    partial:           queriesCompleted < TOTAL_QUERIES,
    creditsRemaining,
    errors,
    timestamp:         startTime.toISOString(),
  };

  // ── Write prices.json ─────────────────────────────────────────────────────
  const output = {
    version:   VERSION,
    updatedAt: startTime.toISOString(),
    runStatus,
    drives:    sorted,
    history:   updatedHistory,
    skipped:   skippedItems,
    dealsLog,
  };
  fs.writeFileSync(PRICES_F, JSON.stringify(output, null, 2));

  // ── Append to run log ─────────────────────────────────────────────────────
  const skipCounts = {};
  skippedItems.forEach(s => {
    const k = (s.reason || 'unknown').split(':')[0].trim();
    skipCounts[k] = (skipCounts[k] || 0) + 1;
  });
  const runLogEntry = {
    timestamp: startTime.toISOString(),
    version:   VERSION,
    ...runStatus,
    drivesAccepted: sorted.length,
    drivesSkipped:  skippedItems.length,
    skipReasons:    skipCounts,
  };
  const runLog = loadJson(RUNLOG_F, []);
  runLog.unshift(runLogEntry);
  fs.writeFileSync(RUNLOG_F, JSON.stringify(runLog.slice(0, 60), null, 2));

  console.log(`\n${'─'.repeat(60)}`);
  log(`Drives accepted : ${sorted.length}`);
  log(`Drives skipped  : ${skippedItems.length}`);
  log(`Queries         : ${queriesCompleted}/${TOTAL_QUERIES} completed${runStatus.partial ? ' ⚠ PARTIAL' : ''}`);
  if (sorted.length) log(`Best deal       : ${sorted[0].name} @ $${sorted[0].pricePerTB.toFixed(2)}/TB from ${sorted[0].retailer}`);
  log(`prices.json     : written ✓`);
  log(`run-log.json    : written ✓`);

  // ── Send email ────────────────────────────────────────────────────────────
  try {
    await sendEmail({ drives: sorted, runStatus, today });
  } catch (e) {
    log(`✗  Email failed: ${e.message}`);
    errors.push(`Email: ${e.message}`);
  }

  console.log(`\n${'='.repeat(60)}\n`);
}

async function sendLowCreditEmail(remaining) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'NAS Tracker <onboarding@resend.dev>',
        to: [ALERT_EMAIL],
        subject: '⚠️ NAS Tracker — Low SerpAPI Credits, Run Skipped',
        html: `<p style="font-family:sans-serif;">NAS Tracker skipped today's run: only <strong>${remaining}</strong> SerpAPI credits remaining (minimum required: ${MIN_CREDITS_REQUIRED}).</p><p style="font-family:sans-serif;">Credits reset on the 1st of each calendar month.</p>`,
      }),
    });
    log('✉  Low-credit warning email sent');
  } catch (e) {
    log(`✗  Could not send low-credit email: ${e.message}`);
  }
}

main().catch(e => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
