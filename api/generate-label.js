/**
 * POST /api/generate-label
 *
 * Generates a print-ready CLEAR OVERLAY sticker for a single order and
 * uploads it to Dropbox at PaintMatchPen/Orders/YYYY-MM-DD/REG-<VRM>.eps.
 *
 * This produces Ari's spec: a 95mm × 18mm EPS file with black ink only
 * (CMYK 100% K) that gets printed on clear film. The silhouette, reg,
 * paint name and paint code are all KNOCKOUTS in the black — the pen
 * barrel's own paint colour shows through those shapes.
 *
 * Ari's confirmed spec:
 *   Dimensions      95mm × 18mm
 *   Bleed           None
 *   Safe zone       Full canvas usable
 *   Format          EPS
 *   Text            Outlined (all glyphs as paths, no live fonts)
 *   Colour          CMYK 100% K
 *   File naming     REG-<VRM>.eps
 *   Delivery        Existing Dropbox folder
 *
 * Request body (JSON):
 *   {
 *     "reg":       "BG24URO",
 *     "paintName": "Graphite Grey",
 *     "paintCode": "5X",
 *     "bodyType":  "hatchback-small",
 *     "orderId":   "wix-order-12345"   // optional, appended to filename
 *   }
 *
 * Response (JSON):
 *   { ok: true, dropboxPath: "/PaintMatchPen/Orders/2026-07-20/REG-BG24URO.eps" }
 *
 * Env vars:
 *   DROPBOX_TOKEN     short-lived OAuth token (rotate via refresh flow)
 *   PUBLIC_BASE_URL   optional, e.g. "https://paint-lookup.vercel.app"
 */

const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const path = require('path');

// ---- module-scope caches (warm-start friendly) ----------------------
let cachedFontBuf = null;
let cachedFkFont = null;
let SILHOUETTE_PATHS = {};
try { SILHOUETTE_PATHS = require('./silhouette-paths.json'); } catch (e) {}

const ARCHIVO_BLACK_URL =
  'https://fonts.gstatic.com/s/archivoblack/v23/HTxqL289NzCGg4MzN6KJ7eW6OYs.ttf';

function publicBaseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'https://paint-lookup.vercel.app';
}

// ---- LAYOUT (Ari's spec: 95mm × 18mm at 72dpi = 269.29 × 51.02 pt) --
// 1mm = 2.83464567 points
const MM = 2.83464567;
const PAGE = { width: 95 * MM, height: 18 * MM };  // 269.29 × 51.02 pt

// Silhouette sits on the left, text zone on the right.
// Silhouette treated as the HERO visual — 42mm wide, near-full height.
// Iterated up from 22 → 30 → 42mm as Rick fed back samples.
const MARGIN = 2 * MM;                       // 2mm side margins
const SILHOUETTE_VMARGIN = 0.5 * MM;         // very tight top/bottom
const SILHOUETTE_BOX = {
  xMin: MARGIN,
  xMax: MARGIN + 42 * MM,                    // 42mm wide silhouette
  yMin: SILHOUETTE_VMARGIN,
  yMax: PAGE.height - SILHOUETTE_VMARGIN,    // ~17mm tall
};
const TEXT_ZONE = {
  xMin: SILHOUETTE_BOX.xMax + 2 * MM,        // 2mm gap after silhouette
  xMax: PAGE.width - MARGIN,
};

// Text rows — baselines measured from BOTTOM (PostScript y-up).
// Three rows evenly spaced in the 18mm height, sized to fill the strip
// with proper hero presence. Reg is biggest — most memorable and the
// customer-recognition anchor. Paint name and code sized in descending
// hierarchy underneath. Paint name auto-shrinks when a customer's paint
// name is unusually long (e.g. two-tone codes).
const TEXT_LAYOUT = {
  reg:       { baselineY: 13 * MM, fontSize: 16 },
  paintName: { baselineY:  7 * MM, fontSize: 14 },
  paintCode: { baselineY:  2 * MM, fontSize: 12 },
};

// ---- font loading ---------------------------------------------------
async function loadFont() {
  if (cachedFontBuf && cachedFkFont) {
    return { buf: cachedFontBuf, fkFont: cachedFkFont };
  }
  const res = await fetch(ARCHIVO_BLACK_URL);
  if (!res.ok) throw new Error(`Font fetch failed: ${res.status}`);
  cachedFontBuf = Buffer.from(await res.arrayBuffer());
  cachedFkFont = fontkit.create(cachedFontBuf);
  return { buf: cachedFontBuf, fkFont: cachedFkFont };
}

