// ============================================================
// lookup.js — Main paint lookup orchestrator (Vercel)
// ============================================================
//
// WHAT THIS DOES
// --------------
// Takes a customer's car registration (VRM) and turns it into a complete
// order package: vehicle details, paint code, paint name, and the full
// mixing recipe — all in a single response.
//
// THE FLOW
// --------
// 1. Validate the VRM format (reject obvious garbage)
// 2. Check the rate limiter (don't let one bad actor drain our API budget)
// 3. Check cache (memory → Redis → live)
// 4. If cache miss:
//    a. Call DVLA + VehicleDataGlobal IN PARALLEL (was sequential — slow)
//    b. Each call has a 6-second timeout + one automatic retry
//    c. Combine the results, paint API wins on overlapping fields
//    d. Look up mixing formula by inline-importing formula.js
//    e. Cache the win for 1 year, cache "no paint found" for 7 days
// 5. Return everything to the frontend in one JSON blob
//
// KEY UPGRADES vs the old version
// -------------------------------
// - CORS locked to our domains (was "*" — anyone could drain our budget)
// - Per-IP rate limiter using Redis (30 req/min)
// - Real timeouts via AbortController (was hanging forever on slow DVLA)
// - Auto-retry on timeout or 5xx (fixes "found on 2nd attempt" cars)
// - Response status checks BEFORE parsing JSON (no more crash on HTML errors)
// - Negative caching (don't keep paying APIs for unsupported cars)
// - VRM format validation
// - Inline formula call (chef no longer walks outside to phone himself)
// - Distinct error states: invalid VRM, vehicle not found, paint not in
//   our system, service unavailable — each gets the right HTTP status
//   and a user-friendly message
// ============================================================

const { Redis } = require("@upstash/redis");
const formulaModule = require("./formula");
const getFormula = formulaModule.getFormula;

// ============================================================
// CONFIG
// ============================================================

const ALLOWED_ORIGINS = [
  "https://www.paintmatchpen.com",
  "https://paintmatchpen.com",
  "https://rickshowers48-mysite.editor.wix.com",
  "https://editor.wix.com",
  "https://manage.wix.com",
];

// Wix serves HTML embed widgets from sandboxed iframe domains rather than
// directly from your custom domain. The widget on the home page reports an
// origin like https://www-paintmatchpen-com.filesusr.com — the exact
// subdomain varies between published, preview, mobile, and editor contexts.
// We accept any *.filesusr.com / *.wixsite.com / *.wix.com origin in
// addition to the explicit allow list above.
const WIX_ORIGIN_SUFFIXES = [
  ".filesusr.com",
  ".wixsite.com",
  ".wix.com",
];

// 10 seconds per API. Bumped from 6s after we saw a string of legitimate
// VDG calls getting aborted on slow mornings. With one auto-retry on top
// (see fetchWithRetry below), the absolute worst case is ~20s before we
// give up on either API — but Promise.all means the customer waits the
// slowest of DVLA / VDG / VDG-Image, not the sum.
const API_TIMEOUT_MS = 10000;
const MEMORY_CACHE_TTL_MS = 60 * 60 * 1000;             // 1 hour
const REDIS_SUCCESS_TTL_SECONDS = 60 * 60 * 24 * 365;   // 1 year
const REDIS_NEGATIVE_TTL_SECONDS = 60 * 60 * 24 * 7;    // 7 days
const RATE_LIMIT_PER_MIN = 30;                          // per IP

const DVLA_URL = "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles";
const VDG_URL_BASE = "https://uk.api.vehicledataglobal.com/r2/lookup";

// ============================================================
// TEST REG OVERRIDES (A — added 5 Jun 2026 after VDG bill audit)
// ============================================================
//
// Regs in this table SHORT-CIRCUIT the entire lookup pipeline and
// return canned data. They never touch DVLA, VDG, Redis, or the
// formula sheet. Use case: Rick (and anyone else) testing the site
// without burning VDG budget on every refresh.
//
// Background: The audit of the May 14 → Jun 5 VDG report showed
// KD19MYY (Rick's car) was hit 23 times in three weeks. Most of
// those were Rick smoke-testing his own site. At ~£0.10 a call,
// that's ~£2.30 of pure self-test cost on one car. Multiply that
// by every test he wants to do in the next year of dev iteration
// and it's a real number.
//
// To add a tester car: copy an entry, change the key to the reg
// (uppercase, no spaces), edit the canned response to match the
// real vehicle. Edit `paintCode` / `paintName` to match a code
// you actually want to test the downstream flow with — e.g. set
// it to 707 to test "Crystal White Pearl" recognition end-to-end.
const TEST_REG_OVERRIDES = {
  // Rick's car — Volvo XC90, Denim Blue (factory paint code 723).
  KD19MYY: {
    make: "VOLVO",
    model: "XC90",
    colour: "BLUE",
    year: "2019",
    fuelType: "DIESEL",
    bodyType: "ESTATE",
    paintCode: "723",
    paintName: "Denim Blue",
    paintHex: "#28477A",
  },
  // Add more here as you start using other regs for testing.
  // The hex column is optional — leave as null and the home
  // widget's name-to-hex palette will infer a sensible colour.
};

