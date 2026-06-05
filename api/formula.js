// ============================================================
// formula.js — Paint formula lookup (Vercel serverless function)
// ============================================================
//
// WHAT THIS DOES
// --------------
// A customer's car is identified (in lookup.js). That gives us a paint
// "make + code" — for example, Volvo + "712". This file's job is to take
// that make+code and return the actual mixing recipe: which Mipa components,
// how many grams of each, for a 10ml batch.
//
// HOW IT FINDS THE RECIPE
// -----------------------
// All formulas live in Rick's Google Sheet (published as CSV). Rather than
// download the entire sheet every time a customer makes a lookup (slow,
// wasteful), this file downloads it once, parses it, and caches the parsed
// version in two places:
//   1. In-memory cache (super fast, dies on cold start, lasts 1 minute)
//   2. Upstash Redis cache (survives cold starts, lasts 5 minutes)
//
// 5-minute cache means: when Rick edits his sheet, his change is live
// within 5 minutes. Trade-off accepted.
//
// REQUIRED SHEET COLUMNS (in Sheet 2 of PaintLab, gid=1255336829)
// ---------------------------------------------------------------
// paint_code        — e.g. "723"  (required)
// component         — e.g. "BC-VDG"  (required)
// grams_per_10ml    — e.g. "1.6"  (required)
// brand             — e.g. "MERCEDES"  (optional but RECOMMENDED — see below)
//
// OPTIONAL EXTRA COLUMNS (added 1 Jun 2026)
// -----------------------------------------
// paint_name        — e.g. "Denim Blue"  — surfaced as confirmation
//                     on the manual /PaintCode entry page so customers
//                     see "✓ 723 — Denim Blue" when they type a code
//                     we recognise. If missing, no confirmation shown.
// hex               — e.g. "#28477A" — exact paint colour. When set,
//                     used by both home widget and /add-to-cart embed
//                     to render the silhouette in the customer's
//                     ACTUAL paint colour, not just the muted-palette
//                     fallback. Build this column over time using a
//                     fan deck + colour picker (Mipa-fan-deck plan).
//
// WHY THE BRAND COLUMN MATTERS:
// Mipa paint codes are NOT globally unique. Code 723 means one thing for
// Mercedes (Cubanitsilber Met) and something totally different for BMW.
// Adding a brand column to each recipe row prevents the wrong formula
// from being returned. Without it, the file falls back to code-only
// matching, which works fine until you encounter a collision.
//
// ACCEPTED COLUMN NAME VARIANTS (case-insensitive):
//   paint_code  | code  | paintcode
//   grams_per_10ml | grams | share_g | weight
//   brand | make | manufacturer
//   component | raw_material | material
//   paint_name | name | colour_name | color_name
//   hex | hexcode | color_hex | colour_hex | rgb
// ============================================================

const { Redis } = require("@upstash/redis");

const FORMULA_CSV_URL =
  process.env.FORMULA_CSV_URL ||
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTsjyEtVcJe-HHdqbK4AGzjOm6fZNsqEx6Be_7P99vgzWXCWPSIlaUa9zCoH8UxqiF7emmGxEwy-iL_/pub?gid=1255336829&single=true&output=csv";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ============================================================
// CONSTANTS
// ============================================================

const BATCH_SIZE_ML = 10;                   // Every pen = 10ml. Always.
const REDIS_CACHE_KEY = "formula:csv:v5";   // Bumped to v5 — force-bust stale cache after sheet edits
const REDIS_CACHE_TTL_SECONDS = 60 * 5;     // 5 minutes
const MEMORY_CACHE_TTL_MS = 60 * 1000;      // 1 minute
const CSV_FETCH_TIMEOUT_MS = 7000;          // Give Google 7s, then give up

// Wix domains the customer might come from. Lock CORS to these
// so randoms can't hammer the endpoint and burn our budget.
const ALLOWED_ORIGINS = [
  "https://www.paintmatchpen.com",
  "https://paintmatchpen.com",
  "https://rickshowers48-mysite.editor.wix.com",
  "https://editor.wix.com",
  "https://manage.wix.com",
];

