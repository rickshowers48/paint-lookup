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
// HIT-RATE COLUMNS (added 2 Oct 2026)
// ----------------------------------
// alias_codes      — e.g. "AY | 733 | 0FC | DXQEWWA" on the DXQE row.
//                    Every other code the SAME paint is known by (door
//                    sticker code, Mipa code, VDG code...). Separate with
//                    | or , or ; or /. Whichever one VDG or the customer
//                    gives us, we land on this row. Only needs putting on
//                    ONE row of a recipe — it applies to the whole paint.
// colour_family    — e.g. "BRONZE" or "RED, ORANGE". The DVLA-style colour
//                    word(s) this paint counts as. Used to build the
//                    "Is it one of these?" shortlist when we can't get a
//                    code from the reg. Optional: if blank we guess from
//                    the paint name (Copper → bronze/orange, Onyx → black).
//
// MATCHING RULES (2 Oct 2026)
// ---------------------------
// - Brands are compared loosely: "LAND", "LAND ROVER", "RANGE ROVER" are
//   all Land Rover; "MERCEDES" = "MERCEDES-BENZ"; "VW" = "VOLKSWAGEN";
//   Vauxhall = Opel (same paint codes).
// - Codes ignore spaces/dashes and split on "/": a sheet row "0E/Y9T"
//   matches a lookup of "Y9T", "0E" or "0E/Y9T" (and vice versa).
// - NO year filtering anywhere — that's the Mipa trap (a 2022 Ranger in
//   Copper Pulse is filed under 2013-2018). Codes don't change by year.
//
// ACCEPTED COLUMN NAME VARIANTS (case-insensitive):
//   paint_code  | code  | paintcode
//   grams_per_10ml | grams | share_g | weight
//   brand | make | manufacturer
//   component | raw_material | material
//   paint_name | name | colour_name | color_name
//   hex | hexcode | color_hex | colour_hex | rgb
//   alias_codes | aliases | alias | alt_codes | other_codes
//   colour_family | color_family | family | dvla_colour
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
const REDIS_CACHE_KEY = "formula:csv:v6";   // v6 (2 Oct 2026) — rows now carry aliases + colourFamily
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
  const aliasIdx = findCol("alias_codes", "aliases", "alias", "alt_codes", "other_codes");
  const familyIdx = findCol("colour_family", "color_family", "family", "dvla_colour");

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
      aliases: aliasIdx >= 0 ? String(r[aliasIdx] || "").trim() : "",
      colourFamily: familyIdx >= 0 ? String(r[familyIdx] || "").trim().toUpperCase() : "",
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
// NORMALISERS (brand + code)
// ============================================================

// Brands as they appear in VDG / DVLA / the sheet → one canonical key.
// Anything not listed is just uppercased with spaces/dashes stripped,
// so "ALFA ROMEO" and "Alfa-Romeo" still meet in the middle.
const BRAND_ALIASES = {
  LAND: "LANDROVER", LANDROVER: "LANDROVER", RANGEROVER: "LANDROVER", LR: "LANDROVER",
  MERCEDES: "MERCEDES", MERCEDESBENZ: "MERCEDES", MB: "MERCEDES",
  VW: "VOLKSWAGEN", VOLKSWAGEN: "VOLKSWAGEN",
  // Vauxhall and Opel share paint codes — treat as one paint family.
  VAUXHALL: "VAUXHALL", OPEL: "VAUXHALL",
  CITROEN: "CITROEN", DS: "CITROEN",
  ALFA: "ALFAROMEO", ALFAROMEO: "ALFAROMEO",
  BMWI: "BMW", BMW: "BMW",
};

function canonicalBrand(brand) {
  const flat = String(brand || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // Škoda → Skoda, Citroën → Citroen
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!flat) return "";
  return BRAND_ALIASES[flat] || flat;
}

