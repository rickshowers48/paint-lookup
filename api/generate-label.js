/**
 * POST /api/generate-label
 *
 * Generates a print-ready pen label PDF for a single order and uploads
 * it to Dropbox at PaintMatchPen/Orders/YYYY-MM-DD/<REG>.pdf.
 *
 * Request body (JSON):
 *   {
 *     "reg":       "KD19 MYY",
 *     "paintName": "Denim Blue",
 *     "paintCode": "723",
 *     "bodyType":  "suv-family",   // matches one of the 38 silhouette filenames
 *     "orderId":   "wix-order-12345" // optional, used in filename
 *   }
 *
 * Response (JSON):
 *   { ok: true, dropboxPath: "/PaintMatchPen/Orders/2026-06-10/KD19MYY.pdf" }
 *
 * Asset loading strategy:
 *   - canva-template.pdf is read from the same directory as this file
 *     (i.e. api/canva-template.pdf). Vercel bundles sibling files with
 *     the function automatically, so no vercel.json includeFiles is
 *     needed for the template.
 *   - Silhouette PNGs are fetched over HTTP from the deployment's
 *     own public/ directory (which Vercel auto-serves at root). The
 *     base URL falls back to VERCEL_URL if PUBLIC_BASE_URL isn't set.
 *
 * Env vars used on Vercel:
 *   DROPBOX_TOKEN      short-lived OAuth access token (rotate via
 *                      refresh-token flow in production)
 *   PUBLIC_BASE_URL    optional, e.g. "https://paint-lookup.vercel.app".
 *                      Falls back to VERCEL_URL (auto-set by Vercel) or
 *                      a hardcoded default.
 */

const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const path = require('path');

// ---- module-scope caches (warm-start friendly) ----------------------
let cachedTemplate = null;
let cachedFontBuf = null;
const cachedSilhouettes = {};

const ARCHIVO_BLACK_URL =
  'https://fonts.gstatic.com/s/archivoblack/v23/HTxqL289NzCGg4MzN6KJ7eW6OYs.ttf';

function publicBaseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'https://paint-lookup.vercel.app';
}

// ---- layout geometry ------------------------------------------------
const PAGE = { width: 303.266, height: 161.516 };
const toY = yFromTop => PAGE.height - yFromTop;

const PLACEHOLDERS = {
  reg: {
    box: { xMin: 189.68, yMin: 77.21, xMax: 252.92, yMax: 94.90 },
    style: 'solid',
    fontSize: 20,
  },
  paintName: {
    box: { xMin: 163.62, yMin: 92.78, xMax: 278.74, yMax: 118.64 },
    style: 'outline',
    fontSize: 22,
  },
  paintCode: {
    box: { xMin: 166.86, yMin: 107.03, xMax: 279.92, yMax: 132.89 },
    style: 'outline',
    fontSize: 18,
  },
};

const SILHOUETTE_BOX = { xMin: 22, yMin: 75, xMax: 160, yMax: 135 };

// ---- loaders --------------------------------------------------------
async function loadTemplate() {
  if (cachedTemplate) return cachedTemplate;
  // PDF lives next to this function file (api/canva-template.pdf).
  const file = path.join(__dirname, 'canva-template.pdf');
  if (!fs.existsSync(file)) {
    throw new Error(`Template not found at ${file}`);
  }
  cachedTemplate = fs.readFileSync(file);
  return cachedTemplate;
}

async function loadFont() {
  if (cachedFontBuf) return cachedFontBuf;
  const res = await fetch(ARCHIVO_BLACK_URL);
  if (!res.ok) throw new Error(`Font fetch failed: ${res.status}`);
  cachedFontBuf = Buffer.from(await res.arrayBuffer());
  return cachedFontBuf;
}

async function loadSilhouette(bodyType) {
  const safe = String(bodyType || '').replace(/[^a-z0-9-]/gi, '');
  if (cachedSilhouettes[safe]) return cachedSilhouettes[safe];

  const url = `${publicBaseUrl()}/silhouettes/${safe}.png`;
  const res = await fetch(url);
  if (!res.ok) {
    if (safe !== 'suv-family') return loadSilhouette('suv-family');
    throw new Error(`Silhouette fetch failed: ${res.status} for ${url}`);
  }
  cachedSilhouettes[safe] = Buffer.from(await res.arrayBuffer());
  return cachedSilhouettes[safe];
}

