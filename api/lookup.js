const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

/* =========================
   Paint CSV helpers
========================= */

function loadPaintCodes() {
  const filePath = path.join(process.cwd(), "data", "paintcodes.csv");
  const raw = fs.readFileSync(filePath, "utf8").trim();
  const lines = raw.split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());

  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.trim());
    const row = {};
    headers.forEach((h, i) => (row[h] = cols[i] ?? ""));
    return row;
  });
}

function findPaintMatch(make, colour) {
  const rows = loadPaintCodes();
  const m = (make || "").toUpperCase();
  const c = (colour || "").toUpperCase();

  return rows.find(
    (r) =>
      (r.make || "").toUpperCase() === m &&
      (r.colour || "").toUpperCase() === c
  );
}

/* =========================
   Silhouette logic
========================= */

function pickSilhouetteKey(make, model, bodyType) {
  const md = (model || "").toUpperCase();
  const bt = (bodyType || "").toUpperCase();
  const mk = (make || "").toUpperCase();

  if (md.includes("XC")) return "suv";
  if (bt.includes("SUV")) return "suv";

  return "generic";
}

function getBaseUrl(req) {
  const host = req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

/* =========================
   API Handler
========================= */

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

    /* =========================
       DVLA lookup
    ========================= */

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

    const make = dvlaData?.make || null;
    const model = dvlaData?.model || null;
    const colour = dvlaData?.colour || null;
    const year = dvlaData?.yearOfManufacture || null;
    const fuelType = dvlaData?.fuelType || null;
    const bodyType = dvlaData?.bodyType || null;

    /* =========================
       REAL Paint Code API
    ========================= */

    let finalPaintCode = null;
    let finalPaintName = null;

    try {
      const vehicleRes = await fetch(
        `https://uk.api.vehicledataglobal.com/r2/lookup?packagename=PaintCodeDetails&apikey=${process.env.VEHICLE_DATA_API_KEY}&vrm=${reg}`
      );

      const vehicleData = await vehicleRes.json();

      console.log("PAINT API RESPONSE:", JSON.stringify(vehicleData));

      const paintList =
        vehicleData?.Results?.PaintCodeDetails?.PaintCodeList || [];

      if (paintList.length > 0) {
        finalPaintCode = paintList[0].Code;
        finalPaintName = paintList[0].Description;
      }

      console.log("PAINT CODE:", finalPaintCode);
      console.log("PAINT NAME:", finalPaintName);
    } catch (err) {
      console.log("Paint API failed:", err);
    }

    /* =========================
       🔴 HARD STOP (NO FALLBACK)
    ========================= */

    if (!finalPaintCode) {
      return res.json({
        ok: false,
        error: "REAL API RETURNED NO PAINT CODE",
        vrm: reg,
        make,
        model,
        colour
      });
    }

    const silhouetteKey = pickSilhouetteKey(make, model, bodyType);

    /* =========================
       Formula lookup
    ========================= */

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

    return res.json({
      ok: true,
      vrm: reg,
      vehicle: { make, model, colour, year, fuelType, bodyType },
      silhouetteKey,
      paintCode: finalPaintCode,
      paintName: finalPaintName,
      batchSize: finalBatchSize,
      formula,
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "lookup failed",
    });
  }
};
