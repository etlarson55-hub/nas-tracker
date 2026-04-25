// fetch-prices.js
// Runs server-side in GitHub Actions — fetches CMR NAS drive prices via SerpAPI,
// records daily #1 deal, maintains price history, and sends a daily email via EmailJS.
// CommonJS — no npm install needed. Uses Node.js built-in fetch.

const VERSION = "8.0.0";

const { writeFileSync, readFileSync, existsSync } = require("fs");

const SERP_API_KEY = process.env.SERP_API_KEY;

if (!SERP_API_KEY) {
  console.error("ERROR: SERP_API_KEY environment variable is not set.");
  process.exit(1);
}

// ── CMR-only Google Shopping search queries ──────────────────────────────────
const SEARCHES = [
  { q: "WD Red Plus NAS internal hard drive",             brand: "Western Digital", model: "Red Plus"     },
  { q: "WD Red Pro NAS internal hard drive",              brand: "Western Digital", model: "Red Pro"      },
  { q: "WD Gold enterprise NAS internal hard drive",      brand: "Western Digital", model: "Gold"         },
  { q: "Seagate IronWolf NAS internal hard drive",        brand: "Seagate",        model: "IronWolf"     },
  { q: "Seagate IronWolf Pro NAS internal hard drive",    brand: "Seagate",        model: "IronWolf Pro" },
  { q: "Seagate Exos enterprise internal hard drive",     brand: "Seagate",        model: "Exos"         },
  { q: "Toshiba N300 NAS internal hard drive",            brand: "Toshiba",        model: "N300"         },
  { q: "Toshiba MG enterprise NAS internal hard drive",   brand: "Toshiba",        model: "MG"           },
];

// ── Amazon-specific searches (separate engine) ───────────────────────────────
// Amazon does not participate in Google Shopping, so we query SerpAPI's
// Amazon engine directly to get Amazon results.
const AMAZON_SEARCHES = [
  { q: "WD Red Plus NAS internal hard drive CMR",         brand: "Western Digital", model: "Red Plus"     },
  { q: "WD Red Pro NAS internal hard drive",              brand: "Western Digital", model: "Red Pro"      },
  { q: "WD Gold enterprise hard drive",                   brand: "Western Digital", model: "Gold"         },
  { q: "Seagate IronWolf NAS internal hard drive",        brand: "Seagate",        model: "IronWolf"     },
  { q: "Seagate IronWolf Pro NAS hard drive",             brand: "Seagate",        model: "IronWolf Pro" },
  { q: "Seagate Exos enterprise internal hard drive",     brand: "Seagate",        model: "Exos"         },
  { q: "Toshiba N300 NAS internal hard drive",            brand: "Toshiba",        model: "N300"         },
  { q: "Toshiba MG enterprise internal hard drive",       brand: "Toshiba",        model: "MG"           },
];

// ── Condition denylist ────────────────────────────────────────────────────────
// Checked against title, condition field, URL, snippet, and extensions.
const CONDITION_REJECT = [
  /\bused\b/i,
  /\brefurbished\b/i,
  /\brefurb\b/i,
  /\brecertified\b/i,
  /\brenewed\b/i,
  /\bopen[\s-]?box\b/i,
  /\bpre[\s-]?owned\b/i,
  /\bpull(ed)?\b/i,
  /\bremanufactured\b/i,
  /\bcertified[\s-]?refurb/i,
  /\bsurplus\b/i,
  /\bsecond[\s-]?hand\b/i,
  /\bwarehouse[\s-]?deal/i,
  /\bas[\s-]?is\b/i,
  /\bfor[\s-]?parts\b/i,
];

const URL_REJECT = [
  /open-box/i, /openbox/i, /renewed/i, /refurb/i,
  /recertified/i, /\/used\//i, /warehouse/i, /outlet/i,
];

function isUsedOrRefurb(item) {
  const title     = item.title       || "";
  const condition = item.condition   || "";
  const snippet   = item.snippet     || item.description || "";
  const exts      = Array.isArray(item.extensions) ? item.extensions.join(" ") : "";
  const source    = item.source      || "";  // catches "B&H Used Store", "Amazon Warehouse", etc.
  const url       = item.link        || item.product_link || item.url || "";
  const combined  = `${title} ${condition} ${snippet} ${exts} ${source}`;
  if (CONDITION_REJECT.some(re => re.test(combined))) return true;
  if (URL_REJECT.some(re => re.test(url)))            return true;
  if (condition && condition.toLowerCase() !== "new")  return true;
  return false;
}

