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
// New Canva master is exported as SVG → converted to PDF with a clean
// (0, 0) origin MediaBox at 269.25 × 127.5 pts. The earlier empirical
// offset (~44pt) is gone — yFromTop now equals pdftotext top-down y.
const PAGE = { width: 269.25, height: 127.5 };
const toY = yFromTop => PAGE.height - yFromTop;

// Big black rectangle that covers the entire customer-info block,
// hiding all three placeholder texts.
//   yMin pushed down so the full-width horizontal divider line under the
//        tagline stays visible (gives the clear strip of paint colour
//        running along the pen).
//   xMax pulled INSIDE the original Canva black area so the rect doesn't
//        extend past the label edge and create a visible black step.
//   yMax stops above the legal text and the GHS02 pictogram.
// New page coords. Top brand strip occupies y 0-54, divider near y 55,
// transparent middle y 56-110, bottom legal strip y 110-127.5.
// Customer column is the right half of the middle area.
const CUSTOMER_BLOCK = { xMin: 133, yMin: 58, xMax: 253, yMax: 108 };

// Silhouette area kept identical to image box now that we no longer
// need to cover any placeholder behind it.
const SILHOUETTE_BOX = { xMin: 18, yMin: 58, xMax: 133, yMax: 108 };

// The actual silhouette image goes in the left half of the middle area.
const SILHOUETTE_IMAGE_BOX = { xMin: 18, yMin: 58, xMax: 133, yMax: 108 };

// Where each piece of customer text gets drawn. yFromTop is the BASELINE
// of the text. yFromTop values are spread further apart so the three
// rows have visible breathing room between them. Font sizes are the
// MAXIMUM — drawCenteredTextInBlock auto-shrinks them if the text won't
// fit horizontally (handles edge cases like "Supercalafragalistic Green").
// style 'solid' = filled white text (used for the reg — always readable)
// style 'outline' = stroke-only white border, letter interior left clear
//   so when printed on clear vinyl, the customer's paint colour shows
//   through the inside of each letter.
// Tuned for the new SVG-derived PDF: 0,0 origin means yFromTop maps
// directly to pdftotext y. Transparent middle band spans roughly y
// 58-108 on the 127.5pt page. Font sizes scaled down to suit the
// smaller page.
const TEXT_LAYOUT = {
  reg:       { yFromTop: 70,  fontSize: 14, style: 'solid'   },
  paintName: { yFromTop: 87,  fontSize: 13, style: 'outline' },
  paintCode: { yFromTop: 103, fontSize: 11, style: 'outline' },
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
  const { yFromTop } = layout;
  // Auto-shrink: start at the configured fontSize and step down by 1pt
  // until the text fits within the block's horizontal bounds. Floor at
  // 7pt so it stays legible even for absurdly long names.
  let fontSize = layout.fontSize;
  const blockW = block.xMax - block.xMin;
  // Leave 4pt of horizontal padding inside the block so text isn't
  // jammed against the edge.
  const maxW = blockW - 4;
  let w = font.widthOfTextAtSize(text, fontSize);
  while (w > maxW && fontSize > 7) {
    fontSize -= 1;
    w = font.widthOfTextAtSize(text, fontSize);
  }
  const x = (block.xMin + block.xMax) / 2 - w / 2;
  // Position baseline at the given yFromTop coordinate. Characters
  // extend upward from the baseline.
  const y = toY(yFromTop);

  if (layout.style === 'outline') {
    // 8-direction halo (without a black core this time). On the
    // transparent customer area, this prints as a slightly-thicker
    // white letter — visible on any paint colour. NOT a true cut-out
    // (letter interior is solid white toner, not paint colour). True
    // stroke-only rendering needs deeper pdf-lib work — tracked as a
    // follow-up task. For now this ships a working pipeline.
    const stroke = 0.6;
    const offsets = [
      [ stroke,  0       ], [-stroke,  0       ],
      [ 0,       stroke  ], [ 0,      -stroke  ],
      [ stroke * 0.7,  stroke * 0.7 ],
      [-stroke * 0.7,  stroke * 0.7 ],
      [ stroke * 0.7, -stroke * 0.7 ],
      [-stroke * 0.7, -stroke * 0.7 ],
    ];
    for (const [dx, dy] of offsets) {
      page.drawText(text, {
        x: x + dx, y: y + dy, size: fontSize, font, color: rgb(1, 1, 1),
      });
    }
    page.drawText(text, {
      x, y, size: fontSize, font, color: rgb(1, 1, 1),
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

  // 1) Stamp the new silhouette PNG directly. The Canva master no longer
  //    has a placeholder silhouette to cover, so no black rect is drawn.
  //    The silhouette PNG is line-art on transparent — when printed on
  //    clear vinyl, the white outline strokes get white toner and the
  //    car body interior stays clear so the paint shows through.
  const boxW = SILHOUETTE_IMAGE_BOX.xMax - SILHOUETTE_IMAGE_BOX.xMin;
  const boxH = SILHOUETTE_IMAGE_BOX.yMax - SILHOUETTE_IMAGE_BOX.yMin;
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
    x: SILHOUETTE_IMAGE_BOX.xMin + (boxW - drawW) / 2,
    y: toY(SILHOUETTE_IMAGE_BOX.yMax) + (boxH - drawH) / 2,
    width: drawW,
    height: drawH,
  });

  // 2) Stamp the three lines of customer text. The Canva master no
  //    longer has a black background OR placeholders here — the area
  //    is transparent — so we just draw the text directly. reg is
  //    solid white toner; paint name and paint code are stroke-only
  //    so their letter interiors stay clear for paint to show through.
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