// ============================================================
// dropbox-auth.js — one-off: connect Dropbox with a refresh token
// ============================================================
//
// Rick opens (same password as the hit-rate page):
//   https://paint-lookup.vercel.app/api/dropbox-auth?key=YOUR_MISSES_KEY
// → it sends him to Dropbox to click "Allow"
// → Dropbox sends him back here with a one-time code
// → we swap that for a refresh token and save it in Redis
//   (key pmp:dropbox:refresh). Labels use it from then on, for good.
//
// Needs env vars DROPBOX_APP_KEY and DROPBOX_APP_SECRET, and this
// exact Redirect URI added in the Dropbox app console:
//   https://paint-lookup.vercel.app/api/dropbox-auth
// The refresh token is never shown on screen or in logs.
// ============================================================

const crypto = require("crypto");
const dropbox = require("./_dropbox");

const REDIRECT_URI = "https://paint-lookup.vercel.app/api/dropbox-auth";
const STATE_PREFIX = "pmp:dropbox:state:";

function html(title, msg) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#eee;padding:32px;max-width:640px}
h1{font-size:22px}.box{background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:16px 18px;line-height:1.5}</style>
</head><body><h1>${title}</h1><div class="box">${msg}</div></body></html>`;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const q = req.query || {};
  const appKey = process.env.DROPBOX_APP_KEY;
  const appSecret = process.env.DROPBOX_APP_SECRET;
  const redis = dropbox.getRedis();

  if (!appKey || !appSecret || !redis) {
    return res.status(200).send(html("Not set up yet",
      "Add <b>DROPBOX_APP_KEY</b> and <b>DROPBOX_APP_SECRET</b> in Vercel → Settings → Environment Variables, redeploy, then open this page again."));
  }

  // Step 2: Dropbox sent us back with a code
  if (q.code || q.error) {
    if (q.error) return res.status(200).send(html("Not connected", `Dropbox said: ${String(q.error_description || q.error).replace(/</g, "&lt;")}`));
    const ok = q.state && (await redis.get(STATE_PREFIX + q.state));
    if (!ok) return res.status(200).send(html("Link expired", "That sign-in link has expired. Open the start link again."));
    await redis.del(STATE_PREFIX + q.state);

    const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(q.code),
        redirect_uri: REDIRECT_URI,
        client_id: appKey,
        client_secret: appSecret,
      }).toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.refresh_token) {
      console.error("[dropbox-auth] exchange failed", r.status, data && data.error);
      return res.status(200).send(html("Not connected", "Dropbox didn't give us a refresh token. Check the app key/secret and the Redirect URI, then try again."));
    }
    await redis.set(dropbox.REFRESH_KEY, data.refresh_token);

    // Prove it works: get a fresh access token with it.
    try {
      await dropbox.getAccessToken();
    } catch (e) {
      return res.status(200).send(html("Saved, but test failed", String(e.message).replace(/</g, "&lt;")));
    }
    return res.status(200).send(html("✅ Dropbox connected for good",
      "Labels will now upload without the token ever expiring. You can delete the old <b>DROPBOX_TOKEN</b> from Vercel whenever you like."));
  }

  // Step 1: start — needs the password
  const expected = process.env.MISSES_KEY;
  if (!expected || q.key !== expected) return res.status(404).send("Not found");

  const state = crypto.randomBytes(16).toString("hex");
  await redis.set(STATE_PREFIX + state, "1", { ex: 600 });
  const url = "https://www.dropbox.com/oauth2/authorize?" + new URLSearchParams({
    client_id: appKey,
    response_type: "code",
    token_access_type: "offline",
    redirect_uri: REDIRECT_URI,
    state,
  }).toString();
  res.statusCode = 302;
  res.setHeader("Location", url);
  return res.end();
};