// ── SMR denylist ──────────────────────────────────────────────────────────────
const SMR_PATTERNS = [
  /\bwd\s+red\b(?!\s+(plus|pro))/i,
  /\bwd\s+elements\b/i,
  /\bwd\s+easystore\b/i,
  /\bseagate\s+expansion\b/i,
  /\bseagate\s+barracuda\b/i,
  /\bseagate\s+basic\b/i,
  /\bmy\s+passport\b/i,
  /\bmy\s+book\b/i,
  /\bbackup\s+plus\b/i,
];

function isSMR(title) {
  return SMR_PATTERNS.some(re => re.test(title));
}

// ── Trusted retailers (Google Shopping) ──────────────────────────────────────
// Walmart excluded: their marketplace makes it impossible to guarantee new condition.
// Amazon is handled via dedicated Amazon engine searches above.
const TRUSTED_RETAILERS = [
  "newegg", "best buy", "bestbuy", "b&h", "bhphoto",
  "adorama", "costco", "micro center", "microcenter", "antonline",
];

function isTrusted(source) {
  return TRUSTED_RETAILERS.some(r => (source || "").toLowerCase().includes(r));
}

function extractCapTB(title) {
  const m = title.match(/(\d+)\s*TB/i);
  if (m) {
    const tb = parseInt(m[1]);
    return (tb >= 2 && tb <= 32) ? tb : null;
  }
  const g = title.match(/(\d{4,5})\s*GB/i);
  if (g) {
    const tb = Math.round(parseInt(g[1]) / 1000);
    return (tb >= 2 && tb <= 32) ? tb : null;
  }
  return null;
}

function retailerLabel(source) {
  const s = (source || "").toLowerCase();
  if (s.includes("amazon"))                                    return "Amazon";
  if (s.includes("newegg"))                                    return "Newegg";
  if (s.includes("best buy") || s.includes("bestbuy"))         return "Best Buy";
  if (s.includes("b&h") || s.includes("bhphoto"))              return "B&H";
  if (s.includes("adorama"))                                   return "Adorama";
  if (s.includes("walmart"))                                   return "Walmart";
  if (s.includes("costco"))                                    return "Costco";
  if (s.includes("micro center") || s.includes("microcenter")) return "Micro Center";
  if (s.includes("antonline"))                                 return "Antonline";
  return source || "Unknown";
}

function cleanName(brand, model, cap) {
  const bAbbr = brand === "Western Digital" ? "WD" : brand;
  return `${bAbbr} ${model} ${cap}TB`;
}

// ── SerpAPI helpers ───────────────────────────────────────────────────────────
async function searchGoogleShopping(query) {
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(query)}&api_key=${SERP_API_KEY}&num=40`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = await res.json();
  return data.shopping_results || [];
}

async function searchAmazon(query) {
  const url = `https://serpapi.com/search.json?engine=amazon&k=${encodeURIComponent(query)}&api_key=${SERP_API_KEY}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`SerpAPI Amazon HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = await res.json();
  // Normalize Amazon results to match Google Shopping shape
  return (data.organic_results || []).map(r => ({
    title:     r.title || "",
    price:     r.price?.raw || r.price?.current_price || (typeof r.price === "string" ? r.price : ""),
    source:    "Amazon",
    link:      r.link || r.url || "",
    rating:    r.rating,
    reviews:   r.reviews_count || r.ratings_count,
    condition: (r.badge || "").toLowerCase().includes("refurb") ? "refurbished" : "",
    snippet:   r.snippet || "",
    extensions: r.extensions || [],
  }));
}

