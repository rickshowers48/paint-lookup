// ============================================================
// _dropbox.js — shared Dropbox helper (not an endpoint: the leading
// underscore stops Vercel turning it into a function).
// ============================================================
//
// WHY THIS EXISTS (16 Nov 2026)
// Dropbox's "Generate access token" button gives a SHORT-LIVED token
// (about 4 hours). When it expired, every label upload silently failed —
// that's how order #10133 ended up with no label. This helper uses a
// REFRESH TOKEN instead, which never expires: it swaps it for a fresh
// short-lived token whenever it needs one.
//
// Where the refresh token comes from (first one found wins):
//   1. env DROPBOX_REFRESH_TOKEN
//   2. Redis key pmp:dropbox:refresh  (saved by /api/dropbox-auth)
// It also needs env DROPBOX_APP_KEY and DROPBOX_APP_SECRET.
// If none of that is set up, it falls back to the old DROPBOX_TOKEN so
// nothing breaks before the switch-over.
// ============================================================

const { Redis } = require("@upstash/redis");

const REFRESH_KEY = "pmp:dropbox:refresh";

let redis = null;
function getRedis() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redis;
}

let cachedToken = null;
let cachedUntil = 0;

async function getRefreshToken() {
  if (process.env.DROPBOX_REFRESH_TOKEN) return process.env.DROPBOX_REFRESH_TOKEN;
  const r = getRedis();
  if (!r) return null;
  try {
    return (await r.get(REFRESH_KEY)) || null;
  } catch (e) {
    console.warn("[dropbox] redis read failed:", e.message);
    return null;
  }
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;

  const refresh = await getRefreshToken();
  const appKey = process.env.DROPBOX_APP_KEY;
  const appSecret = process.env.DROPBOX_APP_SECRET;

  if (refresh && appKey && appSecret) {
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: appKey,
        client_secret: appSecret,
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Dropbox token refresh failed ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    cachedToken = data.access_token;
    // Refresh 5 minutes before Dropbox's stated expiry.
    cachedUntil = Date.now() + Math.max(60, (data.expires_in || 14400) - 300) * 1000;
    return cachedToken;
  }

  if (process.env.DROPBOX_TOKEN) {
    console.warn("[dropbox] using legacy short-lived DROPBOX_TOKEN — set up the refresh token");
    return process.env.DROPBOX_TOKEN;
  }
  throw new Error("Dropbox not configured: set DROPBOX_APP_KEY, DROPBOX_APP_SECRET and connect via /api/dropbox-auth");
}

async function uploadFile(buf, dropboxPath) {
  const token = await getAccessToken();
  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path: dropboxPath,
        mode: "overwrite",
        autorename: false,
        mute: true,
      }),
    },
    body: buf,
  });
  if (!res.ok) throw new Error(`Dropbox upload failed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function deleteFile(dropboxPath) {
  const token = await getAccessToken();
  const res = await fetch("https://api.dropboxapi.com/2/files/delete_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path: dropboxPath }),
  });
  if (!res.ok) {
    const txt = await res.text();
    // Already gone is fine.
    if (res.status === 409 && /not_found/.test(txt)) return { alreadyGone: true };
    throw new Error(`Dropbox delete failed ${res.status}: ${txt}`);
  }
  return res.json();
}

module.exports = { getRedis, getAccessToken, uploadFile, deleteFile, REFRESH_KEY };