// ---- text width + auto-shrink --------------------------------------
function widthOfTextAtSize(fkFont, text, fontSize) {
  const upm = fkFont.unitsPerEm || 1000;
  const scale = fontSize / upm;
  const run = fkFont.layout(text);
  let total = 0;
  const positions = run.positions || [];
  for (const pos of positions) {
    total += pos.xAdvance || 0;
  }
  return total * scale;
}

// Given the max-fontSize + text + max-width, step the font size down
// by 1pt until the text fits. Floor at 6pt so absurd names stay
// legible but don't blow out the layout.
function fitFontSize(fkFont, text, maxFontSize, maxWidth) {
  let size = maxFontSize;
  while (size > 6 && widthOfTextAtSize(fkFont, text, size) > maxWidth) {
    size -= 0.5;
  }
  return size;
}

// ---- PostScript emitters -------------------------------------------
// PostScript uses long-form operators: moveto, lineto, curveto,
// closepath. Coordinates come BEFORE the operator (like RPN).
//
// PostScript coordinate system:
//   Origin bottom-left, y-up (SAME as PDF).
//
// Numbers formatted to 3 decimal places to keep the EPS file small
// while staying well inside 1200dpi print resolution.

function n(v) { return v.toFixed(3); }

// Emit PS operators for a font glyph run at (baselineX, baselineY),
// scaled to fontSize. Returns a string of PS lines.
function emitGlyphPathPS(fkFont, text, fontSize, baselineX, baselineY) {
  if (!fkFont) return '';
  const upm = fkFont.unitsPerEm || 1000;
  const scale = fontSize / upm;
  const run = fkFont.layout(text);
  const positions = run.positions || [];
  const glyphs = run.glyphs || [];
  const lines = [];
  let advX = 0;

  for (let i = 0; i < glyphs.length; i++) {
    const glyph = glyphs[i];
    const pos = positions[i] || {};
    const gx0 = baselineX + advX + ((pos.xOffset || 0) * scale);
    const gy0 = baselineY + ((pos.yOffset || 0) * scale);
    let curX = gx0;
    let curY = gy0;
    const path = glyph && glyph.path;
    const cmds = (path && path.commands) || [];

    for (const cmd of cmds) {
      const name = cmd.command;
      const a = cmd.args || [];
      if (name === 'moveTo') {
        const X = gx0 + a[0] * scale;
        const Y = gy0 + a[1] * scale;
        lines.push(`${n(X)} ${n(Y)} moveto`);
        curX = X; curY = Y;
      } else if (name === 'lineTo') {
        const X = gx0 + a[0] * scale;
        const Y = gy0 + a[1] * scale;
        lines.push(`${n(X)} ${n(Y)} lineto`);
        curX = X; curY = Y;
      } else if (name === 'bezierCurveTo') {
        const X1 = gx0 + a[0] * scale, Y1 = gy0 + a[1] * scale;
        const X2 = gx0 + a[2] * scale, Y2 = gy0 + a[3] * scale;
        const X3 = gx0 + a[4] * scale, Y3 = gy0 + a[5] * scale;
        lines.push(`${n(X1)} ${n(Y1)} ${n(X2)} ${n(Y2)} ${n(X3)} ${n(Y3)} curveto`);
        curX = X3; curY = Y3;
      } else if (name === 'quadraticCurveTo') {
        // Convert Q (Pc, P2) → C with two cubic control points.
        const QX = gx0 + a[0] * scale, QY = gy0 + a[1] * scale;
        const X3 = gx0 + a[2] * scale, Y3 = gy0 + a[3] * scale;
        const X1 = curX + (2 / 3) * (QX - curX);
        const Y1 = curY + (2 / 3) * (QY - curY);
        const X2 = X3 + (2 / 3) * (QX - X3);
        const Y2 = Y3 + (2 / 3) * (QY - Y3);
        lines.push(`${n(X1)} ${n(Y1)} ${n(X2)} ${n(Y2)} ${n(X3)} ${n(Y3)} curveto`);
        curX = X3; curY = Y3;
      } else if (name === 'closePath') {
        lines.push('closepath');
      }
    }
    const advance = (pos.xAdvance != null ? pos.xAdvance : (glyph.advanceWidth || 0));
    advX += advance * scale;
  }
  return lines.join('\n');
}

