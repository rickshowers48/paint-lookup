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
// Coords below are EMPIRICALLY tuned against actual rendered output, not
// theoretical bboxes. Earlier attempts to use pdftotext bbox y coords
// produced text 35-45pt lower than expected (Canva exports its PDF with a
// non-zero MediaBox origin at (0, 44.4)). Rather than fight pdf-lib's
// coord interpretation, the numbers here are the values that empirically
// place text and rectangles in the right visible positions.
const PAGE = { width: 303.266, height: 161.516 };
const toY = yFromTop => PAGE.height - yFromTop;

// Big black rectangle that covers the entire customer-info block,
// hiding all three placeholder texts.
//   yMin pushed down so the full-width horizontal divider line under the
//        tagline stays visible (gives the clear strip of paint colour
//        running along the pen).
//   xMax pulled INSIDE the original Canva black area so the rect doesn't
//        extend past the label edge and create a visible black step.
//   yMax stops above the legal text and the GHS02 pictogram.
const CUSTOMER_BLOCK = { xMin: 160, yMin: 33, xMax: 285, yMax: 88 };

// Silhouette area — same yMin so visually aligned with the customer
// block, xMin pulled INSIDE so it doesn't extend past the label edge.
const SILHOUETTE_BOX = { xMin: 20, yMin: 33, xMax: 150, yMax: 88 };

// Where each piece of customer text gets drawn. yFromTop is the BASELINE
// of the text. Font sizes tuned for typical long paint names to fit
// inside the narrower customer block.
const TEXT_LAYOUT = {
  reg:       { yFromTop: 52, fontSize: 18 },
  paintName: { yFromTop: 70, fontSize: 17 },
  paintCode: { yFromTop: 85, fontSize: 15 },
};

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
function drawBlackOver(page, box, pad = 6) {
  page.drawRectangle({
    x: box.xMin - pad,
    y: toY(box.yMax) - pad,
    width: (box.xMax - box.xMin) + pad * 2,
    height: (box.yMax - box.yMin) + pad * 2,
    color: rgb(0, 0, 0),
  });
}

function drawCenteredTextInBlock(page, font, text, layout, block) {
  const { yFromTop, fontSize } = layout;
  const w = font.widthOfTextAtSize(text, fontSize);
  const x = (block.xMin + block.xMax) / 2 - w / 2;
  // Position baseline at the given yFromTop coordinate. Characters
  // extend upward from the baseline.
  const y = toY(yFromTop);
  page.drawText(text, {
    x, y, size: fontSize, font, color: rgb(1, 1, 1),
  });
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

  // 2) Black out the entire customer info area in one shot, then place
  //    the three lines of text inside it. This avoids any precision
  //    issues with individual placeholder bboxes.
  drawBlackOver(page, CUSTOMER_BLOCK, 0);
  drawCenteredTextInBlock(page, font, String(reg).toUpperCase(),
    TEXT_LAYOUT.reg, CUSTOMER_BLOCK);
  drawCenteredTextInBlock(page, font, paintName,
    TEXT_LAYOUT.paintName, CUSTOMER_BLOCK);
  drawCenteredTextInBlock(page, font, paintCode,
    TEXT_LAYOUT.paintCode, CUSTOMER_BLOCK);

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