// Wix HTML embed iframes are served from sandboxed subdomains like
// *.filesusr.com — we accept those by pattern rather than hardcoding.
const WIX_ORIGIN_SUFFIXES = [
  ".filesusr.com",
  ".wixsite.com",
  ".wix.com",
];

// ============================================================
// IN-MEMORY CACHE (per-function-instance only)
// ============================================================

let memoryCache = null;
let memoryCacheSavedAt = 0;

function readMemoryCache() {
  if (!memoryCache) return null;
  if (Date.now() - memoryCacheSavedAt > MEMORY_CACHE_TTL_MS) {
    memoryCache = null;
    return null;
  }
  return memoryCache;
}

function writeMemoryCache(value) {
  memoryCache = value;
  memoryCacheSavedAt = Date.now();
}

function redisReady() {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL &&
    process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

// ============================================================
// HEX NORMALISER
// ============================================================
// Accepts a bunch of formats Rick or a fan deck might give us:
//   #1A2B3C  →  #1A2B3C
//   1A2B3C   →  #1A2B3C   (no hash)
//   rgb(26, 43, 60)   →  #1A2B3C  (RGB triple)
//   "26, 43, 60"     →  #1A2B3C
// Returns the normalised hex, or empty string if input is unparseable.

function normaliseHex(input) {
  if (!input) return "";
  const s = String(input).trim();
  if (!s) return "";

  // Pure hex (with or without leading #)
  const hexMatch = s.match(/^#?([0-9a-fA-F]{6})$/);
  if (hexMatch) return "#" + hexMatch[1].toUpperCase();

  // RGB triple — "rgb(26, 43, 60)" or just "26, 43, 60"
  const rgbMatch = s.match(/(\d{1,3})\D+(\d{1,3})\D+(\d{1,3})/);
  if (rgbMatch) {
    const r = Math.min(255, parseInt(rgbMatch[1], 10));
    const g = Math.min(255, parseInt(rgbMatch[2], 10));
    const b = Math.min(255, parseInt(rgbMatch[3], 10));
    return (
      "#" +
      r.toString(16).padStart(2, "0").toUpperCase() +
      g.toString(16).padStart(2, "0").toUpperCase() +
      b.toString(16).padStart(2, "0").toUpperCase()
    );
  }

  return ""; // unparseable
}

// ============================================================
// CSV PARSER
// ============================================================
// Handles real-world CSV gotchas:
//   - Quoted fields containing commas:    "Mipa White, Premium"
//   - Escaped quotes within fields:       "He said ""hi"""
//   - Both Windows (\r\n) and Unix (\n) line endings
//   - Blank lines and trailing whitespace
//
// Returns: array of arrays (rows of cells).

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // skip the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      if (ch === "\r" && text[i + 1] === "\n") i++; // skip the \n of \r\n
    } else {
      field += ch;
    }
  }

  // Trailing field/row (file might not end with newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((c) => c !== "")) rows.push(row);
  }

  return rows;
}

// ============================================================
// FETCH WITH TIMEOUT
// ============================================================
// AbortController = the timer next to the phone. If Google Sheets
// hasn't picked up in CSV_FETCH_TIMEOUT_MS, we hang up and throw.

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Google Sheets returned HTTP ${res.status}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// LOAD + PARSE THE SHEET (with caching)
// ============================================================
// Returns: { rows: [...parsedRowObjects], hasMakeColumn: boolean }

