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
    };
  } catch (err) {
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

function pickSilhouetteKey(bodyType, model) {
  const bt = (bodyType || "").toUpperCase();
  const md = (model || "").toUpperCase();

  // SUV first because Volvo XC models sometimes report as something else
  if (md.includes("XC") || md.includes("Q3") || md.includes("Q5") || md.includes("Q7")) return "suv";
  if (bt.includes("SUV") || bt.includes("CROSSOVER")) return "suv";

  if (bt.includes("HATCHBACK")) return "hatchback";
  if (bt.includes("SALOON") || bt.includes("SEDAN")) return "saloon";
  if (bt.includes("ESTATE") || bt.includes("WAGON") || bt.includes("TOURER")) return "estate";
  if (bt.includes("COUPE")) return "coupe";
  if (bt.includes("CONVERTIBLE") || bt.includes("CABRIOLET") || bt.includes("ROADSTER")) return "convertible";
  if (bt.includes("MPV") || bt.includes("MULTI")) return "mpv";
  if (bt.includes("PICK")) return "pickup";
  if (bt.includes("VAN")) return "van";

  return "saloon"; // sensible default — most cars on UK roads
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
    const data = await redis.get(`paintlookup_v8:${reg}`);
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
  if (!redisReady()) return;
  try {
    const ttl = isNegative ? REDIS_NEGATIVE_TTL_SECONDS : REDIS_SUCCESS_TTL_SECONDS;
    console.log(`Caching ${reg} (imageUrl=${data.imageUrl ? "set" : "null"}, isNegative=${isNegative})`);
    await redis.set(`paintlookup_v8:${reg}`, data, { ex: ttl });
  } catch (err) {
    console.warn("Redis save failed:", err.message);
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

    // ---------- 4. PARALLEL DVLA + VDG (paint) + VDG (image) ----------
    // All three fired together — total wait is whichever is slowest.
    // Note: lookupVDGImage now returns an ARRAY of candidate images (not
    // a single URL) so we can filter by colour AFTER we know the
    // customer's actual paint colour from the other two calls.
    const [dvla, vdg, imageCandidates] = await Promise.all([
      lookupDVLA(reg),
      lookupVDG(reg),
      lookupVDGImage(reg),
    ]);

    // If BOTH APIs gave us nothing, we genuinely don't know what's wrong:
    // could be a typo, could be a service hiccup, could be an obscure car.
    // We don't cache this — the customer might just have mistyped.
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
    // VDG wins on overlapping fields (it knows paint stuff).
    // DVLA fills in year (VDG doesn't provide year).
    const make = vdg?.make || dvla?.make || null;
    const model = vdg?.model || null;
    const colour = vdg?.colour || dvla?.colour || null;
    const year = dvla?.year || null;
    const fuelType = vdg?.fuelType || dvla?.fuelType || null;
    const bodyType = vdg?.bodyType || dvla?.bodyType || null;
    const paintCode = vdg?.paintCode || null;
    const paintName = vdg?.paintName || null;
    // paintHex will be null for now (VDG probably doesn't return it).
    // The widget's name-to-hex palette is the fallback. Once Rick adds
    // hex codes to his Google Sheets formula database, formula.js will
    // surface them and the swatch will be exact per paint code.
    const paintHex = vdg?.paintHex || null;

    // ---------- 5b. PICK A COLOUR-MATCHING IMAGE ----------
    // Now that we know the customer's actual colour, filter VDG's image
    // candidates and pick one whose Description matches. If no image
    // matches the colour, we return null — the frontend will fall back
    // to a body-type silhouette filled with the customer's actual paint
    // colour, which is always right by construction.
    const imageUrl = pickBestImage(imageCandidates, colour, paintName, reg);

    // ---------- 6. NO PAINT CODE? ----------
    // Two very different reasons we get here, must not be conflated:
    //   (a) VDG had a transient failure (timeout/5xx/network blip) and
    //       returned null. This is NOT "car not supported" — do NOT cache.
    //       Return a soft try-again so a retry can succeed.
    //   (b) VDG actually answered and confirmed it has no paint data for
    //       this vehicle (common for vans, commercials, obscure imports).
    //       This IS legitimate — cache negatively for 7 days to save VDG
    //       budget on repeat lookups.
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
        imageUrl: imageUrl || null, // we still have an image even if no paint
        fromCache: false,
      };
      await setCached(reg, noPaint, true);
      return res.status(200).json(noPaint);
    }

    // ---------- 7. FORMULA (INLINE CALL) ----------
    // The chef no longer phones himself for the recipe — just opens the book.
    let formulaResult = { formula: [], status: "unknown", batchSizeMl: 10 };
    try {
      formulaResult = await getFormula({ paintCode, brand: make });
    } catch (err) {
      console.error("Formula lookup threw unexpectedly:", err);
    }

    // ---------- 8. RESPONSE ----------
    const responseData = {
      ok: true,
      status: "found",
      vrm: reg,
      vehicle: { make, model, colour, year, fuelType, bodyType },
      silhouetteKey: pickSilhouetteKey(bodyType, model),
      imageUrl: imageUrl || null, // photo of the customer's actual car
      paintCode,
      paintName,
      paintHex,                    // exact hex when VDG/formula provides it
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
