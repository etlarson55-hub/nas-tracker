// fetch-prices.js
// Runs server-side in GitHub Actions — fetches CMR NAS drive prices via SerpAPI,
// records daily #1 deal, maintains price history, and sends a daily email via Resend.
// CommonJS — no npm install needed. Uses Node.js built-in fetch.

const VERSION = "4.0.0";


const { writeFileSync, readFileSync, existsSync } = require("fs");

const SERP_API_KEY = process.env.SERP_API_KEY;

if (!SERP_API_KEY) {
  console.error("ERROR: SERP_API_KEY environment variable is not set.");
  process.exit(1);
}

// ── CMR-only search queries ──────────────────────────────────────────────────
// All of these are confirmed CMR (Conventional Magnetic Recording) drive families.
// SMR drives (WD Elements, WD Easystore, Seagate Expansion, WD Red non-Plus)
// are intentionally excluded from searches.
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

// ── Condition denylist — reject used, refurb, recertified listings ───────────
const CONDITION_REJECT = [
  /\bused\b/i,
  /\brefurbished\b/i,
  /\brefurb\b/i,
  /\brecertified\b/i,
  /\brenewed\b/i,
  /\bopen[\s-]?box\b/i,
  /\bpre[\s-]?owned\b/i,
  /\bpull(ed)?\b/i,       // "server pull" / "pulled from server"
  /\bremanufactured\b/i,
  /\bcertified[\s-]?refurb/i,
  /\bsurplus\b/i,
  /\bsecond[\s-]?hand\b/i,
];

function isUsedOrRefurb(title, condition) {
  const combined = `${title} ${condition || ""}`;
  return CONDITION_REJECT.some(re => re.test(combined));
}

// ── SMR denylist — reject these even if they slip through ──────────────────
const SMR_PATTERNS = [
  /\bwd\s+red\b(?!\s+(plus|pro))/i,   // WD Red (not Plus/Pro) — SMR on smaller sizes
  /\bwd\s+elements\b/i,
  /\bwd\s+easystore\b/i,
  /\bseagate\s+expansion\b/i,
  /\bseagate\s+barracuda\b/i,
  /\bseagate\s+basic\b/i,
  /\bmy\s+passport\b/i,
  /\bmy\s+book\b/i,
  /\bbackup\s+plus\b/i,
];

// ── Trusted retailers ───────────────────────────────────────────────────────
const TRUSTED_RETAILERS = [
  "amazon", "newegg", "best buy", "bestbuy", "b&h", "bhphoto",
  "adorama", "walmart", "costco", "micro center", "microcenter", "antonline",
];

function isTrusted(source) {
  const s = (source || "").toLowerCase();
  return TRUSTED_RETAILERS.some(r => s.includes(r));
}

function isSMR(title) {
  return SMR_PATTERNS.some(re => re.test(title));
}

function extractCapTB(title) {
  const m = title.match(/(\d+)\s*TB/i);
  if (m) {
    const tb = parseInt(m[1]);
    return (tb >= 2 && tb <= 30) ? tb : null;
  }
  const g = title.match(/(\d{4,5})\s*GB/i);
  if (g) {
    const tb = Math.round(parseInt(g[1]) / 1000);
    return (tb >= 2 && tb <= 30) ? tb : null;
  }
  return null;
}

function retailerLabel(source) {
  const s = (source || "").toLowerCase();
  if (s.includes("amazon"))                         return "Amazon";
  if (s.includes("newegg"))                         return "Newegg";
  if (s.includes("best buy") || s.includes("bestbuy")) return "Best Buy";
  if (s.includes("b&h") || s.includes("bhphoto"))   return "B&H";
  if (s.includes("adorama"))                        return "Adorama";
  if (s.includes("walmart"))                        return "Walmart";
  if (s.includes("costco"))                         return "Costco";
  if (s.includes("micro center") || s.includes("microcenter")) return "Micro Center";
  if (s.includes("antonline"))                      return "Antonline";
  return source || "Unknown";
}

function cleanName(brand, model, cap) {
  const b = brand.split(" ").pop(); // "Digital" -> use last word; better: abbreviate
  const bAbbr = brand === "Western Digital" ? "WD" : brand;
  return `${bAbbr} ${model} ${cap}TB`;
}