async function loadParsedSheet() {
  // 1. Try memory cache
  const memHit = readMemoryCache();
  if (memHit) {
    console.log("formula.js: memory cache hit");
    return memHit;
  }

  // 2. Try Redis cache
  if (redisReady()) {
    try {
      const cached = await redis.get(REDIS_CACHE_KEY);
      if (cached) {
        console.log("formula.js: redis cache hit");
        writeMemoryCache(cached);
        return cached;
      }
    } catch (err) {
      console.warn("formula.js: redis read failed, falling through:", err.message);
    }
  }

  // 3. Live fetch + parse
  console.log("formula.js: fetching fresh CSV from Google Sheets");
  const response = await fetchWithTimeout(FORMULA_CSV_URL, CSV_FETCH_TIMEOUT_MS);
  const csv = await response.text();
  const rawRows = parseCSV(csv);

  if (rawRows.length < 2) {
    throw new Error("Sheet returned empty or header-only CSV");
  }

  // Identify columns from the header row (case-insensitive, multiple aliases supported)
  const header = rawRows[0].map((h) => String(h).trim().toLowerCase());
  const findCol = (...names) => {
    for (const n of names) {
      const idx = header.indexOf(n);
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const codeIdx = findCol("paint_code", "code", "paintcode");
  const componentIdx = findCol("component", "raw_material", "material");
  const gramsIdx = findCol("grams_per_10ml", "grams", "share_g", "weight");
  const brandIdx = findCol("brand", "make", "manufacturer");
  const paintNameIdx = findCol("paint_name", "name", "colour_name", "color_name");
  const hexIdx = findCol("hex", "hexcode", "color_hex", "colour_hex", "rgb");

  if (codeIdx === -1 || componentIdx === -1 || gramsIdx === -1) {
    throw new Error(
      `Sheet is missing required columns. Need one of [paint_code, code], ` +
      `[component], and [grams_per_10ml, grams]. Got: ${header.join(", ")}`
    );
  }

  const hasBrandColumn = brandIdx >= 0;
  const hasPaintNameColumn = paintNameIdx >= 0;
  const hasHexColumn = hexIdx >= 0;

  // Parse data rows into clean objects.
  //
  // NOTE on filtering: rows are kept if they have a paint code AND
  // EITHER (a) a valid recipe ingredient (component + grams) OR (b)
  // a paint_name set. This lets the sheet hold "name only" entries
  // for paint codes Rick hasn't mixed yet — they still power the
  // /PaintCode confirmation banner. The recipe lookup (findFormula)
  // filters down to recipe-bearing rows separately when needed.
  const rows = rawRows
    .slice(1)
    .map((r) => ({
      brand: hasBrandColumn ? String(r[brandIdx] || "").trim().toUpperCase() : "",
      code: String(r[codeIdx] || "").trim().toUpperCase(),
      component: String(r[componentIdx] || "").trim(),
      grams: parseFloat(r[gramsIdx]),
      paintName: hasPaintNameColumn ? String(r[paintNameIdx] || "").trim() : "",
      hex: hasHexColumn ? normaliseHex(String(r[hexIdx] || "").trim()) : "",
    }))
    .filter((r) => {
      if (!r.code) return false;
      const hasRecipe = r.component && !isNaN(r.grams) && r.grams > 0;
      const hasName = Boolean(r.paintName);
      return hasRecipe || hasName;
    });

  const result = {
    rows,
    hasBrandColumn,
    hasPaintNameColumn,
    hasHexColumn,
  };

  // Save to both caches
  writeMemoryCache(result);
  if (redisReady()) {
    try {
      await redis.set(REDIS_CACHE_KEY, result, { ex: REDIS_CACHE_TTL_SECONDS });
      console.log("formula.js: redis cache saved");
    } catch (err) {
      console.warn("formula.js: redis save failed:", err.message);
    }
  }

  return result;
}

// ============================================================
// FIND THE RECIPE
// ============================================================

function findFormula({ rows, hasBrandColumn }, paintCode, brand) {
  const cleanCode = String(paintCode).trim().toUpperCase();
  const cleanBrand = String(brand || "").trim().toUpperCase();

  let matches;
  if (hasBrandColumn && cleanBrand) {
    // Strict: must match both brand and code.
    // Prevents Mipa code collisions (e.g. Mercedes 723 vs BMW 723).
    matches = rows.filter((r) => r.code === cleanCode && r.brand === cleanBrand);

    // Graceful fallback for partially-migrated data: if no strict match
    // but rows exist for this code with no brand set, use those.
    // Keeps the existing single-recipe-without-brand case working while
    // Rick gradually adds brand values.
    if (matches.length === 0) {
      matches = rows.filter((r) => r.code === cleanCode && !r.brand);
    }
  } else {
    // Legacy mode: sheet doesn't have a Brand column yet, OR caller
    // didn't provide a brand. Match on code alone.
    matches = rows.filter((r) => r.code === cleanCode);
  }

  // Recipe components — only rows that actually have ingredient data.
  // "Name only" rows (paint_name set but no component) are excluded
  // from the recipe but contribute to the paint_name + hex lookup.
  const components = matches
    .filter((r) => r.component && !isNaN(r.grams) && r.grams > 0)
    .map(({ component, grams }) => ({ component, grams }));

  // Paint name and hex are per-PAINT (not per-ingredient). All rows for
  // the same paint will share the same name/hex, so pick from the first
  // match that has one. Empty strings if those columns aren't populated.
  const paintName = matches.find((r) => r.paintName)?.paintName || "";
  const hex = matches.find((r) => r.hex)?.hex || "";

  return { components, paintName, hex };
}

// ============================================================
// CALLABLE FROM lookup.js DIRECTLY (no HTTP round-trip)
// ============================================================
// This is the function lookup.js will call instead of making an HTTP
// request to itself. Same logic, no extra cold start, no extra latency.

async function getFormula({ paintCode, brand, make }) {
  // Accept either `brand` or `make` from the caller — same thing.
  // DVLA/VehicleDataGlobal return "make"; the catalogue sheet uses "brand".
  const brandInput = brand || make || "";

  if (!paintCode) {
    return { ok: false, status: "missing_paint_code", formula: [] };
  }

  let parsed;
  try {
    parsed = await loadParsedSheet();
  } catch (err) {
    console.error("formula.js: sheet load failed:", err.message);
    return {
      ok: false,
      status: "sheet_unavailable",
      error: err.message,
      formula: [],
    };
  }

  const { components, paintName, hex } = findFormula(parsed, paintCode, brandInput);

  // Status logic:
  //   found              → we have a full recipe AND we know the name
  //   name_only          → we know the paint name (and maybe hex) but
  //                        no recipe yet — still useful for the
  //                        confirmation banner
  //   formula_not_available → nothing in the DB for this code+brand
  let status;
  let message;
  if (components.length > 0) {
    status = "found";
    message = undefined;
  } else if (paintName) {
    status = "name_only";
    message = "We recognise this paint but haven't published the recipe yet.";
  } else {
    status = "formula_not_available";
    message = "We don't have this paint formula on file yet.";
  }

  return {
    ok: true,
    status,
    paintCode: String(paintCode).trim().toUpperCase(),
    brand: brandInput.trim().toUpperCase(),
    batchSizeMl: BATCH_SIZE_ML,
    formula: components,
    paintName,
    hex,
    ...(message ? { message } : {}),
  };
}

// ============================================================
// HTTP HANDLER (the public /api/formula endpoint)
// ============================================================

function isOriginAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  for (const suffix of WIX_ORIGIN_SUFFIXES) {
    if (origin.endsWith(suffix)) return true;
  }
  return false;
}

module.exports = async (req, res) => {
  // CORS — accept our domains and Wix-hosted iframe subdomains
  const origin = req.headers.origin || "";
  if (isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "3600");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  try {
    const { paintCode, brand, make } = req.body || {};
    const brandInput = brand || make || "";

    // Input validation
    if (!paintCode || typeof paintCode !== "string" || !paintCode.trim()) {
      return res.status(400).json({ ok: false, error: "paintCode required" });
    }
    if (paintCode.length > 30 || (brandInput && String(brandInput).length > 50)) {
      return res.status(400).json({ ok: false, error: "Input too long" });
    }

    const result = await getFormula({ paintCode, brand: brandInput });

    // Map result.status -> HTTP status
    if (!result.ok && result.status === "sheet_unavailable") {
      return res.status(503).json(result);
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error("formula.js: unexpected error:", err);
    return res.status(500).json({
      ok: false,
      status: "server_error",
      error: "Unexpected error",
    });
  }
};

// Export the inline-callable function too, so lookup.js can require it.
module.exports.getFormula = getFormula;