// One code → its comparable forms. "0E/Y9T" → full "0EY9T" plus parts
// "0E" and "Y9T". "DXQE-WWA" → "DXQEWWA". Spaces/dashes/dots ignored.
function flatCode(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function codeParts(code) {
  const raw = String(code || "").toUpperCase().trim();
  if (!raw) return [];
  const parts = raw.split(/[\/|,;]+/).map(flatCode).filter(Boolean);
  const full = flatCode(raw);
  return [...new Set([full, ...parts])];
}

// Junk / placeholder rows we never want to offer a customer as a real
// paint (e.g. "GEN-WH-001", "VX-BL-001", "Manual Entry").
function isPlaceholder(code, name) {
  if (/-\d{3}$/.test(String(code || "").trim())) return true;
  if (/^manual/i.test(String(name || "").trim())) return true;
  return false;
}

// ============================================================
// BUILD A PAINT INDEX
// ============================================================
// The sheet has one row per recipe INGREDIENT, so one paint can span
// several rows. Group them into one "paint" per brand+code, and union
// any alias codes found on any of its rows.

function buildPaints(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const brandKey = canonicalBrand(r.brand);
    const key = brandKey + "|" + flatCode(r.code);
    let p = byKey.get(key);
    if (!p) {
      p = {
        brand: r.brand, brandKey, code: r.code,
        components: [], paintName: "", hex: "", colourFamily: "",
        exactKeys: new Set(), partKeys: new Set(),
      };
      byKey.set(key, p);
    }
    if (r.component && !isNaN(r.grams) && r.grams > 0) {
      p.components.push({ component: r.component, grams: r.grams });
    }
    if (!p.paintName && r.paintName) p.paintName = r.paintName;
    if (!p.hex && r.hex) p.hex = r.hex;
    if (!p.colourFamily && r.colourFamily) p.colourFamily = r.colourFamily;

    // The row's own code is the strongest key; its slash-parts and any
    // alias codes are secondary keys.
    p.exactKeys.add(flatCode(r.code));
    for (const part of codeParts(r.code)) p.partKeys.add(part);
    for (const alias of String(r.aliases || "").split(/[|,;\/]+/)) {
      for (const part of codeParts(alias)) p.partKeys.add(part);
    }
  }
  return [...byKey.values()];
}

// ============================================================
// FIND THE RECIPE
// ============================================================
// Scoring: exact code beats a slash-part/alias match; a recipe beats a
// name-only row. Brand must match when both sides have one. Rows with
// no brand are a last-resort fallback (legacy sheet rows).

function matchPaint(paints, paintCode, brand) {
  const wantFull = flatCode(paintCode);
  const wantParts = codeParts(paintCode);
  if (!wantFull) return null;
  const wantBrand = canonicalBrand(brand);

  let best = null;
  let bestScore = -1;
  for (const p of paints) {
    // Brand gate
    let brandScore;
    if (wantBrand && p.brandKey) {
      if (p.brandKey !== wantBrand) continue;
      brandScore = 2;
    } else if (!p.brandKey) {
      brandScore = 0; // unbranded legacy row
    } else {
      brandScore = 1; // caller gave no brand
    }

    let codeScore = 0;
    if (p.exactKeys.has(wantFull)) codeScore = 3;
    else if (wantParts.some((k) => p.exactKeys.has(k) || p.partKeys.has(k))) codeScore = 1;
    if (!codeScore) continue;

    const score = codeScore * 10 + brandScore * 3 + (p.components.length ? 2 : 0) + (p.paintName ? 1 : 0);
    if (score > bestScore) {
      best = { paint: p, via: codeScore === 3 ? "exact" : "alias" };
      bestScore = score;
    }
  }
  return best;
}

// Kept for backwards compatibility with anything calling it directly.
function findFormula({ rows }, paintCode, brand) {
  const m = matchPaint(buildPaints(rows), paintCode, brand);
  if (!m) return { components: [], paintName: "", hex: "" };
  return { components: m.paint.components, paintName: m.paint.paintName, hex: m.paint.hex };
}