// ============================================================
// REDIS
// ============================================================

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function redisReady() {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL &&
    process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

// ============================================================
// IN-MEMORY CACHE (per function instance)
// ============================================================

const memoryCache = global.lookupMemoryCache || new Map();
global.lookupMemoryCache = memoryCache;

function memoryGet(key) {
  const item = memoryCache.get(key);
  if (!item) return null;
  if (Date.now() - item.savedAt > MEMORY_CACHE_TTL_MS) {
    memoryCache.delete(key);
    return null;
  }
  return item.data;
}

function memorySet(key, data) {
  memoryCache.set(key, { savedAt: Date.now(), data });
}

// ============================================================
// VRM NORMALISE + VALIDATE
// ============================================================

function normaliseVRM(vrm) {
  return String(vrm || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isValidVRM(vrm) {
  // UK plates are 2–7 alphanumeric chars after stripping spaces.
  // 8 allowed to be defensive (unusual edge cases).
  if (!vrm) return false;
  if (vrm.length < 2 || vrm.length > 8) return false;
  return /^[A-Z0-9]+$/.test(vrm);
}

// ============================================================
// CORS
// ============================================================

function isOriginAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Allow Wix-hosted iframe domains (HTML embed widgets)
  for (const suffix of WIX_ORIGIN_SUFFIXES) {
    if (origin.endsWith(suffix)) return true;
  }
  return false;
}

function applyCORS(req, res) {
  const origin = req.headers.origin || "";
  if (isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Cache the preflight response for 1 hour so the browser doesn't OPTIONS
  // us on every single lookup
  res.setHeader("Access-Control-Max-Age", "3600");
}

// ============================================================
// RATE LIMITER (Redis-backed, per IP)
// ============================================================

function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

async function checkRateLimit(ip) {
  if (!redisReady() || !ip || ip === "unknown") return { allowed: true };
  try {
    const key = `ratelimit:lookup:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);
    if (count > RATE_LIMIT_PER_MIN) return { allowed: false, count };
    return { allowed: true, count };
  } catch (err) {
    // If rate limiter itself fails, fail open (allow request through).
    // Better to serve a customer than block them due to our infra.
    console.warn("Rate limit check failed, allowing through:", err.message);
    return { allowed: true };
  }
}

// ============================================================
// FETCH WITH TIMEOUT + ONE RETRY
// ============================================================
//
// The chef's phone now has a timer next to it. If the supplier doesn't
// pick up in 6 seconds, the chef hangs up and calls back ONCE. If they
// still don't answer, the chef gives up cleanly (rather than waiting
// forever).
//
// Retries cover: timeouts, network errors, and 5xx server errors.

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, opts, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchWithTimeout(url, opts, API_TIMEOUT_MS);
      // Retry on 5xx, but not 4xx (4xx is "bad input", retrying won't help)
      if (res.status >= 500 && attempt === 1) {
        console.log(`${label}: HTTP ${res.status} on attempt 1, retrying`);
        continue;
      }
      return res;
    } catch (err) {
      const reason = err.name === "AbortError" ? "timeout" : err.message;
      if (attempt === 1) {
        console.log(`${label}: ${reason} on attempt 1, retrying`);
        continue;
      }
      throw err;
    }
  }
}

// ============================================================
// DVLA LOOKUP
// ============================================================
//
// DVLA gives us: make, colour, year, fuel, body type.
// (DVLA does NOT return model — that comes from VDG.)
//
// Returns null on any failure rather than throwing, so the caller
// can decide what to do if one API works and one doesn't.

async function lookupDVLA(reg) {
  try {
    const res = await fetchWithRetry(
      DVLA_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.DVLA_API_KEY,
        },
        body: JSON.stringify({ registrationNumber: reg }),
      },
      "DVLA"
    );

    if (!res.ok) {
      // 404 = car not in DVLA database. 401 = bad API key. etc.
      console.warn(`DVLA returned HTTP ${res.status} for ${reg}`);
      return null;
    }

    const data = await res.json();
    return {
      make: data.make || null,
      colour: data.colour || null,
      year: data.yearOfManufacture || null,
      fuelType: data.fuelType || null,
      bodyType: null, // DVLA enquiry endpoint doesn't return body type
    };
  } catch (err) {
    console.error("DVLA lookup failed:", err.message);
    return null;
  }
}

// ============================================================
// VEHICLE DATA GLOBAL LOOKUP
// ============================================================
//
// VDG gives us: make, model, colour, fuel, body type, paint code+name.
// This is the supplier that actually returns paint codes.

async function lookupVDG(reg) {
  try {
    const url = `${VDG_URL_BASE}?packagename=PaintCodeDetails&apikey=${process.env.VEHICLE_DATA_API_KEY}&vrm=${encodeURIComponent(reg)}`;
    const res = await fetchWithRetry(url, { method: "GET" }, "VDG");

    if (!res.ok) {
      console.warn(`VDG returned HTTP ${res.status} for ${reg}`);
      return null;
    }

    const data = await res.json();
    const details = data?.Results?.PaintCodeDetails || {};
    const paintList = details.PaintCodeList || [];
    const firstPaint = paintList[0] || {};

    // DEBUG: dump the full paint object so we can see which fields VDG
    // actually returns. We're particularly interested in whether there's
    // a HexCode / ColourCode / RGB field per paint code — if so, we can
    // colour our swatches exactly per paint code instead of falling back
    // to a generic name-to-hex lookup.
    console.log(
      `VDG paint detail for ${reg}: ${JSON.stringify(firstPaint)}`
    );

    return {
      make: details.Make || null,
      model: details.Model || null,
      colour: details.CurrentColour || null,
      fuelType: details.FuelType || null,
      bodyType: details.BodyType || null,
      paintCode: firstPaint.Code || null,
      paintName: firstPaint.Description || null,
      // Try common field name variants for a paint-specific hex code.
      // If VDG doesn't provide one, this stays null and we fall back
      // to the widget's name-to-hex palette.
      paintHex:
        firstPaint.HexCode ||
        firstPaint.Hex ||
        firstPaint.ColourCode ||
        firstPaint.ColorCode ||
        firstPaint.RGB ||
        null,
      // [B] If we got this far, VDG returned a 200 — set a flag so the
      // main handler knows VDG genuinely answered (even if no paint data),
      // and the response can be cached negatively for 7 days instead of
      // being treated as transient. Prevents the ML24PCV pattern: same
      // VRM hit 12 times in 2 minutes because the response wasn't being
      // cached. Audit on 5 Jun 2026 logged 16 hits to that one reg.
      vdgResponded: true,
    };
  } catch (err) {
    // [B] Parsing/network error after the HTTP response. If it was a
    // network/timeout we got here via fetchWithRetry which already gave
    // up. Treat as transient (do not cache). If it was a JSON parsing
    // failure of a 200 response, that's a VDG schema change and is a
    // bug to investigate, not a cost concern.
    console.error("VDG lookup failed:", err.message);
    return null;
  }
}

// ============================================================
// VEHICLE IMAGE LOOKUP (VDG — Vehicle Image Details package)
// ============================================================
//
// Adds an actual photo of the customer's car to the response.
// Costs ~£0.01–£0.02 per call. Defensive parsing because VDG's
// response shape for this package isn't fully documented — we
// try several likely structures and log what we got.
//
// Returns: image URL string, or null if no image / failure.

async function lookupVDGImage(reg) {
  try {
    // VDG's package name for car photos is "VehicleImage" (singular, no
    // "Details" suffix). Their marketing/pricing material calls it
    // "Vehicle Image Details" — DON'T trust that. The actual API
    // package name is just "VehicleImage". Confirmed via Tony's screen
    // recording of the VDG Quick Lookup dashboard 22 May 2026.
    // The response is still wrapped in Results.VehicleImageDetails
    // (yes, naming inconsistency on VDG's side) — our parser below
    // handles that already.
    const url = `${VDG_URL_BASE}?packagename=VehicleImage&apikey=${process.env.VEHICLE_DATA_API_KEY}&vrm=${encodeURIComponent(reg)}`;
    const res = await fetchWithRetry(url, { method: "GET" }, "VDG-Image");

    if (!res.ok) {
      console.warn(`VDG-Image returned HTTP ${res.status} for ${reg}`);
      return null;
    }

    const data = await res.json();

    const details =
      data?.Results?.VehicleImageDetails ||
      data?.Results?.ImageDetails ||
      data?.Results ||
      {};

    const imageList =
      details.ImageDetailsList ||
      details.VehicleImageList ||
      details.ImageList ||
      details.Images ||
      [];

    // Return an ARRAY of candidate images with their colour metadata so
    // the caller can pick the one matching the customer's actual colour.
    // VDG often returns multiple library photos per vehicle, one per
    // colour they happen to have on file. Blindly grabbing the first
    // means we show e.g. a Black Ford to someone who owns a Yellow Ford,
    // which is the bug that made Rick's friend say he wouldn't have
    // pressed Order.
    const candidates = imageList
      .map((img) => ({
        url:
          img.ImageUrl ||
          img.Url ||
          img.URL ||
          img.Src ||
          null,
        colourDesc: img.Description || img.Colour || img.ColourDescription || null,
        colourCode: img.ColourCode || img.ColorCode || null,
        viewAngle: img.ViewAngle || null,
      }))
      .filter((c) => c.url);

    if (candidates.length === 0) {
      console.log(
        `VDG-Image: no usable images for ${reg}. ` +
        `Top-level keys: ${JSON.stringify(Object.keys(data?.Results || {}))}. ` +
        `Details keys: ${JSON.stringify(Object.keys(details))}`
      );
      return null;
    }

    console.log(
      `VDG-Image: ${candidates.length} candidate(s) for ${reg} — ` +
      `colours: ${candidates.map((c) => c.colourDesc || "?").join(", ")}`
    );
    return candidates;
  } catch (err) {
    console.error("VDG-Image lookup failed:", err.message);
    return null;
  }
}

// ============================================================
// COLOUR MATCH — pick the VDG image that matches customer colour
// ============================================================
//
// VDG returns library photos in whatever colours they happen to have.
// We compare each image's colour description against the customer's
// actual colour (from DVLA + VDG paint). If we find a match, we use
// that image. If we don't, we return null — better to show NO image
// than a misleading one in the wrong colour.
//
// "Match" means sharing a meaningful colour word — "Denim Blue" matches
// "Blue", "Cosmos Black" matches "Black", "Signal Red Metallic" matches
// "Red". Generic non-colour words like "Metallic", "Pearl", "Pure" are
// ignored.

const COLOUR_NOISE_WORDS = new Set([
  "metallic", "pearl", "pearlescent", "matte", "matt", "gloss", "satin",
  "premium", "solid", "effect", "mica", "tinted", "deep", "light", "dark",
  "the", "of", "and", "with", "a", "an", "ii", "iii", "iv",
]);

function colourWords(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[\s\-_/\\,()]+/)
    .filter(Boolean)
    .filter((w) => w.length >= 3 && !COLOUR_NOISE_WORDS.has(w));
}

function coloursMatch(customerColour, imageColour) {
  if (!customerColour || !imageColour) return false;
  const a = new Set(colourWords(customerColour));
  const b = new Set(colourWords(imageColour));
  for (const word of a) {
    if (b.has(word)) return true;
  }
  return false;
}

function pickBestImage(candidates, customerColour, customerPaintName, reg) {
  if (!candidates || candidates.length === 0) return null;

  // STRICT MATCHING (post-BU23CRK incident, 27 May 2026):
  // The friend's Volvo Nebula came back as "Light Green" from VDG and
  // the customer-perceived colour was a pale grey-green-pearl. DVLA
  // happened to classify the car as "Green" and our old code matched
  // on the shared word "green", showing a vivid neon-green stock photo.
  // The friend said he wouldn't have pressed Order.
  //
  // New rule: when we have a specific paint name (like "Nebula"), we
  // REQUIRE both the paint name AND the customer colour to share a
  // meaningful colour word with the image's Description. "Nebula" does
  // not share a colour word with "Light Green" — so we hide, even if
  // "Green" does match. Reduces false positives at the cost of more
  // false negatives, which the silhouette fallback will cover.
  //
  // When we DON'T have a paint name (paint_not_found path), we fall
  // back to just matching against the customer colour — less reliable
  // but the best signal available in that case.
  const hasPaintName = Boolean(customerPaintName);

  for (const c of candidates) {
    if (!c.colourDesc) continue;

    const colourMatches = customerColour && coloursMatch(customerColour, c.colourDesc);
    const paintNameMatches = customerPaintName && coloursMatch(customerPaintName, c.colourDesc);

    const isMatch = hasPaintName
      ? (colourMatches && paintNameMatches)  // both must agree
      : colourMatches;                       // colour alone if no paint name

    if (isMatch) {
      console.log(
        `VDG-Image: matched ${reg} ` +
        `customer="${customerColour}" paint="${customerPaintName || "(none)"}" ` +
        `→ image="${c.colourDesc}"`
      );
      return c.url;
    }
  }

  console.log(
    `VDG-Image: NO MATCH for ${reg}. ` +
    `Customer colour="${customerColour}" paint="${customerPaintName || "(none)"}". ` +
    `Available image colours: ${candidates.map((c) => c.colourDesc || "?").join(", ")}. ` +
    `Hiding image — silhouette fallback should kick in on the frontend.`
  );
  return null;
}

// ============================================================
// SILHOUETTE KEY
// ============================================================
//
// Maps DVLA/VDG body type strings to a small set of silhouette names.
// The frontend uses this key to pick which SVG car shape to display
// behind the paint preview. Far better than "SUV or generic blob."
//
// Body types from real APIs are inconsistent — we match on contains
// rather than equals so things like "PANEL VAN" and "VAN" both work.

// MODEL → silhouette key. Most-specific reliable signal: if we recognise
// the model name, ignore the body-type string and use this.
const MODEL_TO_SILHOUETTE = {
  // ===== City cars (small, tall, blocky) =====
  PICANTO: "citycar", AYGO: "citycar", I10: "citycar", "UP!": "citycar", UP: "citycar",
  TWINGO: "citycar", PANDA: "citycar", "500": "citycar", "108": "citycar",
  C1: "citycar", MII: "citycar", FORTWO: "citycar", FORFOUR: "citycar",
  KA: "citycar", "KA+": "citycar", ALTO: "citycar", CELERIO: "citycar",
  GO: "citycar", "GO+": "citycar", SPARK: "citycar", I3: "citycar",
  // ===== Small / mid hatchbacks =====
  FIESTA: "hatchback", POLO: "hatchback", CORSA: "hatchback", IBIZA: "hatchback",
  CLIO: "hatchback", MICRA: "hatchback", "208": "hatchback", "308": "hatchback",
  I20: "hatchback", I30: "hatchback", RIO: "hatchback", JAZZ: "hatchback",
  FABIA: "hatchback", SWIFT: "hatchback", BALENO: "hatchback", SANDERO: "hatchback",
  YARIS: "hatchback", AURIS: "hatchback", GOLF: "hatchback", FOCUS: "hatchback",
  ASTRA: "hatchback", LEON: "hatchback", MEGANE: "hatchback", PEUGEOT: "hatchback",
  CIVIC: "hatchback", PULSAR: "hatchback", "1 SERIES": "hatchback",
  "A-CLASS": "hatchback", A1: "hatchback", A3: "hatchback", MINI: "hatchback",
  COOPER: "hatchback",
  // ===== SUVs / crossovers / "soft-roaders" =====
  XC40: "suv", XC60: "suv", XC70: "suv", XC90: "suv",
  Q2: "suv", Q3: "suv", Q4: "suv", Q5: "suv", Q7: "suv", Q8: "suv",
  X1: "suv", X2: "suv", X3: "suv", X4: "suv", X5: "suv", X6: "suv", X7: "suv",
  QASHQAI: "suv", JUKE: "suv", "X-TRAIL": "suv", ARIYA: "suv",
  SPORTAGE: "suv", SORENTO: "suv", STONIC: "suv", NIRO: "suv", EV6: "suv",
  TUCSON: "suv", KONA: "suv", BAYON: "suv", IONIQ5: "suv",
  RAV4: "suv", "C-HR": "suv", CHR: "suv", "YARIS CROSS": "suv",
  "CR-V": "suv", "HR-V": "suv", "ZR-V": "suv", PILOT: "suv",
  TIGUAN: "suv", TOUAREG: "suv", "T-ROC": "suv", "T-CROSS": "suv", "ID.4": "suv",
  ATECA: "suv", ARONA: "suv", TARRACO: "suv",
  KAROQ: "suv", KAMIQ: "suv", KODIAQ: "suv", ENYAQ: "suv",
  GLA: "suv", GLB: "suv", GLC: "suv", GLE: "suv", GLS: "suv", EQA: "suv", EQB: "suv",
  DISCOVERY: "suv", DEFENDER: "suv", FREELANDER: "suv", EVOQUE: "suv", VELAR: "suv",
  C40: "suv", // Volvo coupe-style SUV
  CAPTUR: "suv", KADJAR: "suv", ARKANA: "suv",
  MOKKA: "suv", GRANDLAND: "suv", CROSSLAND: "suv",
  PUMA: "suv", KUGA: "suv", EDGE: "suv", ECOSPORT: "suv",
  "2008": "suv", "3008": "suv", "5008": "suv",
  OUTBACK: "suv", FORESTER: "suv", XV: "suv",
  "CX-3": "suv", "CX-5": "suv", "CX-30": "suv", "CX-60": "suv",
  "MODEL Y": "suv", "MODEL X": "suv",
  // ===== Saloons =====
  "MODEL 3": "saloon", "MODEL S": "saloon",
  A4: "saloon", A6: "saloon", A8: "saloon",
  "3 SERIES": "saloon", "5 SERIES": "saloon", "7 SERIES": "saloon",
  "C-CLASS": "saloon", "E-CLASS": "saloon", "S-CLASS": "saloon",
  PASSAT: "saloon", JETTA: "saloon", SUPERB: "saloon", OCTAVIA: "saloon",
  INSIGNIA: "saloon", MONDEO: "saloon", "I40": "saloon",
  // ===== MPVs / large family carriers =====
  GALAXY: "mpv", "S-MAX": "mpv", ZAFIRA: "mpv", VERSO: "mpv",
  ALHAMBRA: "mpv", SHARAN: "mpv", PICASSO: "mpv", BERLINGO: "mpv",
  TOURAN: "mpv", "B-MAX": "mpv", "C-MAX": "mpv", PRIUS: "mpv",
  // ===== Vans (commercial / passenger) =====
  CADDY: "van", TRANSPORTER: "van", TRANSIT: "van", TRAFIC: "van",
  VIVARO: "van", PARTNER: "van", DOBLO: "van", CONNECT: "van",
  "MASTER": "van", DUCATO: "van", BOXER: "van", SPRINTER: "van",
  // ===== Pickups =====
  HILUX: "pickup", RANGER: "pickup", "D-MAX": "pickup", L200: "pickup",
  AMAROK: "pickup", NAVARA: "pickup",
  // ===== Coupes / sports / convertibles =====
  "MX-5": "convertible", BOXSTER: "convertible", Z4: "convertible",
  TT: "coupe", GR86: "coupe", GT86: "coupe", SUPRA: "coupe",
  "911": "coupe", CAYMAN: "coupe", "718": "coupe", GT4: "coupe",
};

// Maps DVLA/VDG body type strings + model name to a small set of
// silhouette keys. The frontend uses this key to pick which SVG car
// shape to display behind the paint preview, AND the label generator
// uses it to pick the right printed silhouette.
//
// Two-stage resolution: 1) try model-name table (most reliable signal),
// 2) fall back to keyword matching on the body-type string from the API.
function pickSilhouetteKey(bodyType, model) {
  const bt = (bodyType || "").toUpperCase().trim();
  const md = (model || "").toUpperCase().trim();

  // --- Stage 1: model-name table -----------------------------------
  // Try exact match first, then first word (e.g. "PICANTO SE AUTO" → PICANTO),
  // then substring (e.g. "QASHQAI ACENTA PREMIUM" contains QASHQAI).
  if (MODEL_TO_SILHOUETTE[md]) return MODEL_TO_SILHOUETTE[md];
  const firstWord = md.split(/\s+/)[0];
  if (firstWord && MODEL_TO_SILHOUETTE[firstWord]) return MODEL_TO_SILHOUETTE[firstWord];
  for (const key of Object.keys(MODEL_TO_SILHOUETTE)) {
    if (md.includes(key)) return MODEL_TO_SILHOUETTE[key];
  }

  // --- Stage 2: body-type keyword matching (now much more thorough) -----
  // SUV / crossover
  if (bt.includes("SUV") || bt.includes("CROSSOVER") || bt.includes("4X4") ||
      bt.includes("OFF ROAD") || bt.includes("OFF-ROAD") ||
      bt.includes("SPORT UTILITY")) return "suv";
  // City car (DVLA sometimes uses these wordings explicitly)
  if (bt.includes("CITY") || bt.includes("MINI CAR") ||
      bt.includes("SMALL CAR")) return "citycar";
  // Hatchback variants — catch "5 DOOR HATCH", "3-DOOR HATCH", etc.
  if (bt.includes("HATCH") || bt.includes("5 DOOR") || bt.includes("3 DOOR") ||
      bt.includes("5-DOOR") || bt.includes("3-DOOR") ||
      bt.includes("HATCHBACK")) return "hatchback";
  // Saloon
  if (bt.includes("SALOON") || bt.includes("SEDAN") ||
      bt.includes("4 DOOR") || bt.includes("4-DOOR")) return "saloon";
  // Estate / wagon
  if (bt.includes("ESTATE") || bt.includes("WAGON") || bt.includes("TOURER") ||
      bt.includes("AVANT") || bt.includes("TOURING")) return "estate";
  // Coupe
  if (bt.includes("COUPE") || bt.includes("COUPÉ") ||
      bt.includes("FASTBACK")) return "coupe";
  // Convertible
  if (bt.includes("CONVERTIBLE") || bt.includes("CABRIOLET") ||
      bt.includes("CABRIO") || bt.includes("ROADSTER") ||
      bt.includes("SPYDER") || bt.includes("SPIDER")) return "convertible";
  // MPV / people carrier
  if (bt.includes("MPV") || bt.includes("MULTI") ||
      bt.includes("PEOPLE CARRIER") || bt.includes("MINIVAN") ||
      bt.includes("MINI VAN")) return "mpv";
  // Pickup
  if (bt.includes("PICK") || bt.includes("CREW CAB") ||
      bt.includes("DOUBLE CAB") || bt.includes("EXTRA CAB")) return "pickup";
  // Van (after MPV/pickup to avoid overlap)
  if (bt.includes("VAN") || bt.includes("PANEL")) return "van";

  // --- Stage 3: fallback default -----------------------------------
  // "hatchback" is the most accurate default for UK roads — Polo/Fiesta/
  // Corsa-class cars are by far the most common fleet shape and we'd
  // sooner mis-show a hatchback than a saloon for an unknown car.
  return "hatchback";
}

// ============================================================
// CACHE READ/WRITE (memory + Redis)
// ============================================================

async function getCached(reg) {
  const mem = memoryGet(reg);
  if (mem) {
    console.log(`Memory cache hit: ${reg} (imageUrl=${mem.imageUrl ? "set" : "null"})`);
    return mem;
  }
  if (!redisReady()) return null;
  try {
    // [D] CACHE KEY VERSIONING POLICY (5 Jun 2026)
    // -------------------------------------------
    // The "v10" suffix invalidates ALL previously-cached entries
    // when bumped. The Jun 5 VDG audit showed that every bump =
    // 87 unique regs forced to re-hit VDG = ~£8 burned. So:
    //
    //   Only bump this version (v10 → v11 → ...) when the SHAPE
    //   of the cached response actually changes — e.g. we add a
    //   new top-level field that downstream code MUST see. Just
    //   changing internal logic, fixing a parse bug, or tweaking
    //   the silhouette picker DOES NOT justify a bump — the old
    //   cached responses are still valid.
    //
    //   The cost of an unnecessary bump scales linearly with the
    //   number of regs in the cache. At ~100 regs that's pennies;
    //   at 10,000 regs that's £100+.
    const data = await redis.get(`paintlookup_v10:${reg}`);
    if (data) {
      console.log(`Redis cache hit: ${reg} (imageUrl=${data.imageUrl ? "set" : "null"})`);
      memorySet(reg, data);
      return data;
    }
  } catch (err) {
    console.warn("Redis read failed:", err.message);
  }
  return null;
}

async function setCached(reg, data, isNegative) {
  memorySet(reg, data);
  if (!redisReady()) {
    // [B] Loud warning instead of silent skip — silent Redis skips were
    // a contributor to the ML24PCV-style cost bleed: the in-memory cache
    // dies with the Vercel function instance, so without Redis every
    // cold start is a fresh VDG call.
    console.warn(`Redis NOT ready (env vars missing) — ${reg} only in memory cache`);
    return;
  }
  try {
    const ttl = isNegative ? REDIS_NEGATIVE_TTL_SECONDS : REDIS_SUCCESS_TTL_SECONDS;
    console.log(`Caching ${reg} in Redis (ttl=${ttl}s, isNegative=${isNegative})`);
    await redis.set(`paintlookup_v10:${reg}`, data, { ex: ttl });
    // [B] Confirm the write actually succeeded by reading back. Without
    // this, silent Redis failures could leave the function thinking it
    // cached when nothing was persisted. Costs one extra Redis read per
    // miss (negligible) and saves us potentially many VDG calls.
    const verify = await redis.get(`paintlookup_v10:${reg}`);
    if (!verify) {
      console.error(`Redis write VERIFICATION FAILED for ${reg} — next lookup will be a VDG call. Check Upstash dashboard for write errors.`);
    }
  } catch (err) {
    console.error(`Redis save FAILED for ${reg}:`, err.message);
  }
}

// ============================================================
// MAIN HANDLER
// ============================================================

module.exports = async (req, res) => {
  applyCORS(req, res);

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      status: "method_not_allowed",
      error: "POST only",
    });
  }

  try {
    // ---------- 1. INPUT ----------
    const { vrm } = req.body || {};
    if (!vrm) {
      return res.status(400).json({
        ok: false,
        status: "missing_vrm",
        error: "Missing registration",
      });
    }

    const reg = normaliseVRM(vrm);
    if (!isValidVRM(reg)) {
      return res.status(400).json({
        ok: false,
        status: "invalid_vrm",
        error: "That doesn't look like a valid UK registration.",
      });
    }

    // ---------- 1b. TEST-REG OVERRIDE ----------
    // Short-circuit for known test regs (see TEST_REG_OVERRIDES above).
    // Skips rate limit, cache, DVLA, VDG, formula — returns canned data.
    // Costs nothing and matches the real response shape so the frontend
    // doesn't have to do anything different.
    if (TEST_REG_OVERRIDES[reg]) {
      const o = TEST_REG_OVERRIDES[reg];
      console.log(`TEST OVERRIDE: ${reg} — bypassing all external APIs`);
      return res.status(200).json({
        ok: true,
        status: "found",
        vrm: reg,
        vehicle: {
          make: o.make,
          model: o.model,
          colour: o.colour,
          year: o.year,
          fuelType: o.fuelType,
          bodyType: o.bodyType,
        },
        silhouetteKey: pickSilhouetteKey(o.bodyType, o.model),
        imageUrl: null,
        paintCode: o.paintCode,
        paintName: o.paintName,
        paintHex: o.paintHex || null,
        formula: [],
        formulaStatus: "test_override",
        batchSizeMl: 10,
        fromCache: false,
        isTestOverride: true,
      });
    }

    // ---------- 2. RATE LIMIT ----------
    const ip = getClientIP(req);
    const rl = await checkRateLimit(ip);
    if (!rl.allowed) {
      console.warn(`Rate limit exceeded for ${ip}: ${rl.count} req/min`);
      return res.status(429).json({
        ok: false,
        status: "rate_limited",
        error: "Too many lookups. Please wait a minute and try again.",
      });
    }

    // ---------- 3. CACHE ----------
    const cached = await getCached(reg);
    if (cached) {
      return res.status(200).json({ ...cached, fromCache: true });
    }

    console.log(`LIVE lookup: ${reg}`);

    // ---------- 4. PARALLEL DVLA + VDG (paint) ----------
    const [dvla, vdg] = await Promise.all([
      lookupDVLA(reg),
      lookupVDG(reg),
    ]);
    const imageCandidates = null;

    if (!dvla && !vdg) {
      return res.status(200).json({
        ok: false,
        status: "vehicle_not_found",
        message:
          "We couldn't look up that registration. Please double-check it, or use your paint code instead.",
        vrm: reg,
      });
    }

    // ---------- 5. MERGE DATA ----------
    const make = vdg?.make || dvla?.make || null;
    const model = vdg?.model || null;
    const colour = vdg?.colour || dvla?.colour || null;
    const year = dvla?.year || null;
    const fuelType = vdg?.fuelType || dvla?.fuelType || null;
    const bodyType = vdg?.bodyType || dvla?.bodyType || null;
    const paintCode = vdg?.paintCode || null;
    const paintName = vdg?.paintName || null;
    const paintHex = vdg?.paintHex || null;

    const imageUrl = pickBestImage(imageCandidates, colour, paintName, reg);

    // ---------- 6. NO PAINT CODE? ----------
    if (!paintCode) {
      const vdgSucceeded = vdg !== null;

      if (!vdgSucceeded) {
        console.warn(`VDG failed for ${reg}; returning transient (not cached)`);
        return res.status(200).json({
          ok: false,
          status: "lookup_unavailable",
          message:
            "Paint lookup service is having a moment. Please try again in a few seconds.",
          vrm: reg,
          vehicle: { make, model, colour, year, fuelType, bodyType },
        });
      }

      const noPaint = {
        ok: false,
        status: "paint_not_found",
        message:
          "We found your vehicle but couldn't auto-match the paint code. You can enter your paint code manually.",
        vrm: reg,
        vehicle: { make, model, colour, year, fuelType, bodyType },
        silhouetteKey: pickSilhouetteKey(bodyType, model),
        imageUrl: imageUrl || null,
        fromCache: false,
      };
      await setCached(reg, noPaint, true);
      return res.status(200).json(noPaint);
    }

    // ---------- 7. FORMULA ----------
    let formulaResult = { formula: [], status: "unknown", batchSizeMl: 10, paintName: "", hex: "" };
    try {
      formulaResult = await getFormula({ paintCode, brand: make });
    } catch (err) {
      console.error("Formula lookup threw unexpectedly:", err);
    }

    const finalHex = paintHex || formulaResult.hex || null;
    const finalPaintName = paintName || formulaResult.paintName || null;

    // ---------- 8. RESPONSE ----------
    const responseData = {
      ok: true,
      status: "found",
      vrm: reg,
      vehicle: { make, model, colour, year, fuelType, bodyType },
      silhouetteKey: pickSilhouetteKey(bodyType, model),
      imageUrl: imageUrl || null,
      paintCode,
      paintName: finalPaintName,
      paintHex: finalHex,
      formula: formulaResult.formula || [],
      formulaStatus: formulaResult.status || "unknown",
      batchSizeMl: formulaResult.batchSizeMl || 10,
      fromCache: false,
    };

    await setCached(reg, responseData, false);

    return res.status(200).json(responseData);
  } catch (err) {
    console.error("Lookup fatal error:", err);
    return res.status(500).json({
      ok: false,
      status: "server_error",
      error: "Unexpected error",
    });
  }
};
ving a moment. Please try again in a few seconds.",
          vrm: reg,
          vehicle: { make, model, colour, year, fuelType, bodyType },
        });
      }

      const noPaint = {
        ok: false,
        status: "paint_not_found",
        message:
          "We found your vehicle but couldn't auto-match the paint code. You can enter your paint code manually.",
        vrm: reg,
        vehicle: { make, model, colour, year, fuelType, bodyType },
        silhouetteKey: pickSilhouetteKey(bodyType, model),
        imageUrl: imageUrl || null, // we still have an image even if no paint
        fromCache: false,
      };
      await setCached(reg, noPaint, true);
      return res.status(200).json(noPaint);
    }

    // ---------- 7. FORMULA (INLINE CALL) ----------
    // The chef no longer phones himself for the recipe — just opens the book.
    let formulaResult = { formula: [], status: "unknown", batchSizeMl: 10, paintName: "", hex: "" };
    try {
      formulaResult = await getFormula({ paintCode, brand: make });
    } catch (err) {
      console.error("Formula lookup threw unexpectedly:", err);
    }

    // Hex priority: VDG (almost never has it) → formula sheet hex column
    // → null. The formula sheet hex grows over time as Rick adds paints,
    // so this gets better as the database grows.
    const finalHex = paintHex || formulaResult.hex || null;
    // Paint name priority: VDG (usually has this) → formula sheet name
    // → whatever we already have. VDG wins because for reg lookups it's
    // always present and authoritative.
    const finalPaintName = paintName || formulaResult.paintName || null;

    // ---------- 8. RESPONSE ----------
    const responseData = {
      ok: true,
      status: "found",
      vrm: reg,
      vehicle: { make, model, colour, year, fuelType, bodyType },
      silhouetteKey: pickSilhouetteKey(bodyType, model),
      imageUrl: imageUrl || null, // photo of the customer's actual car
      paintCode,
      paintName: finalPaintName,
      paintHex: finalHex,         // exact hex from formula sheet when set
      formula: formulaResult.formula || [],
      formulaStatus: formulaResult.status || "unknown",
      batchSizeMl: formulaResult.batchSizeMl || 10,
      fromCache: false,
    };

    // ---------- 9. CACHE THE WIN ----------
    await setCached(reg, responseData, false);

    return res.status(200).json(responseData);
  } catch (err) {
    console.error("Lookup fatal error:", err);
    return res.status(500).json({
      ok: false,
      status: "server_error",
      error: "Unexpected error",
    });
  }
};