// ── Item processor (shared by both engines) ───────────────────────────────────
function processItems(items, search, seen, drives, skipped, isAmazon) {
  for (const item of items) {
    const title    = item.title || "";
    const url      = item.link || item.product_link || item.url || "";
    const retailer = isAmazon ? "Amazon" : retailerLabel(item.source);

    // Hard rejects — don't surface to review page
    if (isSMR(title)) {
      console.log(`  [SMR skip] ${title}`);
      continue;
    }
    if (isUsedOrRefurb(item)) {
      console.log(`  [Used/Refurb skip] condition="${item.condition || "none"}" — ${title}`);
      continue;
    }

    // Retailer check (Google only — Amazon items always pass)
    if (!isAmazon && !isTrusted(item.source)) {
      const cap      = extractCapTB(title);
      const rawPrice = (item.price || "").toString().replace(/[^0-9.]/g, "");
      const price    = parseFloat(rawPrice) || null;
      console.log(`  [Retailer skip] ${item.source || "unknown"} — ${title}`);
      // Collect for review page if it has a real price and capacity
      if (cap && price && price >= 20 && price <= 3000) {
        skipped.push({
          skipReason: "retailer", title,
          retailer:  item.source || "Unknown", url,
          capacity: cap, price,
          pricePerTB: parseFloat((price / cap).toFixed(2)),
          brand: search.brand, model: search.model,
        });
      }
      continue;
    }

    // Capacity
    const cap = extractCapTB(title);
    if (!cap) {
      const rawPrice = (item.price || "").toString().replace(/[^0-9.]/g, "");
      const price    = parseFloat(rawPrice) || null;
      console.log(`  [No TB] ${title}`);
      if (price && price >= 20 && price <= 3000) {
        skipped.push({
          skipReason: "noTB", title,
          retailer, url,
          capacity: null, price, pricePerTB: null,
          brand: search.brand, model: search.model,
        });
      }
      continue;
    }

    // Price
    const rawPrice = (item.price || "").toString().replace(/[^0-9.]/g, "");
    const price    = parseFloat(rawPrice) || null;
    if (!price || price < 20 || price > 3000) {
      console.log(`  [Bad price] $${item.price} — ${title}`);
      continue;
    }

    const ptb = price / cap;
    if (ptb > 150) {
      console.log(`  [Bad $/TB ${ptb.toFixed(2)}] ${title}`);
      continue;
    }

    const name = cleanName(search.brand, search.model, cap);
    const key  = `${search.model}-${cap}-${retailer}`;
    if (seen.has(key)) {
      const existing = drives.find(d => `${d.model}-${d.capacity}-${d.retailer}` === key);
      if (existing && price < existing.price) {
        existing.price      = parseFloat(price.toFixed(2));
        existing.pricePerTB = parseFloat(ptb.toFixed(2));
        existing.url        = url || existing.url;
      }
      continue;
    }
    seen.add(key);

    drives.push({
      name, brand: search.brand, model: search.model,
      capacity: cap,
      price:      parseFloat(price.toFixed(2)),
      pricePerTB: parseFloat(ptb.toFixed(2)),
      retailer, url,
      rating:  item.rating  || null,
      reviews: item.reviews || null,
    });
    console.log(`  ✓ ${name} — $${price} ($${ptb.toFixed(2)}/TB) at ${retailer}`);
  }
}

// ── Main fetch orchestrator ───────────────────────────────────────────────────
async function fetchAllDrives() {
  const seen    = new Set();
  const drives  = [];
  const skipped = [];

  for (const search of SEARCHES) {
    console.log(`\n[Google] Searching: "${search.q}"`);
    try {
      const items = await searchGoogleShopping(search.q);
      console.log(`  → ${items.length} raw results`);
      processItems(items, search, seen, drives, skipped, false);
    } catch (e) { console.error(`  ✗ ${e.message}`); }
    await new Promise(r => setTimeout(r, 500));
  }

  for (const search of AMAZON_SEARCHES) {
    console.log(`\n[Amazon] Searching: "${search.q}"`);
    try {
      const items = await searchAmazon(search.q);
      console.log(`  → ${items.length} raw Amazon results`);
      processItems(items, search, seen, drives, skipped, true);
    } catch (e) { console.error(`  ✗ Amazon: ${e.message}`); }
    await new Promise(r => setTimeout(r, 500));
  }

  drives.sort((a, b) => a.pricePerTB - b.pricePerTB);
  return { drives, skipped };
}

