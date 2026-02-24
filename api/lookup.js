const fetch = require('node-fetch');

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

    // TEMP TEST RESPONSE (so we know it works)
    return res.json({
      ok: true,
      vrm: reg,
      vehicle: {
        make: "Volvo",
        model: "XC90",
        year: 2019
      },
      paintCode: "717",
      paintName: "Onyx Black",
      swatch: "#0B0B0B",
      recipe: "base:60;black:40"
    });

  } catch (err) {
    return res.status(500).json({ error: 'lookup failed' });
  }
};
