// ============================================================
// label-admin.js — fix TBC labels once the paint code is known
// ============================================================
//
// Open in a browser (same password as the hit-rate page):
//   https://paint-lookup.vercel.app/api/label-admin?key=YOUR_MISSES_KEY
//
// Shows every order that came in with paint code "TBC". For each one,
// type the real code (e.g. 9744) and the make, press "Make label":
//   1. the paint name is filled in from your PaintLab sheet (aliases
//      work too), or you can type it yourself
//   2. the proper label is made and dropped into today's
//      PaintMatchPen/Orders folder for Ari, as normal
//   3. the CHECK- label in PaintMatchPen/Code-TBC is deleted
//   4. the order drops off this list
// There's also a blank form at the bottom to make (or remake) a label
// for any reg by hand.
// ============================================================

const dropbox = require("./_dropbox");
const gen = require("./generate-label");
const { getFormula } = require("./formula");

const { labelPaths, PENDING_KEY, mapShortKeyToSilhouetteFile, lookupBodyTypeByReg } = gen._internals;

// Must match the keys in silhouette-paths.json
const BODY_TYPES = [
  "citycar", "mini", "hatchback-mini", "hatchback-small", "hatchback-compact", "hatchback-3door",
  "hatchback-boxy", "hatchback-hot", "hatchback-low", "hatchback-raised", "hatchback-spoiler",
  "hatchback-sport", "saloon", "saloon-executive", "estate", "mpv",
  "crossover-small", "crossover-medium", "suv-compact", "suv-family", "suv-boxy", "suv-modern",
  "suv-tall", "suv-luxury", "suv-rugged",
  "coupe-fastback", "coupe-hatch", "coupe-long", "coupe-sleek", "coupe-sloped", "coupe-sport",
  "sportscar-coupe", "sportscar-low", "sportscar-roadster", "convertible",
  "pickup", "pickup-small", "van", "van-delivery",
];

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
 body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0a0a0a;color:#eee;margin:0;padding:24px;max-width:900px}
 h1{font-size:22px;margin:0 0 6px} .sub{color:#999;margin-bottom:22px}
 .card{background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:16px 18px;margin-bottom:16px}
 .card h2{font-size:17px;margin:0 0 4px;color:#FBD300} .meta{color:#aaa;font-size:13px;margin-bottom:12px}
 label{display:block;font-size:12px;color:#aaa;margin:8px 0 3px}
 input,select{width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid #333;background:#0f0f0f;color:#fff;font-size:15px}
 .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
 button{margin-top:14px;background:#FBD300;color:#000;border:0;border-radius:8px;padding:11px 18px;font-weight:700;font-size:15px;cursor:pointer}
 .ok{border-color:#2e7d32} .err{border-color:#c62828} a{color:#FBD300}
 .hint{color:#888;font-size:12px;margin-top:4px}
</style></head><body>${inner}</body></html>`;
}

function bodySelect(name, selected) {
  return `<select name="${name}"><option value="">Auto (from reg)</option>` +
    BODY_TYPES.map((b) => `<option value="${b}"${b === selected ? " selected" : ""}>${b}</option>`).join("") +
    `</select>`;
}

function form(key, rec, heading) {
  const r = rec || {};
  const firstWord = String(r.vehicle || "").trim().split(/\s+/)[0] || "";
  return `<form class="card" method="POST" action="/api/label-admin?key=${encodeURIComponent(key)}">
  <h2>${esc(heading)}</h2>
  ${rec ? `<div class="meta">${esc(r.vehicle || "")} · DVLA colour: ${esc(r.colour || "?")} · came in ${esc((r.created || "").slice(0, 16).replace("T", " "))}</div>` : ""}
  <input type="hidden" name="id" value="${esc(r.id || "")}">
  <input type="hidden" name="checkPath" value="${esc(r.checkPath || "")}">
  <div class="row">
    <div><label>Registration</label><input name="reg" value="${esc(r.reg || "")}" required></div>
    <div><label>Order number</label><input name="orderId" value="${esc(r.orderId || "")}"></div>
  </div>
  <div class="row">
    <div><label>Make</label><input name="make" value="${esc(firstWord)}" placeholder="e.g. MERCEDES-BENZ"></div>
    <div><label>Paint code</label><input name="paintCode" placeholder="e.g. 9744" required></div>
  </div>
  <div class="row">
    <div><label>Paint name (leave blank to fill from your sheet)</label><input name="paintName" placeholder="e.g. Brilliant Silver Metallic"></div>
    <div><label>Car shape on label</label>${bodySelect("bodyType", r.bodyType)}</div>
  </div>
  <button type="submit">Make label</button>
</form>`;
}

module.exports = async (req, res) => {
  const expected = process.env.MISSES_KEY;
  const key = (req.query && req.query.key) || "";
  if (!expected || key !== expected) return res.status(404).send("Not found");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  const redis = dropbox.getRedis();

  if (req.method === "POST") {
    const b = req.body || {};
    const reg = String(b.reg || "").replace(/\s+/g, "").toUpperCase();
    const paintCode = String(b.paintCode || "").trim().toUpperCase();
    const orderId = String(b.orderId || "").trim();
    const make = String(b.make || "").trim();
    let paintName = String(b.paintName || "").trim();
    let bodyType = String(b.bodyType || "").trim();
    const back = `<p><a href="/api/label-admin?key=${encodeURIComponent(key)}">← Back to TBC orders</a></p>`;

    try {
      if (!reg || !paintCode || paintCode === "TBC") throw new Error("Please enter the registration and the real paint code.");

      let sheetNote = "";
      if (!paintName) {
        const f = await getFormula({ paintCode, brand: make });
        if (f && f.paintName) {
          paintName = f.paintName;
          sheetNote = `Paint name filled from your sheet${f.matchedVia === "alias" ? ` (alias of ${esc(f.sheetCode)})` : ""}.`;
        } else {
          throw new Error(`Code ${paintCode}${make ? " for " + make : ""} isn't in your PaintLab sheet yet, so I don't know its name. Type the paint name in and press Make label again (and add it to the sheet when you can).`);
        }
      }

      if (!bodyType) bodyType = await lookupBodyTypeByReg(reg);
      bodyType = mapShortKeyToSilhouetteFile(bodyType) || "suv-family";

      const eps = await gen.generateLabelEps({ reg, paintName, paintCode, bodyType });
      const path = labelPaths({ reg, orderId, tbc: false });
      await dropbox.uploadFile(eps, path);

      let cleanup = "";
      if (b.checkPath) {
        const d = await dropbox.deleteFile(String(b.checkPath));
        cleanup = d && d.alreadyGone ? "The old CHECK label was already gone." : "The old CHECK label has been deleted.";
      }
      if (redis && b.id) await redis.hdel(PENDING_KEY, String(b.id));

      return res.status(200).send(page("Label made", `<h1>✅ Label made</h1>
<div class="card ok"><div><b>${esc(reg)}</b> · ${esc(paintName)} · <b>${esc(paintCode)}</b> · ${esc(bodyType)}</div>
<div class="meta" style="margin-top:8px">Saved for Ari: ${esc(path)}</div>
<div class="hint">${sheetNote} ${cleanup}</div></div>
<p>Remember to update the paint code on the Wix order too, so your records match.</p>${back}`));
    } catch (err) {
      return res.status(200).send(page("Not made", `<h1>Label not made</h1>
<div class="card err">${esc(err.message)}</div>${back}`));
    }
  }

  // GET — list pending TBC orders
  let pending = [];
  if (redis) {
    try {
      const all = (await redis.hgetall(PENDING_KEY)) || {};
      pending = Object.values(all)
        .map((v) => (typeof v === "string" ? JSON.parse(v) : v))
        .sort((a, b) => String(a.created).localeCompare(String(b.created)));
    } catch (e) {
      console.warn("label-admin: could not read pending list:", e.message);
    }
  }

  const list = pending.length
    ? pending.map((r) => form(key, r, `${r.reg}${r.orderId ? " · order #" + r.orderId : ""}`)).join("")
    : `<div class="card">No TBC orders waiting. 🎉</div>`;

  return res.status(200).send(page("TBC labels", `<h1>TBC orders waiting for a paint code</h1>
<div class="sub">Enter the real code and press Make label. The proper label goes to Ari's folder and the CHECK label is removed.</div>
${list}
<h1 style="margin-top:30px;font-size:18px">Make or remake any label</h1>
<div class="sub">For an order that isn't listed above, or to redo a label.</div>
${form(key, null, "Manual label")}`));
};
