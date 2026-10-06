// ============================================================
// misses.js — Hit-rate report (Vercel serverless function)
// ============================================================
//
// Open in a browser:
//   https://paint-lookup.vercel.app/api/misses?key=YOUR_MISSES_KEY
//   ...&format=csv   → download the miss list as a spreadsheet
//
// Shows how many unique regs were looked up live, how many found a
// paint code, and the most recent misses with the reason for each.
// Fed by logOutcome() in lookup.js.
//
// SECURITY: needs the MISSES_KEY environment variable set in Vercel.
// If it isn't set, this page is switched off (404). The list contains
// number plates, so keep the key private.
// ============================================================

const { Redis } = require("@upstash/redis");

const STATS_PREFIX = "pmp:stats:";
const MISS_LIST_KEY = "pmp:misses";
const REASONS = ["hit_recipe", "hit_name_only", "code_not_in_sheet", "vdg_no_code", "vehicle_not_found"];

const REASON_LABELS = {
  hit_recipe: "Code found + recipe on file",
  hit_name_only: "Code found (no recipe in sheet yet)",
  code_not_in_sheet: "Code found but not in sheet — add it / an alias",
  vdg_no_code: "No paint code from VDG — customer miss",
  vehicle_not_found: "Reg not recognised by DVLA or VDG",
};

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function csvCell(s) {
  const v = String(s == null ? "" : s);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

module.exports = async (req, res) => {
  const expected = process.env.MISSES_KEY;
  const given = (req.query && req.query.key) || "";
  if (!expected || given !== expected) {
    return res.status(404).send("Not found");
  }
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(503).send("Redis not configured");
  }

  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  const keys = [STATS_PREFIX + "live", ...REASONS.map((r) => STATS_PREFIX + r)];
  const values = await redis.mget(...keys);
  const live = Number(values[0]) || 0;
  const counts = {};
  REASONS.forEach((r, i) => { counts[r] = Number(values[i + 1]) || 0; });

  const raw = await redis.lrange(MISS_LIST_KEY, 0, 499);
  const misses = (raw || []).map((m) => (typeof m === "string" ? JSON.parse(m) : m));

  if (req.query.format === "csv") {
    const head = ["when", "reason", "reg", "make", "model", "year", "colour", "vdg_codes", "vdg_names", "shortlist_size"];
    const lines = [head.join(",")].concat(misses.map((m) => [
      m.ts, m.reason, m.vrm, m.make, m.model, m.year, m.colour,
      (m.codes || []).join(" | "), (m.vdgNames || [m.vdgName].filter(Boolean)).join(" | "), m.shortlist,
    ].map(csvCell).join(",")));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=paintmatchpen-misses.csv");
    return res.status(200).send(lines.join("\n"));
  }

  const gotCode = counts.hit_recipe + counts.hit_name_only + counts.code_not_in_sheet;
  const vehicleFound = live - counts.vehicle_not_found;
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 + "%" : "–");

  const rows = misses.slice(0, 300).map((m) => `
    <tr class="r-${esc(m.reason)}">
      <td>${esc((m.ts || "").replace("T", " ").slice(0, 16))}</td>
      <td>${esc(REASON_LABELS[m.reason] || m.reason)}</td>
      <td><b>${esc(m.vrm)}</b></td>
      <td>${esc([m.year, m.make, m.model].filter(Boolean).join(" "))}</td>
      <td>${esc(m.colour)}</td>
      <td>${esc((m.codes || []).join(" | "))}</td>
      <td>${esc((m.vdgNames || [m.vdgName].filter(Boolean)).join(" | "))}</td>
      <td>${m.shortlist == null ? "" : esc(m.shortlist)}</td>
    </tr>`).join("");

  const statRows = REASONS.map((r) => `
    <tr><td>${esc(REASON_LABELS[r])}</td><td><b>${counts[r]}</b></td><td>${pct(counts[r], live)}</td></tr>`).join("");

  const csvHref = `?key=${encodeURIComponent(given)}&format=csv`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>PaintMatchPen — lookup hit rate</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0a0a0a;color:#eee;margin:0;padding:24px}
  h1{margin:0 0 4px;font-size:22px} .sub{color:#999;margin-bottom:20px}
  .big{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px}
  .card{background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:16px 20px;min-width:180px}
  .card .n{font-size:32px;font-weight:800;color:#FBD300} .card .l{color:#aaa;font-size:13px}
  table{border-collapse:collapse;width:100%;font-size:13px;margin-bottom:28px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #222;vertical-align:top}
  th{color:#999;font-weight:600}
  tr.r-vdg_no_code td:nth-child(2){color:#ff8a80}
  tr.r-code_not_in_sheet td:nth-child(2){color:#ffd180}
  tr.r-vehicle_not_found td:nth-child(2){color:#999}
  a{color:#FBD300}
</style></head><body>
<h1>Lookup hit rate</h1>
<div class="sub">Unique regs looked up live (repeat lookups of the same reg come from cache and aren't counted). <a href="${csvHref}">Download misses as CSV</a></div>
<div class="big">
  <div class="card"><div class="n">${live}</div><div class="l">live lookups</div></div>
  <div class="card"><div class="n">${pct(gotCode, vehicleFound)}</div><div class="l">got a paint code<br>(of vehicles found)</div></div>
  <div class="card"><div class="n">${pct(counts.hit_recipe + counts.hit_name_only, vehicleFound)}</div><div class="l">code is in your sheet</div></div>
</div>
<table><tr><th>Outcome</th><th>Count</th><th>% of live</th></tr>${statRows}</table>
<h2 style="font-size:16px">Recent misses (newest first)</h2>
<table>
  <tr><th>When (UTC)</th><th>Reason</th><th>Reg</th><th>Vehicle</th><th>DVLA colour</th><th>VDG codes</th><th>VDG colour names</th><th>Shortlist</th></tr>
  ${rows || '<tr><td colspan="8">No misses logged yet.</td></tr>'}
</table>
</body></html>`);
};
