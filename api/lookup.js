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
  const mk = (make || "").toUpperCase();
  const md = (model || "").toUpperCase();
  const bt = (bodyType || "").toUpperCase();

  if (md.includes("XC") || md.includes("QASHQAI") || md.includes("SPORTAGE") || md.includes("KUGA") || md.includes("TIGUAN") || md.includes("RANGE") || md.includes("DISCOVERY") || md.includes("EVOQUE")) return "suv";
  if (md.includes("TRANSIT") || md.includes("SPRINTER") || md.includes("VITO") || md.includes("CRAFTER")) return "van";
  if (md.includes("HILUX") || md.includes("RANGER") || md.includes("NAVARA")) return "pickup";
  if (md.includes("ESTATE") || md.includes("TOURER") || md.includes("WAGON")) return "estate";
  if (md.includes("CABRIO") || md.includes("CONVERT")) return "convertible";
  if (md.includes("COUPE")) return "coupe";
  if (md.includes("HATCH")) return "hatch";

  if (mk === "VOLVO" || mk === "LAND ROVER" || mk === "JEEP") return "suv";
  if (mk === "MINI" || mk === "FORD" || mk === "VAUXHALL") return "hatch";

  if (bt.includes("MOTORCYCLE")) return "motorcycle";
  if (bt.includes("PANEL VAN") || bt.includes("VAN")) return "van";
  if (bt.includes("PICKUP")) return "pickup";
  if (bt.includes("ESTATE")) return "estate";
  if (bt.includes("COUPE")) return "coupe";
  if (bt.includes("CONVERTIBLE")) return "convertible";
  if (bt.includes("HATCHBACK")) return "hatch";
  if (bt.includes("SALOON") || bt.includes("SEDAN")) return "sedan";
  if (bt.includes("SUV") || bt.includes("4X4") || bt.includes("CROSSOVER")) return "suv";

  return "generic";
}

/* =========================
   Helper
========================= */

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
       DVLA lookup (basic vehicle data)
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

    if (!dvlaRes.ok) {
      return res.status(dvlaRes.status).json({
        ok: false,
        error: "DVLA error",
      });
    }

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
    let paintMatch = null;

    try {
      const vehicleRes = await fetch(
        `https://uk.api.vehicledataglobal.com/r2/lookup?packagename=PaintCodeDetails&apikey=${process.env.VEHICLE_DATA_API_KEY}&vrm=${reg}`
      );

      const vehicleData = await vehicleRes.json();

      console.log("PAINT API RESPONSE:", vehicleData);

      finalPaintCode =
        vehicleData?.PaintCodeDetails?.PaintCodeList?.[0]?.Code || null;

      finalPaintName =
        vehicleData?.PaintCodeDetails?.PaintCodeList?.[0]?.Description || null;

      console.log("PAINT CODE:", finalPaintCode);
      console.log("PAINT NAME:", finalPaintName);

    } catch (err) {
      console.log("Paint API failed:", err);
    }

    /* =========================
       FALLBACK to CSV
    ========================= */

    if (!finalPaintCode) {
      paintMatch = findPaintMatch(make, colour) || findPaintMatch("", colour);
      finalPaintCode = paintMatch?.paintCode || null;
      finalPaintName = paintMatch?.paintName || null;
    }

    const silhouetteKey = pickSilhouetteKey(make, model, bodyType);

    /* =========================
       Formula lookup
    ========================= */

    let formula = null;
    let formulaError = null;

    if (finalPaintCode) {
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

        if (formulaData.ok) {
          formula = formulaData;
        } else {
          formulaError = formulaData.error || "Formula lookup failed";
        }
      } catch (err) {
        formulaError = "Formula lookup failed";
      }
    }

    return res.json({
      ok: true,
      vrm: reg,
      vehicle: { make, model, colour, year, fuelType, bodyType },
      silhouetteKey,
      paintCode: finalPaintCode,
      paintName: finalPaintName,
      swatch: paintMatch?.swatch || null,
      recipe: paintMatch?.recipe || null,
      batchSize: finalBatchSize,
      formula,
      formulaError,
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "lookup failed",
    });
  }
};
