const fetch = require('node-fetch');
const fs = require("fs");
const path = require("path");

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
    (r) => (r.make || "").toUpperCase() === m && (r.colour || "").toUpperCase() === c
  );
}

module.exports = async (req, res) => {
  try {
    // ✅ CORS headers (lets Wix/Hoppscotch call your API)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // ✅ Handle preflight request
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'POST only' });
    }

    const { vrm } = req.body;

    if (!vrm) {
      return res.status(400).json({ error: 'Missing VRM' });
    }

    const reg = vrm.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

  // --- DVLA lookup ---
const dvlaUrl = "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles";

let dvlaData;
try {
  const dvlaRes = await fetch(dvlaUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.DVLA_API_KEY,
    },
    body: JSON.stringify({ registrationNumber: reg }),
  });

  const text = await dvlaRes.text(); // read as text first, then JSON parse
  dvlaData = text ? JSON.parse(text) : null;

  if (!dvlaRes.ok) {
    return res.status(dvlaRes.status).json({
      ok: false,
      error: "DVLA error",
      status: dvlaRes.status,
      details: dvlaData,
    });
  }
} catch (err) {
  return res.status(500).json({
    ok: false,
    error: "Failed to contact DVLA",
    details: String(err),
  });
}
const paintMatch = findPaintMatch(dvlaData?.make, dvlaData?.colour);

return res.json({
  ok: true,
  dvlaKeyPresent: !!process.env.DVLA_API_KEY, // safe: doesn't reveal the key
  vrm: reg,

  // Raw DVLA response (useful while we’re building)


  // Friendly vehicle object (we’ll refine this)
  vehicle: {
    make: dvlaData?.make || null,
    model: dvlaData?.model || null,
    colour: dvlaData?.colour || null,
    year: dvlaData?.yearOfManufacture || null,
    fuelType: dvlaData?.fuelType || null,
  },

  // Your current demo paint mapping (next we’ll replace this with real matching)
paintCode: paintMatch?.paintCode || null,
paintName: paintMatch?.paintName || null,
swatch: paintMatch?.swatch || null,
recipe: paintMatch?.recipe || null,
});
  } catch (err) {
    return res.status(500).json({ ok: false, error: "lookup failed", details: String(err) });
  }
};