// Emit PS operators for the silhouette body outline, scaled to fit
// inside `box` with aspect ratio preserved.
//
// Silhouette paths were extracted from SVG (y-down). PostScript is
// y-up. We flip y explicitly during the coordinate transform.
function emitSilhouettePathPS(bodyType, box) {
  const sil = SILHOUETTE_PATHS[bodyType] || SILHOUETTE_PATHS['suv-family'];
  if (!sil || !sil.bounds || !sil.commands) return '';

  const [bxMin, byMin, bxMax, byMax] = sil.bounds;
  const pathW = bxMax - bxMin;
  const pathH = byMax - byMin;
  const boxW = box.xMax - box.xMin;
  const boxH = box.yMax - box.yMin;
  const pathAspect = pathW / pathH;
  const boxAspect = boxW / boxH;
  let drawW, drawH;
  if (pathAspect > boxAspect) {
    drawW = boxW;
    drawH = boxW / pathAspect;
  } else {
    drawH = boxH;
    drawW = boxH * pathAspect;
  }
  const sx = drawW / pathW;
  const sy = drawH / pathH;
  const offX = box.xMin + (boxW - drawW) / 2;
  const offY = box.yMin + (boxH - drawH) / 2;

  // Transform SVG (y-down) point → PostScript (y-up) point.
  const tx = px => offX + (px - bxMin) * sx;
  const ty = py => offY + drawH - (py - byMin) * sy;

  const lines = [];
  for (const cmd of sil.commands) {
    const c = cmd[0];
    if (c === 'M') {
      lines.push(`${n(tx(cmd[1]))} ${n(ty(cmd[2]))} moveto`);
    } else if (c === 'L') {
      lines.push(`${n(tx(cmd[1]))} ${n(ty(cmd[2]))} lineto`);
    } else if (c === 'C') {
      lines.push(
        `${n(tx(cmd[1]))} ${n(ty(cmd[2]))} ` +
        `${n(tx(cmd[3]))} ${n(ty(cmd[4]))} ` +
        `${n(tx(cmd[5]))} ${n(ty(cmd[6]))} curveto`
      );
    } else if (c === 'H') {
      lines.push('closepath');
    }
  }
  return lines.join('\n');
}

// Centre a text string within TEXT_ZONE, auto-shrinking if it's too
// wide. Returns { x, fontSize } — y is fixed by the layout row.
function layoutCenteredText(fkFont, text, layout) {
  const zoneW = TEXT_ZONE.xMax - TEXT_ZONE.xMin;
  const maxW = zoneW - 2;   // 1pt breathing room each side
  const fontSize = fitFontSize(fkFont, text, layout.fontSize, maxW);
  const textW = widthOfTextAtSize(fkFont, text, fontSize);
  const x = TEXT_ZONE.xMin + (zoneW - textW) / 2;
  return { x, fontSize };
}

