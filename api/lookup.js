const fetch = require("node-fetch");
const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
/* =========================
   In-memory backup cache
========================= */

const paintCache = global.paintCache || new Map();
global.paintCache = paintCache;

const MEMORY_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const REDIS_CACHE_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year

function getCached(reg) {
  const item = paintCache.get(reg);
  if (!item) return null;

  if (Date.now() - item.savedAt > MEMORY_CACHE_TTL_MS) {
    paintCache.delete(reg);
    return null;
  }

  return item.data;
}

function setCached(reg, data) {
  paintCache.set(reg, {
    savedAt: Date.now(),
    data,
  });
}

function redisReady() {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL &&
    process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

async function getPersistentCached(reg) {
  const memoryCached = getCached(reg);
  if (memoryCached) return memoryCached;

  if (!redisReady()) return null;

  try {
    const key = `paintlookup:${reg}`;

    const r = await fetch(
      `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
        },
      }
    );

    const json = await r.json();

    if (!json.result) return null;

    const data = JSON.parse(json.result);
    setCached(reg, data);

    return data;
  } catch (err) {
    console.warn("Redis cache read failed:", err);
    return null;
  }
}

async function setPersistentCached(reg, data) {
  setCached(reg, data);

  if (!redisReady()) return;

  try {
    const key = `paintlookup:${reg}`;

    await fetch(
      `${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          value: JSON.stringify(data),
          ex: REDIS_CACHE_TTL_SECONDS,
        }),
      }
    );
  } catch (err) {
    console.warn("Redis cache save failed:", err);
  }
}

function pickSilhouetteKey(make, model, bodyType) {
  const md = (model || "").toUpperCase();
  const bt = (bodyType || "").toUpperCase();

  if (md.includes("XC")) return "suv";
  if (bt.includes("SUV")) return "suv";

  return "generic";
}

function getBaseUrl(req) {
  const host = req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(200).end();

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "POST only" });
    }

    const { vrm, batchSize } = req.body || {};
    if (!vrm) return res.status(400).json({ ok: false, error: "Missing VRM" });

    const reg = String(vrm).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const finalBatchSize = Number(batchSize) || 15;

    const cached = await getPersistentCached(reg);
    if (cached) {
      return res.json({
        ...cached,
        fromCache: true,
      });
    }

    const dvlaRes = await fetch(
      "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.DVLA_API_KEY,
        },
        body: JSON.stringify({ registrationNumber: reg }),
      }
    );

    const dvlaData = await dvlaRes.json();

    let make = dvlaData?.make || null;
    let model = dvlaData?.model || null;
    let colour = dvlaData?.colour || null;
    let year = dvlaData?.yearOfManufacture || null;
    let fuelType = dvlaData?.fuelType || null;
    let bodyType = dvlaData?.bodyType || null;

    let finalPaintCode = null;
    let finalPaintName = null;

    const vehicleRes = await fetch(
      `https://uk.api.vehicledataglobal.com/r2/lookup?packagename=PaintCodeDetails&apikey=${process.env.VEHICLE_DATA_API_KEY}&vrm=${reg}`
    );

    const vehicleData = await vehicleRes.json();

    console.log("PAINT API RESPONSE:", JSON.stringify(vehicleData));

    const paintDetails = vehicleData?.Results?.PaintCodeDetails || {};
    const paintList = paintDetails?.PaintCodeList || [];

    if (paintList.length > 0) {
      finalPaintCode = paintList[0].Code;
      finalPaintName = paintList[0].Description;

      make = paintDetails.Make || make;
      model = paintDetails.Model || model;
      colour = paintDetails.CurrentColour || colour;
      fuelType = paintDetails.FuelType || fuelType;
    }

    if (!finalPaintCode) {
      return res.json({
        ok: false,
        error: "REAL API RETURNED NO PAINT CODE",
        vrm: reg,
        make,
        model,
        colour,
        fromCache: false,
      });
    }

    const silhouetteKey = pickSilhouetteKey(make, model, bodyType);

    let formula = null;

    try {
      const baseUrl = getBaseUrl(req);

      const formulaRes = await fetch(`${baseUrl}/api/formula`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paintCode: finalPaintCode,
          batchSize: finalBatchSize,
        }),
      });

      const formulaData = await formulaRes.json();
      if (formulaData.ok) formula = formulaData;
    } catch {}

    const responseData = {
      ok: true,
      vrm: reg,
      vehicle: { make, model, colour, year, fuelType, bodyType },
      silhouetteKey,
      paintCode: finalPaintCode,
      paintName: finalPaintName,
      batchSize: finalBatchSize,
      formula,
      fromCache: false,
    };

    await setPersistentCached(reg, responseData);

    return res.json(responseData);
  } catch (err) {
    console.error("Lookup failed:", err);

    return res.status(500).json({
      ok: false,
      error: "lookup failed",
    });
  }
};