function statusFor(m) {
  if (!m) return "formula_not_available";
  if (m.paint.components.length) return "found";
  if (m.paint.paintName) return "name_only";
  return "formula_not_available";
}
const STATUS_RANK = { found: 3, name_only: 2, formula_not_available: 1 };

// ============================================================
// CALLABLE FROM lookup.js DIRECTLY (no HTTP round-trip)
// ============================================================
// Accepts a single paintCode OR a list (paintCodes) — VDG sometimes
// returns several codes for one car and the right one isn't always
// first. We try them all and keep the best result.

async function getFormula({ paintCode, paintCodes, brand, make }) {
  const brandInput = brand || make || "";
  const codes = [...new Set(
    [].concat(paintCodes || [], paintCode || [])
      .map((c) => String(c || "").trim())
      .filter(Boolean)
  )];

  if (codes.length === 0) {
    return { ok: false, status: "missing_paint_code", formula: [] };
  }

  let parsed;
  try {
    parsed = await loadParsedSheet();
  } catch (err) {
    console.error("formula.js: sheet load failed:", err.message);
    return { ok: false, status: "sheet_unavailable", error: err.message, formula: [] };
  }

  const paints = buildPaints(parsed.rows || []);
  let best = null;
  for (const code of codes) {
    const m = matchPaint(paints, code, brandInput);
    const st = statusFor(m);
    if (!best || STATUS_RANK[st] > STATUS_RANK[best.status]) {
      best = { code, m, status: st };
    }
    if (st === "found") break;
  }

  const { code, m, status } = best;
  let message;
  if (status === "name_only") message = "We recognise this paint but haven't published the recipe yet.";
  if (status === "formula_not_available") message = "We don't have this paint formula on file yet.";
  if (m && m.via === "alias") {
    console.log(`formula.js: alias hit — "${code}" → sheet code "${m.paint.code}" (${m.paint.brand || "no brand"})`);
  }

  return {
    ok: true,
    status,
    paintCode: code.toUpperCase(),          // the input code that matched best
    sheetCode: m ? m.paint.code : "",       // the code it's filed under in the sheet
    matchedVia: m ? m.via : "",             // "exact" | "alias" | ""
    brand: brandInput.trim().toUpperCase(),
    batchSizeMl: BATCH_SIZE_ML,
    formula: m ? m.paint.components : [],
    paintName: m ? m.paint.paintName : "",
    hex: m ? m.paint.hex : "",
    ...(message ? { message } : {}),
  };
}

// ============================================================
// SHORTLIST — "Is it one of these?"
// ============================================================
// When the reg lookup gives us make + DVLA colour but no paint code,
// offer the customer the sheet's paints for that make in that colour.
// Paint names are mapped to DVLA colour words via a keyword list unless
// the sheet's colour_family column says otherwise.

