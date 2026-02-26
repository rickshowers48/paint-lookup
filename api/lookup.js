const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

// ---------- Paint CSV helpers ----------
function loadPaintCodes() {
  const filePath = path.join(process.cwd(), "data", "paintcodes.csv");

  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];

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

// ---------- Silhouette helper ----------
function pickSilhouetteKey(make, model, bodyType) {
  const mk = (make || "").toUpperCase();
  const md = (model || "").toUpperCase();
  const bt = (bodyType || "").toUpperCase();

  // DVLA bodyType first (if present)
  if (bt.includes("MOTORCYCLE")) return "motorcycle";
  if (bt.includes("PANEL VAN") || bt.includes("VAN")) return "van";
  if (bt.includes("PICKUP")) return "pickup";
  if (bt.includes("ESTATE")) return "estate";
  if (bt.includes("COUPE")) return "coupe";
  if (bt.includes("CONVERTIBLE")) return "convertible";
  if (bt.includes("HATCHBACK")) return "hatch";
  if (bt.includes("SALOON") || bt.includes("SEDAN")) return "sedan";
  if (bt.includes("SUV") || bt.includes("4X4") || bt.includes("CROSSOVER")) return "suv";

  // Model keyword rules
  if (md.includes("XC") || md.includes("SPORTAGE") || md.includes("QASHQAI")) return "suv";
  if (md.includes("RANGE") || md.includes("DISCOVERY")) return "suv";
  if (md.includes("TRANSIT") || md.includes("SPRINTER") || md.includes("VITO")) return "van";
  if (md.includes("ESTATE") || md.includes("TOURER") || md.includes("WAGON")) return "estate";
  if (md.includes("CABRIO") || md.includes("CONVERT")) return "convertible";
  if (md.includes("COUPE")) return "coupe";
  if (md.includes("PICKUP") || md.includes("RANGER") || md.includes("HILUX")) return "pickup";

  // Make-based fallbacks
  if (mk === "MINI") return "hatch";
  if (mk === "VOLVO") return "suv";
  if (mk === "FORD") return "hatch";
  if (mk === "VAUXHALL") return "hatch";

  return "generic";
}

module.exports = async (req, res) => {
  try {
    // ---------- CORS ----------
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "POST only" });
    }

    const { vrm } = req.body || {};
    if (!vrm) {
      return res.status(400).json({ ok: false, error: "Missing VRM" });
    }

    const reg = String(vrm).replace(/[^A-Za-z0-9]/g, "").toUpperCase();

    // ---------- DVLA lookup ----------
    const dvlaUrl =
      "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles";

    let dvlaData = null;

    try {
      const dvlaRes = await fetch(dvlaUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.DVLA_API_KEY,
        },
        body: JSON.stringify({ registrationNumber: reg }),
      });

      const text = await dvlaRes.text();
      dvlaData = text ? JSON.parse(text) : null;

      if (!dvlaRes.ok) {
        return res.status(dvlaRes.status).json({
          ok: false,
          error: "DVLA error",
          status: dvlaRes.status,
        });
      }
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: "Failed to contact DVLA",
      });
    }

    const make = dvlaData?.make || null;
    const model = dvlaData?.model || null;
    const colour = dvlaData?.colour || null;
    const year = dvlaData?.yearOfManufacture || null;
    const fuelType = dvlaData?.fuelType || null;
    const bodyType = dvlaData?.bodyType || null;

    // ---------- Paint matching ----------
    let paintMatch = findPaintMatch(make, colour);
    if (!paintMatch) {
      paintMatch = findPaintMatch("", colour); // generic fallback
    }

    // ---------- Silhouette ----------
    const silhouetteKey = pickSilhouetteKey(make, model, bodyType);

    // ---------- Final Response ----------
    return res.json({
      ok: true,
      vrm: reg,
      vehicle: {
        make,
        model,
        colour,
        year,
        fuelType,
      },
      silhouetteKey,
      paintCode: paintMatch?.paintCode || null,
      paintName: paintMatch?.paintName || null,
      swatch: paintMatch?.swatch || null,
      recipe: paintMatch?.recipe || null,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "lookup failed",
    });
  }
};