// ── Email builder ─────────────────────────────────────────────────────────────
function buildEmailHTML(drives, history, dealsLog) {
  if (!drives.length) return "<p>No drive data available.</p>";
  const best   = drives[0];
  const avg    = drives.reduce((s, d) => s + d.pricePerTB, 0) / drives.length;
  const top3   = drives.slice(0, 3);
  const recent = history.slice(0, 5);
  let trendDir = "stable", trendPct = 0;
  if (recent.length >= 2) {
    const newest = recent[0].avgPricePerTB;
    const oldest = recent[recent.length - 1].avgPricePerTB;
    trendPct = Math.abs(((newest - oldest) / oldest) * 100);
    trendDir = newest < oldest ? "falling" : newest > oldest ? "rising" : "stable";
  }
  const tc = trendDir === "falling" ? "#10b981" : trendDir === "rising" ? "#ef4444" : "#94a3b8";
  const tl = trendDir === "falling" ? `▼ Down ${trendPct.toFixed(1)}%` : trendDir === "rising" ? `▲ Up ${trendPct.toFixed(1)}%` : "→ Stable";
  const hotDeals = drives.filter(d => d.pricePerTB / avg <= 0.85);
  const dealSec = hotDeals.length ? `
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;margin-bottom:20px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#15803d;font-weight:600;margin-bottom:10px">
        🔥 Deal Alert — ${hotDeals.length} drive${hotDeals.length > 1 ? "s" : ""} significantly below market average
      </div>
      ${hotDeals.map(d => `<div style="margin-bottom:8px;font-size:13px">
        <strong style="color:#15803d">${d.name}</strong> — $${d.price} (<strong>$${d.pricePerTB.toFixed(2)}/TB</strong>) at ${d.retailer}
        ${d.url ? ` &mdash; <a href="${d.url}" style="color:#15803d;font-weight:500">View deal →</a>` : ""}</div>`).join("")}
    </div>` : "";
  const dCard = (d, hi) => `
    <div style="border:1px solid ${hi?"#3b82f6":"#e2e8f0"};border-radius:10px;padding:14px;margin-bottom:10px;background:${hi?"#eff6ff":"#fff"}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;color:#1e293b;font-size:14px">${hi?"🏆 ":""}${d.name}</div>
          <div style="font-size:12px;color:#64748b;margin-top:3px">${d.capacity}TB · ${d.retailer} · CMR</div>
        </div>
        <div style="text-align:right;margin-left:12px;white-space:nowrap">
          <div style="font-size:20px;font-weight:700;color:${hi?"#3b82f6":"#1e293b"}">$${d.pricePerTB.toFixed(2)}<span style="font-size:12px;font-weight:400;color:#64748b">/TB</span></div>
          <div style="font-size:12px;color:#64748b">$${d.price} total</div>
        </div>
      </div>
      ${d.url?`<div style="margin-top:10px"><a href="${d.url}" style="background:#3b82f6;color:#fff;padding:7px 16px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:500;display:inline-block">View Deal →</a></div>`:""}
    </div>`;
  const histRows = recent.map(s=>`<tr><td style="padding:6px 8px;color:#64748b;font-size:12px">${new Date(s.date+"T12:00:00Z").toLocaleDateString("en-US",{month:"short",day:"numeric"})}</td><td style="padding:6px 8px;text-align:right;font-weight:500;color:#1e293b;font-size:12px">$${s.avgPricePerTB.toFixed(2)}/TB avg</td></tr>`).join("");
  const today = new Date().toLocaleDateString("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"});
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:580px;margin:0 auto;padding:20px 10px">
  <div style="background:#0f172a;border-radius:12px 12px 0 0;padding:22px 28px">
    <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;margin-bottom:5px">NAS Drive Price Tracker</div>
    <div style="font-size:20px;font-weight:600;color:#f1f5f9;letter-spacing:-.3px">Daily Price Update</div>
    <div style="font-size:12px;color:#64748b;margin-top:4px">${today} · CMR drives only</div>
  </div>
  <div style="background:#1e293b;padding:14px 28px;display:flex;gap:0">
    <div style="flex:1;border-right:1px solid #334155;padding-right:16px">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px">Best $/TB today</div>
      <div style="font-size:22px;font-weight:700;color:#f1f5f9">$${best.pricePerTB.toFixed(2)}</div>
      <div style="font-size:11px;color:#64748b;margin-top:2px">${best.name}</div>
    </div>
    <div style="flex:1;padding:0 16px;border-right:1px solid #334155">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px">Market avg $/TB</div>
      <div style="font-size:22px;font-weight:700;color:#f1f5f9">$${avg.toFixed(2)}</div>
      <div style="font-size:11px;color:#64748b;margin-top:2px">${drives.length} drives tracked</div>
    </div>
    <div style="flex:1;padding-left:16px">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px">Trend</div>
      <div style="font-size:18px;font-weight:700;color:${tc}">${trendDir.charAt(0).toUpperCase()+trendDir.slice(1)}</div>
      <div style="font-size:11px;color:${tc};margin-top:2px;font-weight:500">${tl}</div>
    </div>
  </div>
  <div style="background:#fff;border-radius:0 0 12px 12px;padding:22px 28px;border:1px solid #e2e8f0;border-top:none">
    ${dealSec}
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:12px;font-weight:500">Top 3 Best Value CMR Drives Today</div>
    ${top3.map((d,i)=>dCard(d,i===0)).join("")}
    ${recent.length>=2?`<div style="margin-top:20px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:12px;font-weight:500">Recent Price History</div>
      <div style="border:1px solid #e2e8f0;border-radius:10px;padding:16px">
        <table style="width:100%;border-collapse:collapse">${histRows}</table>
        <div style="font-size:11px;color:${tc};font-weight:500;text-align:right;margin-top:8px">${trendDir==="falling"?"↓ Market trending down":trendDir==="rising"?"↑ Market trending up":"→ Prices stable"}</div>
      </div></div>`:""}
    <div style="border-top:1px solid #f1f5f9;padding-top:16px;margin-top:20px">
      <p style="font-size:11px;color:#94a3b8;line-height:1.8;margin:0">CMR only · new condition · trusted retailers · v${VERSION}<br>Always confirm price on retailer's page before purchasing.</p>
    </div>
  </div>