// ---- drawing helpers ------------------------------------------------
function drawBlackOver(page, box) {
  page.drawRectangle({
    x: box.xMin - 1,
    y: toY(box.yMax) - 1,
    width: (box.xMax - box.xMin) + 2,
    height: (box.yMax - box.yMin) + 2,
    color: rgb(0, 0, 0),
  });
}

function drawCenteredText(page, font, text, placeholder) {
  const { box, fontSize, style } = placeholder;
  const w = font.widthOfTextAtSize(text, fontSize);
  const x = (box.xMin + box.xMax) / 2 - w / 2;
  const y = toY(box.yMax) + 2;

  if (style === 'outline') {
    // Fake outline for v0.1: smaller black text on top of larger white
    // text creates a visible white border. Will upgrade to proper PDF
    // text-rendering-mode operator once layout is validated.
    page.drawText(text, {
      x, y, size: fontSize, font, color: rgb(1, 1, 1),
    });
    const innerSize = fontSize - 2;
    const innerW = font.widthOfTextAtSize(text, innerSize);
    const innerX = (box.xMin + box.xMax) / 2 - innerW / 2;
    page.drawText(text, {
      x: innerX, y: y + 1, size: innerSize, font, color: rgb(0, 0, 0),
    });
  } else {
    page.drawText(text, {
      x, y, size: fontSize, font, color: rgb(1, 1, 1),
    });
  }
}

// ---- core generator -------------------------------------------------
async function generateLabelPdf({ reg, paintName, paintCode, bodyType }) {
  const templateBuf = await loadTemplate();
  const fontBuf = await loadFont();
  const silhouetteBuf = await loadSilhouette(bodyType);

  const pdfDoc = await PDFDocument.load(templateBuf);
  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(fontBuf);
  const silhouette = await pdfDoc.embedPng(silhouetteBuf);
  const page = pdfDoc.getPage(0);

  // 1) Black-out the placeholder silhouette area, then stamp the new one
  drawBlackOver(page, SILHOUETTE_BOX);
  const boxW = SILHOUETTE_BOX.xMax - SILHOUETTE_BOX.xMin;
  const boxH = SILHOUETTE_BOX.yMax - SILHOUETTE_BOX.yMin;
  const silAspect = silhouette.width / silhouette.height;
  const boxAspect = boxW / boxH;
  let drawW, drawH;
  if (silAspect > boxAspect) {
    drawW = boxW;
    drawH = boxW / silAspect;
  } else {
    drawH = boxH;
    drawW = boxH * silAspect;
  }
  page.drawImage(silhouette, {
    x: SILHOUETTE_BOX.xMin + (boxW - drawW) / 2,
    y: toY(SILHOUETTE_BOX.yMax) + (boxH - drawH) / 2,
    width: drawW,
    height: drawH,
  });

  // 2) Replace each text placeholder
  for (const ph of Object.values(PLACEHOLDERS)) {
    drawBlackOver(page, ph.box);
  }
  drawCenteredText(page, font, String(reg).toUpperCase(), PLACEHOLDERS.reg);
  drawCenteredText(page, font, paintName, PLACEHOLDERS.paintName);
  drawCenteredText(page, font, paintCode, PLACEHOLDERS.paintCode);

  return Buffer.from(await pdfDoc.save());
}

// ---- Dropbox upload -------------------------------------------------
async function uploadToDropbox(pdfBuf, dropboxPath) {
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
    body: pdfBuf,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Dropbox upload failed ${res.status}: ${txt}`);
  }
  return res.json();
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

    const { reg, paintName, paintCode, bodyType, orderId } = body;
    if (!reg || !paintName || !paintCode || !bodyType) {
      return res.status(400).json({
        error: 'missing_fields',
        required: ['reg', 'paintName', 'paintCode', 'bodyType'],
      });
    }

    const pdfBuf = await generateLabelPdf({ reg, paintName, paintCode, bodyType });

    const today = new Date().toISOString().slice(0, 10);
    const safeReg = String(reg).replace(/\s+/g, '').toUpperCase();
    const suffix = orderId ? `-${String(orderId).replace(/[^a-z0-9-]/gi, '')}` : '';
    const dropboxPath = `/PaintMatchPen/Orders/${today}/${safeReg}${suffix}.pdf`;

    await uploadToDropbox(pdfBuf, dropboxPath);

    return res.status(200).json({ ok: true, dropboxPath });
  } catch (err) {
    console.error('[generate-label]', err);
    return res.status(500).json({ error: 'generation_failed', message: err.message });
  }
};

module.exports.generateLabelPdf = generateLabelPdf;