const COLOUR_KEYWORDS = {
  BLACK: ["black", "onyx", "obsidian", "ebony", "noir", "nero", "jet", "schwarz", "panther", "midnight", "sapphire black", "carbon black", "phantom"],
  WHITE: ["white", "weiss", "blanc", "bianco", "ivory", "frost", "glacier", "polar", "arctic", "snow", "alpine", "alpin", "pearl white", "banquise", "crystal"],
  SILVER: ["silver", "reflex", "aluminium", "aluminum", "platinum", "mercury", "moonstone", "titanium", "argent", "sterling", "chrome"],
  GREY: ["grey", "gray", "graphite", "anthracite", "gunmetal", "slate", "magnetic", "titanium", "carbon", "ash", "shadow", "smoke", "storm", "comet", "selenite", "daytona", "nardo", "cement", "pebble", "cactus", "magnetite", "nebula", "grau"],
  RED: ["red", "rosso", "rouge", "ruby", "scarlet", "crimson", "flame", "cherry", "garnet", "rot", "tornado", "fusion", "shiraz", "firenze", "race"],
  MAROON: ["maroon", "burgundy", "bordeaux", "claret", "wine", "plum", "shiraz"],
  BLUE: ["blue", "blau", "bleu", "azure", "cobalt", "navy", "sapphire", "ocean", "marine", "denim", "indigo", "atlantic", "petrol", "lapis", "monterey"],
  GREEN: ["green", "verde", "vert", "emerald", "olive", "jade", "lime", "racing", "forest", "khaki", "moss", "bay leaf", "nebula"],
  BRONZE: ["bronze", "copper", "cinnamon", "amber", "caramel", "rust", "burnished"],
  BROWN: ["brown", "mocha", "chocolate", "espresso", "coffee", "havana", "chestnut", "tobacco", "sepia", "mahogany"],
  ORANGE: ["orange", "copper", "tangerine", "sunset", "volcano", "solaris", "amber"],
  YELLOW: ["yellow", "gelb", "giallo", "lemon", "sunflower", "mustard"],
  GOLD: ["gold", "champagne", "golden"],
  BEIGE: ["beige", "sand", "champagne", "cream", "latte", "almond", "desert", "savannah", "cashmere", "ivory", "atacama"],
  CREAM: ["cream", "ivory", "magnolia", "vanilla", "beige"],
  PURPLE: ["purple", "violet", "plum", "lilac", "amethyst", "aubergine", "mauve"],
  TURQUOISE: ["turquoise", "teal", "aqua", "cyan", "petrol"],
  PINK: ["pink", "rose", "magenta", "fuchsia", "coral"],
};

function familiesForPaint(p) {
  if (p.colourFamily) {
    return p.colourFamily.split(/[|,;\/]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  }
  // Whole-word match so "race" doesn't fire on "Grace" or "Trace".
  const name = " " + String(p.paintName || "").toLowerCase().replace(/[^a-z]+/g, " ") + " ";
  const out = [];
  for (const [fam, words] of Object.entries(COLOUR_KEYWORDS)) {
    if (words.some((w) => name.includes(" " + w + " "))) out.push(fam);
  }
  return out;
}

function significantWords(s) {
  const noise = new Set(["metallic", "pearl", "pearlescent", "effect", "paint", "finish", "standard", "mica", "solid", "premium", "exterior", "the", "and"]);
  return String(s || "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !noise.has(w));
}

async function getCandidates({ brand, make, colour, hintName, limit = 6 }) {
  const wantBrand = canonicalBrand(brand || make);
  const wantColour = String(colour || "").trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (!wantBrand) return [];

  let parsed;
  try {
    parsed = await loadParsedSheet();
  } catch (err) {
    console.error("formula.js: sheet load failed (candidates):", err.message);
    return [];
  }

  const hintWords = new Set(significantWords(hintName));
  const scored = [];
  for (const p of buildPaints(parsed.rows || [])) {
    if (p.brandKey !== wantBrand) continue;
    if (!p.paintName || isPlaceholder(p.code, p.paintName)) continue;

    let score = 0;
    const fams = familiesForPaint(p);
    if (wantColour && fams.includes(wantColour)) score += 2;
    // VDG sometimes gives a colour NAME without a code — reward overlap.
    if (hintWords.size && significantWords(p.paintName).some((w) => hintWords.has(w))) score += 5;
    if (score === 0) continue; // wrong colour family / no signal at all
    if (p.components.length) score += 1;    // we can mix it today

    scored.push({ score, code: p.code, name: p.paintName, hex: p.hex || "", hasRecipe: p.components.length > 0 });
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map(({ score, ...rest }) => rest);
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
module.exports.getCandidates = getCandidates;
// Internals exposed for tests only.
module.exports._test = { parseCSV, buildPaints, matchPaint, canonicalBrand, codeParts, familiesForPaint };