async function searchSerpAPI(query) {
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(query)}&api_key=${SERP_API_KEY}&num=20`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SerpAPI HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.shopping_results || [];
}

async function fetchAllDrives() {
  const seen = new Set();
  const out  = [];

  for (const search of SEARCHES) {
    console.log(`\nSearching: "${search.q}"`);
    let items;
    try {
      items = await searchSerpAPI(search.q);
    } catch (e) {
      console.error(`  ✗ ${e.message}`);
      continue;
    }
    console.log(`  → ${items.length} raw results`);

    for (const item of items) {
      const title = item.title || "";

      if (isSMR(title)) {
        console.log(`  [SMR skip] ${title}`);
        continue;
      }

      if (isUsedOrRefurb(title, item.condition)) {
        console.log(`  [Used/Refurb skip] condition="${item.condition || "none"}" — ${title}`);
        continue;
      }

      if (!isTrusted(item.source)) {
        console.log(`  [Retailer skip] ${item.source || "unknown"} — ${title}`);
        continue;
      }

      const cap = extractCapTB(title);
      if (!cap) {
        console.log(`  [No TB] ${title}`);
        continue;
      }

      const rawPrice = (item.price || "").toString().replace(/[^0-9.]/g, "");
      const price    = parseFloat(rawPrice) || null;
      if (!price || price < 20 || price > 2000) {
        console.log(`  [Bad price] $${item.price} — ${title}`);
        continue;
      }

      const ptb = price / cap;
      if (ptb < 5 || ptb > 100) {
        console.log(`  [Bad $/TB ${ptb.toFixed(2)}] ${title}`);
        continue;
      }

      const retailer = retailerLabel(item.source);
      const name     = cleanName(search.brand, search.model, cap);
      // Deduplicate by model+capacity+retailer
      const key = `${search.model}-${cap}-${retailer}`;
      if (seen.has(key)) {
        // Keep the cheaper one
        const existing = out.find(d => `${d.model}-${d.capacity}-${d.retailer}` === key);
        if (existing && price < existing.price) {
          existing.price      = parseFloat(price.toFixed(2));
          existing.pricePerTB = parseFloat(ptb.toFixed(2));
          existing.url        = item.link || item.product_link || item.url || existing.url;
        }
        continue;
      }
      seen.add(key);

      out.push({
        name,
        brand:      search.brand,
        model:      search.model,
        capacity:   cap,
        price:      parseFloat(price.toFixed(2)),
        pricePerTB: parseFloat(ptb.toFixed(2)),
        retailer,
        url:        item.link || item.product_link || item.url || null,
        rating:     item.rating  || null,
        reviews:    item.reviews || null,
      });
      console.log(`  ✓ ${name} — $${price} ($${ptb.toFixed(2)}/TB) at ${retailer}`);
    }

    // Brief pause between SerpAPI calls
    await new Promise(r => setTimeout(r, 600));
  }

  out.sort((a, b) => a.pricePerTB - b.pricePerTB);
  return out;
}

// ── Email builder ────────────────────────────────────────────────────────────
function buildEmailHTML(drives, history, dealsLog) {
  if (!drives.length) return "<p>No drive data available.</p>";

  const best = drives[0];
  const avg  = drives.reduce((s, d) => s + d.pricePerTB, 0) / drives.length;
  const top3 = drives.slice(0, 3);

  // Trend: compare newest vs oldest of last 5 history entries
  const recent = history.slice(0, 5);
  let trendDir = "stable", trendPct = 0;
  if (recent.length >= 2) {
    const newest = recent[0].avgPricePerTB;
    const oldest = recent[recent.length - 1].avgPricePerTB;
    trendPct = Math.abs(((newest - oldest) / oldest) * 100);
    trendDir = newest < oldest ? "falling" : newest > oldest ? "rising" : "stable";
  }
  const trendColor = trendDir === "falling" ? "#10b981" : trendDir === "rising" ? "#ef4444" : "#94a3b8";
  const trendLabel = trendDir === "falling"
    ? `▼ Down ${trendPct.toFixed(1)}% over ${recent.length - 1} days`
    : trendDir === "rising"
    ? `▲ Up ${trendPct.toFixed(1)}% over ${recent.length - 1} days`
    : "→ Stable";

  // Deals = drives >15% below market avg
  const hotDeals = drives.filter(d => d.pricePerTB / avg <= 0.85);

  const dealSec = hotDeals.length ? `
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;margin-bottom:20px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#15803d;font-weight:600;margin-bottom:10px">
        🔥 Deal Alert — ${hotDeals.length} drive${hotDeals.length > 1 ? "s" : ""} significantly below market average
      </div>
      ${hotDeals.map(d => `
        <div style="margin-bottom:8px;font-size:13px">
          <strong style="color:#15803d">${d.name}</strong> — $${d.price} (<strong>$${d.pricePerTB.toFixed(2)}/TB</strong>) at ${d.retailer}
          ${d.url ? ` &mdash; <a href="${d.url}" style="color:#15803d;font-weight:500">View deal →</a>` : ""}
        </div>`).join("")}
    </div>` : "";

  const dCard = (d, highlight) => `
    <div style="border:1px solid ${highlight ? "#3b82f6" : "#e2e8f0"};border-radius:10px;padding:14px;margin-bottom:10px;background:${highlight ? "#eff6ff" : "#ffffff"}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;color:#1e293b;font-size:14px">${highlight ? "🏆 " : ""}${d.name}</div>
          <div style="font-size:12px;color:#64748b;margin-top:3px">${d.capacity}TB · ${d.retailer} · CMR</div>
        </div>
        <div style="text-align:right;margin-left:12px;white-space:nowrap">
          <div style="font-size:20px;font-weight:700;color:${highlight ? "#3b82f6" : "#1e293b"}">$${d.pricePerTB.toFixed(2)}<span style="font-size:12px;font-weight:400;color:#64748b">/TB</span></div>
          <div style="font-size:12px;color:#64748b">$${d.price} total</div>
        </div>
      </div>
      ${d.url ? `<div style="margin-top:10px"><a href="${d.url}" style="background:#3b82f6;color:#fff;padding:7px 16px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:500;display:inline-block">View Deal →</a></div>` : ""}
    </div>`;

  const historyRows = recent.map(s => {
    const label = new Date(s.date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `<tr>
      <td style="padding:6px 8px;color:#64748b;font-size:12px">${label}</td>
      <td style="padding:6px 8px;text-align:right;font-weight:500;color:#1e293b;font-size:12px">$${s.avgPricePerTB.toFixed(2)}/TB avg</td>
    </tr>`;
  }).join("");

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:580px;margin:0 auto;padding:20px 10px">

  <!-- Header -->
  <div style="background:#0f172a;border-radius:12px 12px 0 0;padding:22px 28px">
    <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;margin-bottom:5px">NAS Drive Price Tracker</div>
    <div style="font-size:20px;font-weight:600;color:#f1f5f9;letter-spacing:-.3px">Daily Price Update</div>
    <div style="font-size:12px;color:#64748b;margin-top:4px">${today} · CMR drives only</div>
  </div>

  <!-- Stats bar -->
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
      <div style="font-size:18px;font-weight:700;color:${trendColor}">${trendDir.charAt(0).toUpperCase() + trendDir.slice(1)}</div>
      <div style="font-size:11px;color:${trendColor};margin-top:2px;font-weight:500">${trendLabel}</div>
    </div>
  </div>

  <!-- Body -->
  <div style="background:#ffffff;border-radius:0 0 12px 12px;padding:22px 28px;border:1px solid #e2e8f0;border-top:none">
    ${dealSec}

    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:12px;font-weight:500">Top 3 Best Value CMR Drives Today</div>
    ${top3.map((d, i) => dCard(d, i === 0)).join("")}

    ${recent.length >= 2 ? `
    <div style="margin-top:20px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:12px;font-weight:500">Recent Price History (market avg $/TB)</div>
      <div style="border:1px solid #e2e8f0;border-radius:10px;padding:16px">
        <table style="width:100%;border-collapse:collapse">${historyRows}</table>
        <div style="font-size:11px;color:${trendColor};font-weight:500;text-align:right;margin-top:8px">
          ${trendDir === "falling" ? "↓ Market trending down — good time to watch for deals" : trendDir === "rising" ? "↑ Market trending up — consider buying sooner" : "→ Prices are relatively stable"}
        </div>
      </div>
    </div>` : ""}

    <div style="border-top:1px solid #f1f5f9;padding-top:16px;margin-top:20px">
      <p style="font-size:11px;color:#94a3b8;line-height:1.8;margin:0">
        CMR (Conventional Magnetic Recording) drives only. Always confirm price on the retailer's page before purchasing.<br>
        Automated daily update via GitHub Actions.
      </p>
    </div>
  </div>

</div>
</body></html>`;
}

