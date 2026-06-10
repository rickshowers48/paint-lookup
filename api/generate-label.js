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
 * Env vars required on Vercel:
 *   DROPBOX_TOKEN   short-lived OAuth access token (rotate via refresh
 *                   token flow in production — see TODO at bottom)
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const path = require('path');

// ---- module-scope caches (warm-start friendly) ----------------------
let cachedTemplate = null;
let cachedFontBuf = null;
const cachedSilhouettes = {};

const ARCHIVO_BLACK_URL =
  'https://fonts.gstatic.com/s/archivoblack/v23/HTxqL289NzCGg4MzN6KJ7eW6OYs.ttf';

// ---- layout geometry ------------------------------------------------
// Page dimensions from the Canva-exported template (in PDF points).
const PAGE = { width: 303.266, height: 161.516 };

// Coordinate convention: pdftotext reports y from page TOP, but pdf-lib
// draws using y from page BOTTOM. toY() does the flip.
const toY = yFromTop => PAGE.height - yFromTop;

// Placeholder boxes measured from the Canva PDF via
//   pdftotext -bbox-layout canva-template.pdf -
// Style 'solid' = solid white fill (used for the reg).
// Style 'outline' = stroked outline only (used for PAINT_NAME and
//   PAINT_CODE — the letter interior is left clear so the customer's
//   paint colour shows through when the label is on the pen).
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

// Silhouette box — approximated from visual measurement of the PDF.
// Tweakable: nudge these numbers if the silhouette ends up slightly
// mis-sized in the rendered output and we'll lock it in.
const SILHOUETTE_BOX = { xMin: 22, yMin: 75, xMax: 160, yMax: 135 };

// ---- loaders --------------------------------------------------------
async function loadTemplate() {
  if (cachedTemplate) return cachedTemplate;
  const buf = fs.readFileSync(
    path.join(process.cwd(), 'public', 'canva-template.pdf'),
  );
  cachedTemplate = buf;
  return buf;
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
  const file = path.join(
    process.cwd(), 'public', 'silhouettes', `${safe}.png`,
  );
  if (!fs.existsSync(file)) {
    // Fall back to a sensible default rather than failing the order.
    return loadSilhouette('suv-family');
  }
  cachedSilhouettes[safe] = fs.readFileSync(file);
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
  // Y is the baseline. Place baseline ~1pt above the box bottom.
  const y = toY(box.yMax) + 2;

  if (style === 'outline') {
    // Outline-only text via raw PDF text-rendering-mode operator.
    // 1 Tr = stroke only.
    page.pushOperators(/* save state */);
    // Stroke white, no fill — draw text with thick-ish stroke.
    page.drawText(text, {
      x, y,
      size: fontSize,
      font,
      color: rgb(1, 1, 1),
      // pdf-lib doesn't expose a strokeOnly option, so as an MVP we
      // draw a smaller black text on top of larger white text to fake
      // the outline. Will replace with proper Tr-mode operator once
      // layout is validated.
    });
    // The "outline" fake: draw the same text again slightly smaller
    // in black, centred, so the white edges form an outline.
    const innerSize = fontSize - 2;
    const innerW = font.widthOfTextAtSize(text, innerSize);
    const innerX = (box.xMin + box.xMax) / 2 - innerW / 2;
    page.drawText(text, {
      x: innerX, y: y + 1,
      size: innerSize,
      font,
      color: rgb(0, 0, 0),
    });
  } else {
    page.drawText(text, {
      x, y,
      size: fontSize,
      font,
      color: rgb(1, 1, 1),
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

  // 1) Black-out the placeholder silhouette and stamp in the new one
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
  for (const [key, ph] of Object.entries(PLACEHOLDERS)) {
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
  // CORS for the eventual Wix integration.
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

    // Dropbox path: /PaintMatchPen/Orders/YYYY-MM-DD/<REG>-<orderId>.pdf
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

// Export the generator too, for local testing without Dropbox.
module.exports.generateLabelPdf = generateLabelPdf;

// TODO: swap short-lived DROPBOX_TOKEN for a refresh-token flow.
//   Add env vars: DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN.
//   At cold start, POST to https://api.dropboxapi.com/oauth2/token with
//   grant_type=refresh_token to mint a fresh access token.