</div></body></html>`;
}

// ── Send email via EmailJS REST API ──────────────────────────────────────────
async function sendEmail(drives, history, dealsLog) {
  const ejsKey = process.env.EJS_PUBLIC_KEY;
  const ejsSvc = process.env.EJS_SERVICE_ID;
  const ejsTpl = process.env.EJS_TEMPLATE_ID;
  const ejsTo  = process.env.ALERT_EMAIL;
  if (!ejsKey || !ejsSvc || !ejsTpl || !ejsTo) { console.log("Email skipped: EmailJS secrets not set."); return; }
  if (!drives.length) { console.log("Email skipped: no drives."); return; }
  const best    = drives[0];
  const subject = `NAS Drive Update · Best: $${best.pricePerTB.toFixed(2)}/TB · ${new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"})}`;
  const html    = buildEmailHTML(drives, history, dealsLog);
  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: ejsSvc, template_id: ejsTpl, user_id: ejsKey,
      template_params: { to_email: ejsTo, subject, html_body: html },
    }),
  });
  if (!res.ok) throw new Error(`EmailJS error ${res.status}: ${(await res.text().catch(()=>"")).slice(0,300)}`);
  console.log(`✉ Email sent to ${ejsTo}`);
  console.log(`  Subject: ${subject}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== NAS Drive Price Tracker — Fetch Start ===");
  console.log(`Script version: v${VERSION}`);
  console.log(`Run time: ${new Date().toISOString()}`);

  let existing = { history: [], dealsLog: [] };
  if (existsSync("data/prices.json")) {
    try {
      const json      = JSON.parse(readFileSync("data/prices.json", "utf8"));
      existing.history  = Array.isArray(json.history)  ? json.history  : [];
      existing.dealsLog = Array.isArray(json.dealsLog) ? json.dealsLog : [];
      console.log(`Loaded existing: ${existing.history.length} history, ${existing.dealsLog.length} deals`);
    } catch (e) { console.log(`Could not load prices.json (${e.message}) — starting fresh`); }
  }

  const { drives, skipped } = await fetchAllDrives();
  console.log(`\nDrives accepted: ${drives.length}  |  Skipped for review: ${skipped.length}`);

  if (!drives.length) {
    console.error("No drives returned — aborting.");
    process.exit(1);
  }

  const today         = new Date().toISOString().slice(0, 10);
  const avgPricePerTB = parseFloat((drives.reduce((s,d)=>s+d.pricePerTB,0)/drives.length).toFixed(2));

  const historyMap = new Map(existing.history.map(h => [h.date, h]));
  historyMap.set(today, { date: today, avgPricePerTB });
  const history = Array.from(historyMap.values()).sort((a,b)=>b.date.localeCompare(a.date)).slice(0, 60);

  const best = drives[0];
  const dealsMap = new Map(existing.dealsLog.map(d => [d.date, d]));
  dealsMap.set(today, { date: today, name: best.name, capacity: best.capacity, price: best.price, pricePerTB: best.pricePerTB, retailer: best.retailer, url: best.url });
  const dealsLog = Array.from(dealsMap.values()).sort((a,b)=>b.date.localeCompare(a.date)).slice(0, 30);

  const output = { version: VERSION, updatedAt: new Date().toISOString(), drives, history, dealsLog, skipped };
  writeFileSync("data/prices.json", JSON.stringify(output, null, 2));
  console.log(`\n✓ Wrote data/prices.json (v${VERSION})`);
  console.log(`  ${drives.length} drives | ${history.length} history | ${dealsLog.length} deals | ${skipped.length} in review queue`);
  console.log(`  Today's #1: ${best.name} @ $${best.pricePerTB.toFixed(2)}/TB ($${best.price}) from ${best.retailer}`);

  try { await sendEmail(drives, history, dealsLog); }
  catch (e) { console.error(`✗ Email failed: ${e.message}`); }

  console.log("\n=== Fetch Complete ===");
}

main().catch(e => { console.error("Fatal error:", e); process.exit(1); });