// ── Send email via EmailJS REST API (no browser SDK needed) ─────────────────
async function sendEmail(drives, history, dealsLog) {
  const ejsKey = process.env.EJS_PUBLIC_KEY;
  const ejsSvc = process.env.EJS_SERVICE_ID;
  const ejsTpl = process.env.EJS_TEMPLATE_ID;
  const ejsTo  = process.env.ALERT_EMAIL;

  if (!ejsKey || !ejsSvc || !ejsTpl || !ejsTo) {
    console.log("Email skipped: one or more EmailJS secrets not set (EJS_PUBLIC_KEY, EJS_SERVICE_ID, EJS_TEMPLATE_ID, ALERT_EMAIL).");
    return;
  }
  if (!drives.length) { console.log("Email skipped: no drive data."); return; }

  const best    = drives[0];
  const subject = `NAS Drive Update · Best: $${best.pricePerTB.toFixed(2)}/TB · ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  const html    = buildEmailHTML(drives, history, dealsLog);

  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id:  ejsSvc,
      template_id: ejsTpl,
      user_id:     ejsKey,
      template_params: {
        to_email:  ejsTo,
        subject,
        html_body: html,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`EmailJS error ${res.status}: ${err.slice(0, 300)}`);
  }

  console.log(`✉ Email sent to ${ejsTo}`);
  console.log(`  Subject: ${subject}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== NAS Drive Price Tracker — Fetch Start ===");
  console.log(`Script version: v${VERSION}`);
  console.log(`Run time: ${new Date().toISOString()}`);

  // Load existing data to preserve history and deals log
  let existing = { history: [], dealsLog: [] };
  if (existsSync("data/prices.json")) {
    try {
      const raw  = readFileSync("data/prices.json", "utf8");
      const json = JSON.parse(raw);
      existing.history  = Array.isArray(json.history)  ? json.history  : [];
      existing.dealsLog = Array.isArray(json.dealsLog) ? json.dealsLog : [];
      console.log(`Loaded existing data: ${existing.history.length} history entries, ${existing.dealsLog.length} deal log entries`);
    } catch (e) {
      console.log(`Could not load existing prices.json (${e.message}) — starting fresh`);
    }
  }

  // Fetch fresh prices
  const drives = await fetchAllDrives();
  console.log(`\nTotal drives collected: ${drives.length}`);

  if (!drives.length) {
    console.error("No drives returned — aborting without overwriting prices.json");
    process.exit(1);
  }

  const today          = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const avgPricePerTB  = parseFloat((drives.reduce((s, d) => s + d.pricePerTB, 0) / drives.length).toFixed(2));

  // Update history — one entry per date, deduplicated
  const historyMap = new Map(existing.history.map(h => [h.date, h]));
  historyMap.set(today, { date: today, avgPricePerTB });
  const history = Array.from(historyMap.values())
    .sort((a, b) => b.date.localeCompare(a.date)) // newest first
    .slice(0, 60);

  // Update deals log — record today's #1 best value drive, deduplicated by date
  const best = drives[0];
  const dealsMap = new Map(existing.dealsLog.map(d => [d.date, d]));
  dealsMap.set(today, {
    date:       today,
    name:       best.name,
    capacity:   best.capacity,
    price:      best.price,
    pricePerTB: best.pricePerTB,
    retailer:   best.retailer,
    url:        best.url,
  });
  const dealsLog = Array.from(dealsMap.values())
    .sort((a, b) => b.date.localeCompare(a.date)) // newest first
    .slice(0, 30);

  // Write updated prices.json
  const output = { version: VERSION, updatedAt: new Date().toISOString(), drives, history, dealsLog };
  writeFileSync("data/prices.json", JSON.stringify(output, null, 2));
  console.log(`\n✓ Wrote data/prices.json (script v${VERSION})`);
  console.log(`  ${drives.length} drives  |  ${history.length} history entries  |  ${dealsLog.length} deal log entries`);
  console.log(`  Today's #1: ${best.name} @ $${best.pricePerTB.toFixed(2)}/TB ($${best.price}) from ${best.retailer}`);

  // Send daily email
  try {
    await sendEmail(drives, history, dealsLog);
  } catch (e) {
    console.error(`✗ Email failed: ${e.message}`);
    // Non-fatal — prices were saved successfully
  }

  console.log("\n=== Fetch Complete ===");
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
