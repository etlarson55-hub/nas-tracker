// fetch-prices.js
// Runs server-side in GitHub Actions — calls SerpAPI and writes data/prices.json
// Node.js 20 built-in fetch is used, no npm packages required

import { writeFileSync } from "fs";

const SERP_API_KEY = process.env.SERP_API_KEY;
if (!SERP_API_KEY) {
  console.error("ERROR: SERP_API_KEY environment variable is not set.");
  process.exit(1);
}

const SEARCHES = [
  { q: "WD Red Plus NAS internal hard drive 4TB OR 6TB OR 8TB OR 10TB OR 12TB", type: "internal", brand: "Western Digital" },
  { q: "WD Red Pro NAS internal hard drive 4TB OR 6TB OR 8TB OR 10TB OR 12TB",  type: "internal", brand: "Western Digital" },
  { q: "Seagate IronWolf NAS internal hard drive 4TB OR 6TB OR 8TB OR 10TB",    type: "internal", brand: "Seagate"         },
  { q: "Seagate IronWolf Pro NAS internal hard drive 8TB OR 10TB OR 12TB",      type: "internal", brand: "Seagate"         },
  { q: "Toshiba N300 NAS internal hard drive 4TB OR 6TB OR 8TB OR 10TB OR 12TB",type: "internal", brand: "Toshiba"         },
  { q: "WD Easystore external desktop hard drive 8TB OR 10TB OR 12TB",          type: "external", brand: "Western Digital" },
  { q: "WD Elements Desktop external hard drive 4TB OR 6TB OR 8TB OR 10TB",    type: "external", brand: "Western Digital" },
  { q: "Seagate Expansion Desktop external hard drive 4TB OR 6TB OR 8TB OR 10TB",type:"external", brand: "Seagate"        },
];

// Only accept results from these retailers — everything else (eBay, Poshmark, Mercari, etc.) is rejected
const TRUSTED_RETAILERS = [
  "amazon",
  "newegg",
  "best buy",
  "bestbuy",
  "b&h",
  "bhphoto",
  "bh photo",
  "adorama",
  "walmart",
  "costco",
  "bhphotovideo",
  "micro center",
  "microcenter",
  "antonline",
  "tiger direct",
];

function isTrusted(source) {
  if (!source) return false;
  const s = source.toLowerCase();
  return TRUSTED_RETAILERS.some(r => s.includes(r));
}


  const m = title.match(/(\d+)\s*TB/i);
  if (m) return parseInt(m[1]);
  const g = title.match(/(\d{4,5})\s*GB/i);
  if (g) return Math.round(parseInt(g[1]) / 1000);
  return null;
}

function cleanName(title, brand, cap) {
  const models = [
    "IronWolf Pro", "IronWolf", "Red Pro", "Red Plus", "Red", "Gold", "Purple",
    "N300", "X300", "Ultrastar", "Easystore", "Elements Desktop", "Elements",
    "Expansion Desktop", "Expansion", "One Touch", "My Book", "Exos",
  ];
  for (const m of models) {
    if (title.toLowerCase().includes(m.toLowerCase())) {
      return `${brand.split(" ").pop()} ${m} ${cap}TB`;
    }
  }
  return `${brand.split(" ").pop()} ${cap}TB`;
}

function retailerLabel(source) {
  const s = (source || "").toLowerCase();
  if (s.includes("amazon"))   return "Amazon";
  if (s.includes("newegg"))   return "Newegg";
  if (s.includes("best buy") || s.includes("bestbuy")) return "Best Buy";
  if (s.includes("b&h") || s.includes("bhphoto") || s.includes("bh photo")) return "B&H Photo";
  if (s.includes("adorama"))  return "Adorama";
  if (s.includes("walmart"))  return "Walmart";
  if (s.includes("costco"))   return "Costco";
  return source || "Online Retailer";
}

async function searchOne(search) {
  const { q, type, brand } = search;
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(q)}&gl=us&hl=en&num=40&api_key=${SERP_API_KEY}`;

  console.log(`  Searching: ${q}`);
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`SerpAPI returned HTTP ${res.status} for query: ${q}`);
  }

  const data = await res.json();
  const raw = data.shopping_results || [];
  console.log(`  → ${raw.length} raw results`);

  const out = [];
  for (const item of raw) {
    const title = item.title || "";

    // Reject non-trusted retailers immediately
    const src = item.source || item.seller || item.store || "";
    if (!isTrusted(src)) {
      console.log(`    Skipped (${src || "unknown source"}): ${title.slice(0, 50)}`);
      continue;
    }

    const cap = extractCapTB(title);
    if (!cap || cap < 4 || cap > 14) continue;

    const price = item.extracted_price
      || parseFloat((item.price || "").replace(/[^0-9.]/g, ""))
      || null;
    if (!price || price < 20 || price > 1000) continue;

    const ptb = price / cap;
    if (ptb < 5 || ptb > 70) continue;

    // Capture URL from any field SerpAPI might use
    const url = item.link
      || item.product_link
      || item.url
      || item.shopping_url
      || null;

    out.push({
      name:       cleanName(title, brand, cap),
      brand,
      capacity:   cap,
      type,
      price:      parseFloat(price.toFixed(2)),
      pricePerTB: parseFloat(ptb.toFixed(2)),
      retailer:   retailerLabel(src),
      url,
      rating:     item.rating || null,
      reviews:    item.reviews || null,
    });
  }

  console.log(`  → ${out.length} passed filters`);
  return out;
}

async function main() {
  console.log("Starting price fetch...\n");
  const all = [];
  const seen = new Set();

  for (const search of SEARCHES) {
    try {
      const results = await searchOne(search);
      for (const d of results) {
        const key = `${d.name}|${d.retailer}`;
        if (!seen.has(key)) { seen.add(key); all.push(d); }
      }
      // Small delay between requests to be polite to SerpAPI
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.warn(`  WARNING: Skipping search — ${err.message}`);
    }
  }

  if (all.length === 0) {
    console.error("\nERROR: No drives found. Check SerpAPI key and response structure.");
    process.exit(1);
  }

  const ranked = all
    .sort((a, b) => a.pricePerTB - b.pricePerTB)
    .slice(0, 20)
    .map((d, i) => ({ ...d, rank: i + 1 }));

  const output = {
    updatedAt: new Date().toISOString(),
    drives: ranked,
  };

  writeFileSync("data/prices.json", JSON.stringify(output, null, 2));
  console.log(`\nDone. ${ranked.length} drives written to data/prices.json`);
  console.log(`Best deal: ${ranked[0].name} at $${ranked[0].pricePerTB.toFixed(2)}/TB`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