// ---- EPS generation -------------------------------------------------
function buildEps({ reg, paintName, paintCode, bodyType, fkFont }) {
  const regStr = String(reg || '').toUpperCase().trim();
  const nameStr = String(paintName || '').toUpperCase().trim();
  const codeStr = String(paintCode || '').toUpperCase().trim();

  const regFit  = layoutCenteredText(fkFont, regStr,  TEXT_LAYOUT.reg);
  const nameFit = layoutCenteredText(fkFont, nameStr, TEXT_LAYOUT.paintName);
  const codeFit = layoutCenteredText(fkFont, codeStr, TEXT_LAYOUT.paintCode);

  const silhouettePS = emitSilhouettePathPS(bodyType, SILHOUETTE_BOX);
  const regPS  = emitGlyphPathPS(fkFont, regStr,  regFit.fontSize,
                                 regFit.x,  TEXT_LAYOUT.reg.baselineY);
  const namePS = emitGlyphPathPS(fkFont, nameStr, nameFit.fontSize,
                                 nameFit.x, TEXT_LAYOUT.paintName.baselineY);
  const codePS = emitGlyphPathPS(fkFont, codeStr, codeFit.fontSize,
                                 codeFit.x, TEXT_LAYOUT.paintCode.baselineY);

  // BoundingBox integers must round OUTWARD (spec: fully contain the
  // artwork). HiResBoundingBox is the true float value.
  const bbLo = 0;
  const bbHiX = Math.ceil(PAGE.width);
  const bbHiY = Math.ceil(PAGE.height);

  const now = new Date().toISOString();

  const lines = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    `%%BoundingBox: ${bbLo} ${bbLo} ${bbHiX} ${bbHiY}`,
    `%%HiResBoundingBox: 0 0 ${n(PAGE.width)} ${n(PAGE.height)}`,
    '%%Title: PaintMatchPen clear overlay',
    `%%Creator: paint-lookup /api/generate-label (${now})`,
    '%%DocumentProcessColors: Black',
    '%%LanguageLevel: 2',
    '%%EndComments',
    '',
    '%%BeginProlog',
    '/DeviceCMYK setcolorspace',
    '0 0 0 1 setcmykcolor',
    '%%EndProlog',
    '',
    '%%Page: 1 1',
    'gsave',
    '',
    '% Build a compound path: outer rectangle + all knockout subpaths.',
    '% Fill with even-odd rule so black covers the rectangle EXCEPT the',
    '% areas inside the knockout shapes (silhouette + all letters).',
    'newpath',
    '',
    '% Outer rectangle',
    `0 0 moveto`,
    `${n(PAGE.width)} 0 lineto`,
    `${n(PAGE.width)} ${n(PAGE.height)} lineto`,
    `0 ${n(PAGE.height)} lineto`,
    'closepath',
    '',
    '% Silhouette body knockout',
    silhouettePS,
    '',
    '% Registration knockout',
    regPS,
    '',
    '% Paint name knockout',
    namePS,
    '',
    '% Paint code knockout',
    codePS,
    '',
    '% Fill with even-odd rule — inside compound path minus the subpaths',
    'eofill',
    '',
    'grestore',
    '%%EOF',
    '',
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ---- Dropbox upload -------------------------------------------------
async function uploadToDropbox(buf, dropboxPath) {
  const token = process.env.DROPBOX_TOKEN;
  if (!token) throw new Error('DROPBOX_TOKEN not configured');

  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: dropboxPath,
        mode: 'overwrite',
        autorename: false,
        mute: true,
      }),
    },
    body: buf,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Dropbox upload failed ${res.status}: ${txt}`);
  }
  return res.json();
}

// ---- payload normalisation ------------------------------------------
// We accept two payload shapes:
//   A) Simple direct callers (curl / ReqBin):
//        { reg, paintName, paintCode, bodyType?, orderId? }
//   B) Wix order webhook: full order payload with description lines.
//      We pull Registration / Paint name / Paint code out by fuzzy
//      name-match on the line item's description lines.

function readDescLineName(dl) {
  if (!dl || dl.name == null) return '';
  if (typeof dl.name === 'string') return dl.name;
  return dl.name.original || dl.name.translated || '';
}
function readDescLineValue(dl) {
  if (!dl) return '';
  if (typeof dl.description === 'string') return dl.description;
  if (typeof dl.plainText === 'string') return dl.plainText;
  if (dl.plainText) return dl.plainText.original || dl.plainText.translated || '';
  if (dl.colorInfo) return dl.colorInfo.original || dl.colorInfo.translated || '';
  if (typeof dl.value === 'string') return dl.value;
  return '';
}
function findInDescriptionLines(descLines, ...needles) {
  if (!Array.isArray(descLines)) return null;
  for (const dl of descLines) {
    const name = readDescLineName(dl).toLowerCase().trim();
    for (const needle of needles) {
      if (name.includes(needle.toLowerCase())) {
        const v = readDescLineValue(dl);
        if (v) return v;
      }
    }
  }
  return null;
}

function extractFromWixPayload(body) {
  const candidates = [
    body,
    body.order,
    body.data,
    body.entity,
    body.payload,
    body.event && body.event.data,
  ];
  let order = null;
  for (const c of candidates) {
    if (c && (c.lineItems || c.line_items)) { order = c; break; }
  }
  if (!order) return null;

  const lineItems = order.lineItems || order.line_items || [];
  if (!Array.isArray(lineItems) || lineItems.length === 0) return null;

  const line = lineItems[0];
  const descLines = line.descriptionLines || line.description_lines || [];

  return {
    reg:       findInDescriptionLines(descLines, 'Registration', 'Reg'),
    paintName: findInDescriptionLines(descLines, 'Paint name', 'PaintName'),
    paintCode: findInDescriptionLines(descLines, 'Paint code', 'PaintCode'),
    bodyType:  findInDescriptionLines(descLines, 'Body type', 'BodyType', 'Silhouette'),
    vehicle:   findInDescriptionLines(descLines, 'Vehicle'),
    orderId:   order.number || order.orderNumber || order.id || order._id || body.orderId || null,
  };
}

// Translate short categorical silhouetteKey → specific filename.
// Same mapping as the PDF pipeline used — kept as-is because the
// silhouette-paths.json keys still line up.
function mapShortKeyToSilhouetteFile(key) {
  if (!key) return null;
  const k = String(key).toLowerCase().trim();
  const EXACT = new Set([
    'citycar', 'convertible', 'estate', 'mpv', 'pickup', 'saloon', 'van',
    'coupe-fastback','coupe-hatch','coupe-long','coupe-sleek','coupe-sloped','coupe-sport',
    'crossover-medium','crossover-small',
    'hatchback-3door','hatchback-boxy','hatchback-compact','hatchback-hot','hatchback-low',
    'hatchback-mini','hatchback-raised','hatchback-small','hatchback-spoiler','hatchback-sport',
    'pickup-small','saloon-executive',
    'sportscar-coupe','sportscar-low','sportscar-roadster',
    'suv-boxy','suv-compact','suv-family','suv-luxury','suv-modern','suv-rugged','suv-tall',
    'van-delivery',
  ]);
  if (EXACT.has(k)) return k;
  const SHORT_TO_FILE = {
    suv:         'suv-family',
    hatchback:   'hatchback-small',
    coupe:       'coupe-fastback',
    sportscar:   'sportscar-coupe',
    crossover:   'crossover-medium',
  };
  if (SHORT_TO_FILE[k]) return SHORT_TO_FILE[k];
  return k;
}

async function lookupBodyTypeByReg(reg) {
  try {
    const url = `${publicBaseUrl()}/api/lookup`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vrm: reg }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.silhouetteKey
        || data.bodyType
        || data.body_type
        || data.silhouette
        || (data.vehicle && (data.vehicle.bodyType || data.vehicle.silhouette))
        || (data.match && (data.match.bodyType || data.match.silhouette))
        || null;
  } catch (e) {
    return null;
  }
}

// ---- core generator (exported for local testing) -------------------
async function generateLabelEps({ reg, paintName, paintCode, bodyType }) {
  const { fkFont } = await loadFont();
  return buildEps({ reg, paintName, paintCode, bodyType, fkFont });
}

// ---- HTTP handler ---------------------------------------------------
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const body = typeof req.body === 'string'
      ? JSON.parse(req.body)
      : (req.body || {});

    try {
      const peek = JSON.stringify(body).slice(0, 4000);
      console.log('[generate-label] inbound body keys =', Object.keys(body || {}));
      console.log('[generate-label] inbound body (first 4KB) =', peek);
    } catch (e) { /* swallow */ }

    let inputs = null;
    if (body.reg && body.paintName && body.paintCode) {
      inputs = {
        reg: body.reg,
        paintName: body.paintName,
        paintCode: body.paintCode,
        bodyType: body.bodyType || null,
        orderId: body.orderId || null,
      };
    } else {
      inputs = extractFromWixPayload(body);
    }

    if (!inputs || !inputs.reg || !inputs.paintName || !inputs.paintCode) {
      return res.status(400).json({
        error: 'missing_fields',
        required: ['reg', 'paintName', 'paintCode'],
        got: inputs,
        hint: 'Send either {reg,paintName,paintCode,bodyType} directly, ' +
              'or a Wix order payload with description lines named ' +
              '"Registration","Paint name","Paint code".',
      });
    }

    // bodyType resolution chain:
    //   1. caller provided it explicitly
    //   2. found in Wix description lines (rare)
    //   3. lookup via /api/lookup using the reg
    //   4. fallback default
    if (!inputs.bodyType && inputs.reg) {
      inputs.bodyType = await lookupBodyTypeByReg(inputs.reg);
    }
    inputs.bodyType = mapShortKeyToSilhouetteFile(inputs.bodyType);
    if (!inputs.bodyType) {
      inputs.bodyType = 'suv-family';
    }
    console.log('[generate-label] resolved bodyType =', inputs.bodyType);

    const { reg, paintName, paintCode, bodyType, orderId } = inputs;
    const epsBuf = await generateLabelEps({ reg, paintName, paintCode, bodyType });

    const today = new Date().toISOString().slice(0, 10);
    const safeReg = String(reg).replace(/\s+/g, '').toUpperCase();
    const suffix = orderId ? `-${String(orderId).replace(/[^a-z0-9-]/gi, '')}` : '';
    const dropboxPath = `/PaintMatchPen/Orders/${today}/REG-${safeReg}${suffix}.eps`;

    await uploadToDropbox(epsBuf, dropboxPath);

    return res.status(200).json({
      ok: true,
      dropboxPath,
      resolved: { reg, paintName, paintCode, bodyType, orderId },
    });
  } catch (err) {
    console.error('[generate-label]', err);
    return res.status(500).json({ error: 'generation_failed', message: err.message });
  }
};

module.exports.generateLabelEps = generateLabelEps;