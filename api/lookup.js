const fetch = require("node-fetch");

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

function clean(value = "") {
  return String(value).trim();
}

function normaliseMipaCode(code = "") {
  const raw = clean(code).toUpperCase();

  return raw
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

function getFirstPaintFromVehicleData(vehicleData) {
  const paintList =
    vehicleData?.PaintCodeDetails?.PaintCodeList ||
    vehicleData?.paintCodeDetails?.paintCodeList ||
    vehicleData?.PaintCodeList ||
    vehicleData?.paintCodeList ||
    [];

  if (Array.isArray(paintList) && paintList.length > 0) {
    const first = paintList[0];

    return {
      code: clean(first.Code || first.code || ""),
      description: clean(first.Description || first.description || "")
    };
  }

  return {
    code: "",
    description: ""
  };
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

    if (!vrm) {
      return res.status(400).json({ ok: false, error: "Missing VRM" });
    }

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
          "x-api-key": process.env.DVLA_API_KEY
        },
        body: JSON.stringify({ registrationNumber: reg })
      }
    );

    const dvlaText = await dvlaRes.text();
    const dvlaData = dvlaText ? JSON.parse(dvlaText) : {};

    if (!dvlaRes.ok) {
      return res.status(dvlaRes.status).json({
        ok: false,
        error: "DVLA error"
      });
    }

    let make = dvlaData?.make || null;
    let model = dvlaData?.model || null;
    let colour = dvlaData?.colour || null;
    let year = dvlaData?.yearOfManufacture || null;
    let fuelType = dvlaData?.fuelType || null;
    let bodyType = dvlaData?.bodyType || null;

    /* =========================
       Vehicle Data Global paint lookup
    ========================= */

    let rawPaintCode = null;
    let paintCode = null;
    let mipaSearchCode = null;
    let paintName = null;
    let vehicleDataError = null;
    let vehicleDataStatus = null;

    try {
      const vehicleRes = await fetch(
        `https://api.vehicledata.co.uk/vehicle?vrm=${encodeURIComponent(reg)}`,
        {
          method: "GET",
          headers: {
            "x-api-key": process.env.VEHICLE_DATA_API_KEY
          }
        }
      );

      vehicleDataStatus = vehicleRes.status;

      const vehicleText = await vehicleRes.text();
      const vehicleData = vehicleText ? JSON.parse(vehicleText) : {};

      if (!vehicleRes.ok) {
        vehicleDataError =
          vehicleData?.error ||
          vehicleData?.Error ||
          vehicleData?.StatusMessage ||
          "Vehicle Data API error";
      } else {
        const apiPaint = getFirstPaintFromVehicleData(vehicleData);

        rawPaintCode = apiPaint.code || null;
        paintCode = apiPaint.code || null;
        mipaSearchCode = normaliseMipaCode(apiPaint.code || "");
        paintName = apiPaint.description || null;

        // Prefer richer VDG data if present
        const details = vehicleData?.PaintCodeDetails || vehicleData?.paintCodeDetails || {};
        make = details.Make || details.make || make;
        model = details.Model || details.model || model;
        fuelType = details.FuelType || details.fuelType || fuelType;
        colour = details.CurrentColour || details.currentColour || colour;
      }
    } catch (err) {
      vehicleDataError = "Failed to contact Vehicle Data API";
    }

    const silhouetteKey = pickSilhouetteKey(make, model, bodyType);

    /* =========================
       Formula lookup
       Only use REAL API paint codes.
    ========================= */

    let formula = null;
    let formulaError = null;

    if (mipaSearchCode) {
      try {
        const host = req.headers.host;
        const proto = req.headers["x-forwarded-proto"] || "https";
        const baseUrl = `${proto}://${host}`;

        const formulaRes = await fetch(`${baseUrl}/api/formula`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paintCode: mipaSearchCode,
            batchSize: finalBatchSize
          })
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

      vehicle: {
        make,
        model,
        colour,
        year,
        fuelType,
        bodyType
      },

      silhouetteKey,

      // The real useful stuff
      rawPaintCode,
      paintCode,
      mipaSearchCode,
      paintName,

      batchSize: finalBatchSize,
      formula,
      formulaError,

      // Debug info while testing
      source: paintCode ? "vehicle-data-global" : "no-paint-code-found",
      vehicleDataStatus,
      vehicleDataError
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "lookup failed"
    });
  }
};
