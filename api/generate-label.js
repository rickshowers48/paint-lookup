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

// Silhouette body paths (vector data extracted from the 38 SVG silhouettes).
// Each entry: { vb, bounds:[xMin,yMin,xMax,yMax], commands:[[op, ...coords], ...] }
// where commands use M/L/C/H absolute and coords are in the SVG viewBox
// space. We bundle this so the silhouette body shape can be cut OUT of
// the black middle background (paint shows through the body interior on
// clear vinyl).
let SILHOUETTE_PATHS = {};
try { SILHOUETTE_PATHS = require('./silhouette-paths.json'); } catch (e) {}

// ---- PDFOperator + PDFNumber for raw operator construction --------
// Required for both stroke-only text rendering and the compound-path
// cut-out clipping. We try the top-level barrel first, then deep paths.
let RawPDFOperator = null;
let RawPDFNumber = null;
try {
  const p = require('pdf-lib');
  RawPDFOperator = p.PDFOperator;
  RawPDFNumber = p.PDFNumber;
} catch (e) {}
if (!RawPDFOperator || typeof RawPDFOperator.of !== 'function') {
  try {
    const m = require('pdf-lib/cjs/core/operators/PDFOperator');
    RawPDFOperator = m.default || m;
  } catch (e) {}
}
if (!RawPDFNumber || typeof RawPDFNumber.of !== 'function') {
  try {
    const m = require('pdf-lib/cjs/core/objects/PDFNumber');
    RawPDFNumber = m.default || m;
  } catch (e) {}
}

// ---- stroke-only text setup ----------------------------------------
// True PDF stroke-only text requires three operators set BEFORE
// page.drawText runs: stroke colour (RG), line width (w), and text
// rendering mode (Tr=1). pdf-lib's drawText doesn't reset Tr, so the
// state set in the surrounding graphics state propagates into its BT/ET.
//
// We try TWO paths to get those operators:
//   1. High-level factories from pdf-lib (top-level barrel or deep import)
//   2. Raw PDFOperator.of(...) construction with literal operator names
//
// Whichever yields *defined* values gets used at runtime. If both end
// up undefined, the halo fallback kicks in. None of this can throw at
// module load — every step is in a try/catch.

let strokeFactories = null;
let strokeManual = null;

try {
  let TextRenderingMode, setTextRenderingMode, setStrokingColor, setLineWidth;
  try {
    // Deep imports: most likely path that actually has these in v1.17.1.
    const ts = require('pdf-lib/cjs/api/operators/text-state');
    const gs = require('pdf-lib/cjs/api/operators/graphics-state');
    TextRenderingMode = ts.TextRenderingMode;
    setTextRenderingMode = ts.setTextRenderingMode;
    setStrokingColor = gs.setStrokingColor;
    setLineWidth = gs.setLineWidth;
  } catch (eDeep) {
    // Fall back to top-level barrel.
    const p = require('pdf-lib');
    TextRenderingMode = p.TextRenderingMode;
    setTextRenderingMode = p.setTextRenderingMode;
    setStrokingColor = p.setStrokingColor;
    setLineWidth = p.setLineWidth;
  }
  if (typeof setTextRenderingMode === 'function'
      && typeof setStrokingColor === 'function'
      && typeof setLineWidth === 'function'
      && TextRenderingMode
      // pdf-lib v1.17.1 spells the stroke mode "Outline"; older docs called
      // it "Stroke". Accept whichever the installed version exports.
      && (TextRenderingMode.Outline != null || TextRenderingMode.Stroke != null)) {
    strokeFactories = {
      setTextRenderingMode, setStrokingColor, setLineWidth, TextRenderingMode,
      strokeModeValue: TextRenderingMode.Outline != null
        ? TextRenderingMode.Outline : TextRenderingMode.Stroke,
      fillModeValue:   TextRenderingMode.Fill,
    };
  }
} catch (e) { /* swallow */ }

try {
  // Raw construction: PDFOperator + PDFNumber are far more likely to
  // be exported than the operator factories. We build the Tr / RG / w
  // operators by hand with literal name strings.
  let PDFOperator, PDFNumber;
  try {
    const p = require('pdf-lib');
    PDFOperator = p.PDFOperator;
    PDFNumber = p.PDFNumber;
  } catch (e1) {
    PDFOperator = require('pdf-lib/cjs/core/operators/PDFOperator').default
                  || require('pdf-lib/cjs/core/operators/PDFOperator');
    PDFNumber = require('pdf-lib/cjs/core/objects/PDFNumber').default
                || require('pdf-lib/cjs/core/objects/PDFNumber');
  }
  if (PDFOperator && PDFNumber && typeof PDFOperator.of === 'function'
      && typeof PDFNumber.of === 'function') {
    const num = n => PDFNumber.of(n);
    strokeManual = {
      setStrokeWhite: () => PDFOperator.of('RG', [num(1), num(1), num(1)]),
      setLineWidth:   w => PDFOperator.of('w', [num(w)]),
      setTrStroke:    () => PDFOperator.of('Tr', [num(1)]),
      setTrFill:      () => PDFOperator.of('Tr', [num(0)]),
    };
  }
} catch (e) { /* swallow */ }
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
// Customer block sits on the right half — abuts the silhouette panel
// edge-to-edge with no visible gap (Rick decided the paint-coloured
// gap between them was distracting).
const CUSTOMER_BLOCK = { xMin: 133, yMin: 58, xMax: 253, yMax: 108 };

// Silhouette area sits on the left half, abuts the customer block.
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

// Compute final {fontSize, x, y, width} for a centred text item — same
// auto-shrink logic as drawCenteredTextInBlock but exposed so we can
// reuse it for the cut-out path construction.
function computeTextLayout(font, text, layout, block) {
  let fontSize = layout.fontSize;
  const blockW = block.xMax - block.xMin;
  const maxW = blockW - 4;
  let w = font.widthOfTextAtSize(text, fontSize);
  while (w > maxW && fontSize > 7) {
    fontSize -= 1;
    w = font.widthOfTextAtSize(text, fontSize);
  }
  const x = (block.xMin + block.xMax) / 2 - w / 2;
  const y = toY(layout.yFromTop);
  return { fontSize, x, y, width: w };
}

// Push fontkit glyph-path commands as PDF path operators (m / l / c / h),
// scaled by fontSize and translated to the baseline position.
function emitGlyphPathOps(ops, fkFont, text, fontSize, baselineX, baselineY) {
  if (!fkFont || !RawPDFOperator || !RawPDFNumber) return;
  const num = n => RawPDFNumber.of(n);
  const op = RawPDFOperator;
  const upm = fkFont.unitsPerEm || 1000;
  const scale = fontSize / upm;
  const run = fkFont.layout(text);
  const positions = run.positions || [];
  const glyphs = run.glyphs || [];

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
        ops.push(op.of('m', [num(X), num(Y)]));
        curX = X; curY = Y;
      } else if (name === 'lineTo') {
        const X = gx0 + a[0] * scale;
        const Y = gy0 + a[1] * scale;
        ops.push(op.of('l', [num(X), num(Y)]));
        curX = X; curY = Y;
      } else if (name === 'bezierCurveTo') {
        const X1 = gx0 + a[0] * scale, Y1 = gy0 + a[1] * scale;
        const X2 = gx0 + a[2] * scale, Y2 = gy0 + a[3] * scale;
        const X3 = gx0 + a[4] * scale, Y3 = gy0 + a[5] * scale;
        ops.push(op.of('c', [num(X1), num(Y1), num(X2), num(Y2), num(X3), num(Y3)]));
        curX = X3; curY = Y3;
      } else if (name === 'quadraticCurveTo') {
        // Convert Q (P0, Pc, P2) → C with two cubic control points
        const QX = gx0 + a[0] * scale, QY = gy0 + a[1] * scale;
        const X3 = gx0 + a[2] * scale, Y3 = gy0 + a[3] * scale;
        const X1 = curX + (2 / 3) * (QX - curX);
        const Y1 = curY + (2 / 3) * (QY - curY);
        const X2 = X3 + (2 / 3) * (QX - X3);
        const Y2 = Y3 + (2 / 3) * (QY - Y3);
        ops.push(op.of('c', [num(X1), num(Y1), num(X2), num(Y2), num(X3), num(Y3)]));
        curX = X3; curY = Y3;
      } else if (name === 'closePath') {
        ops.push(op.of('h'));
      }
    }
    const advance = (pos.xAdvance != null ? pos.xAdvance : (glyph.advanceWidth || 0));
    advX += advance * scale;
  }
}

// Push the silhouette body path's PDF operators (M/L/C/H) into `ops`,
// scaled and translated so the path fits inside `imageBox` with aspect
// ratio preserved (same fit math as the silhouette PNG draw).
function emitSilhouetteBodyOps(ops, bodyType, imageBox) {
  if (!RawPDFOperator || !RawPDFNumber) return;
  const sil = SILHOUETTE_PATHS[bodyType] || SILHOUETTE_PATHS['suv-family'];
  if (!sil || !sil.bounds || !sil.commands) return;
  const num = n => RawPDFNumber.of(n);
  const op = RawPDFOperator;

  const [bxMin, byMin, bxMax, byMax] = sil.bounds;
  const pathW = bxMax - bxMin;
  const pathH = byMax - byMin;
  const boxW = imageBox.xMax - imageBox.xMin;
  const boxH = imageBox.yMax - imageBox.yMin;
  const pathAspect = pathW / pathH;
  const boxAspect = boxW / boxH;
  let drawW, drawH;
  if (pathAspect > boxAspect) { drawW = boxW; drawH = boxW / pathAspect; }
  else                       { drawH = boxH; drawW = boxH * pathAspect; }
  const sx = drawW / pathW;
  const sy = drawH / pathH;
  const offX = imageBox.xMin + (boxW - drawW) / 2;
  // pdf-lib y origin is bottom — bottom of box, then flip Y inside.
  const boxBottomPdfY = toY(imageBox.yMax);
  const offY = boxBottomPdfY + (boxH - drawH) / 2;

  // Transform a viewBox-space point (px, py) to PDF coords. SVG y goes
  // down; PDF y goes up — flip Y by subtracting from drawH and adding
  // the bottom-left offset.
  const tx = px => offX + (px - bxMin) * sx;
  const ty = py => offY + drawH - (py - byMin) * sy;

  for (const cmd of sil.commands) {
    const c = cmd[0];
    if (c === 'M') {
      ops.push(op.of('m', [num(tx(cmd[1])), num(ty(cmd[2]))]));
    } else if (c === 'L') {
      ops.push(op.of('l', [num(tx(cmd[1])), num(ty(cmd[2]))]));
    } else if (c === 'C') {
      ops.push(op.of('c', [
        num(tx(cmd[1])), num(ty(cmd[2])),
        num(tx(cmd[3])), num(ty(cmd[4])),
        num(tx(cmd[5])), num(ty(cmd[6])),
      ]));
    } else if (c === 'H') {
      ops.push(op.of('h'));
    }
  }
}

// Draw a black rectangle over `block` with letter shapes AND silhouette
// body shape cut out of it. Uses PDF even-odd clipping: build a compound
// path of (outer rect + letter shapes + silhouette body), set it as the
// clip with W* n, then fill black. Returns true if the cut-out was
// successfully pushed.
function drawBlackBlockWithCutouts(page, block, letterItems, fkFont, bodyType, silhouetteImageBox) {
  if (!RawPDFOperator || !RawPDFNumber) return false;
  try {
    const num = n => RawPDFNumber.of(n);
    const op = RawPDFOperator;
    const ops = [];

    // Save graphics state so clip path doesn't leak.
    ops.push(op.of('q'));

    // Outer rectangle path — the FULL middle area we're blacking out.
    const x = block.xMin;
    const yMin = toY(block.yMax);
    const w = block.xMax - block.xMin;
    const h = block.yMax - block.yMin;
    ops.push(op.of('re', [num(x), num(yMin), num(w), num(h)]));

    // Letter paths
    if (fkFont) {
      for (const item of letterItems) {
        emitGlyphPathOps(ops, fkFont, item.text, item.fontSize, item.x, item.y);
      }
    }

    // Silhouette body path
    if (bodyType && silhouetteImageBox) {
      emitSilhouetteBodyOps(ops, bodyType, silhouetteImageBox);
    }

    // Set even-odd clipping path (no fill yet)
    ops.push(op.of('W*'));
    ops.push(op.of('n'));

    // Fill black within the clipped region — the area inside the outer
    // rect but OUTSIDE all the cut-out shapes (the even-odd region).
    ops.push(op.of('rg', [num(0), num(0), num(0)]));
    ops.push(op.of('re', [num(x), num(yMin), num(w), num(h)]));
    ops.push(op.of('f'));

    // Restore graphics state.
    ops.push(op.of('Q'));

    page.pushOperators(...ops);
    return true;
  } catch (e) {
    return false;
  }
}

// Backwards-compatible name so older callers still work
const drawBlackBlockWithLetterCutouts = drawBlackBlockWithCutouts;

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
    // Try true PDF stroke-only rendering. Tr=1 (Stroke) is part of the
    // graphics state, so setting it before drawText persists into the
    // BT/ET text object pdf-lib generates. Letter interior stays
    // genuinely transparent (no ink) → paint shows through on vinyl.
    let drawnAsStroke = false;

    // Path 1: high-level factories.
    if (!drawnAsStroke && strokeFactories) {
      try {
        const a = strokeFactories.setStrokingColor(rgb(1, 1, 1));
        const b = strokeFactories.setLineWidth(0.4);
        const c = strokeFactories.setTextRenderingMode(
          strokeFactories.strokeModeValue);
        const d = strokeFactories.setTextRenderingMode(
          strokeFactories.fillModeValue);
        if (a && b && c && d) {
          page.pushOperators(a, b, c);
          page.drawText(text, {
            x, y, size: fontSize, font, color: rgb(1, 1, 1),
          });
          page.pushOperators(d);
          drawnAsStroke = true;
        }
      } catch (e) { /* fall through */ }
    }

    // Path 2: hand-built PDFOperator with literal operator names.
    if (!drawnAsStroke && strokeManual) {
      try {
        const a = strokeManual.setStrokeWhite();
        const b = strokeManual.setLineWidth(0.4);
        const c = strokeManual.setTrStroke();
        const d = strokeManual.setTrFill();
        if (a && b && c && d) {
          page.pushOperators(a, b, c);
          page.drawText(text, {
            x, y, size: fontSize, font, color: rgb(1, 1, 1),
          });
          page.pushOperators(d);
          drawnAsStroke = true;
        }
      } catch (e) { /* fall through to halo */ }
    }

    if (!drawnAsStroke) {
      // Halo fallback: 8 white draws around a centre white draw.
      // Letters appear solid white (no transparent interior), but at
      // least nothing prints as black ink in the middle.
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
    }
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

  // 0) PAINT-COLOUR EDGE COVERAGE. The Canva master template leaves four
  //    transparent zones around the silhouette+customer middle band:
  //      - thin strip BELOW the top brand band  (y ≈ 51-58pt)
  //      - thin strip ABOVE the bottom legal band (y ≈ 108-113pt)
  //      - left margin (x ≈ 0-18pt)
  //      - right margin (x ≈ 253-269.25pt)
  //    On a clear-vinyl pen filled with paint, all four zones would show
  //    paint colour, which Rick didn't want — he wants the label to read
  //    as solid black with paint colour ONLY through the silhouette PNG's
  //    transparent accents and the customer block's letter cut-outs.
  //    Cover those four transparent zones with explicit black rectangles
  //    BEFORE drawing anything else on top (the silhouette + customer
  //    block come next, drawn on top of these covers).
  const EDGE_BLACK_TOP    = { xMin: 0,   yMin: 49,  xMax: 269.25, yMax: 58  };
  const EDGE_BLACK_BOTTOM = { xMin: 0,   yMin: 108, xMax: 269.25, yMax: 113 };
  const EDGE_BLACK_LEFT   = { xMin: 0,   yMin: 49,  xMax: 18,     yMax: 113 };
  const EDGE_BLACK_RIGHT  = { xMin: 253, yMin: 49,  xMax: 269.25, yMax: 113 };
  for (const z of [EDGE_BLACK_TOP, EDGE_BLACK_BOTTOM, EDGE_BLACK_LEFT, EDGE_BLACK_RIGHT]) {
    page.drawRectangle({
      x: z.xMin,
      y: toY(z.yMax),
      width: z.xMax - z.xMin,
      height: z.yMax - z.yMin,
      color: rgb(0, 0, 0),
    });
  }

  // 1) Black CUSTOMER block (right half only) with cut-outs for:
  //       - paint name letter shapes (via fontkit glyph paths)
  //       - paint code letter shapes
  //     Compound path + even-odd clip → black fill skips inside the
  //     letter shapes → letter interiors stay genuinely transparent →
  //     paint colour shows through on clear vinyl.
  //
  //     NOTE: Unlike earlier versions we DO NOT fill the silhouette
  //     image area on the LEFT with black, nor cut a vector silhouette
  //     body out of it. Rick's hand-drawn silhouette PNGs are now
  //     white-body-on-black with their own transparent paint-accent
  //     regions baked in — they supply their own background. We just
  //     stamp the PNG into a transparent zone of the master.
  let fkFont = null;
  try { fkFont = fontkit.create(fontBuf); } catch (e) {}
  const paintNameLayout = computeTextLayout(
    font, paintName, TEXT_LAYOUT.paintName, CUSTOMER_BLOCK);
  const paintCodeLayout = computeTextLayout(
    font, paintCode, TEXT_LAYOUT.paintCode, CUSTOMER_BLOCK);
  drawBlackBlockWithCutouts(page, CUSTOMER_BLOCK, [
    { text: paintName, fontSize: paintNameLayout.fontSize,
      x: paintNameLayout.x, y: paintNameLayout.y },
    { text: paintCode, fontSize: paintCodeLayout.fontSize,
      x: paintCodeLayout.x, y: paintCodeLayout.y },
  ], fkFont, null, null);  // no vector silhouette-body cut-out

  // 2) Stamp the silhouette PNG into the transparent silhouette area.
  //    PNG itself supplies the black background, the white car body,
  //    and the small transparent areas (windows, open tops, wheel hubs)
  //    where paint colour shows through.
  //
  //    After aspect-fitting the PNG into the box, there'll usually be
  //    empty padding bars top+bottom (if PNG is wider than box) or
  //    left+right (if PNG is taller than box). We fill those bars with
  //    BLACK *before* drawing the PNG so the gaps look like a single
  //    continuous black panel — matching what the customer block does.
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
  const padX = (boxW - drawW) / 2;
  const padY = (boxH - drawH) / 2;
  const drawX = SILHOUETTE_IMAGE_BOX.xMin + padX;
  const drawY = toY(SILHOUETTE_IMAGE_BOX.yMax) + padY;

  // Fill horizontal bars (above and below the PNG).
  if (padY > 0.01) {
    page.drawRectangle({
      x: SILHOUETTE_IMAGE_BOX.xMin,
      y: toY(SILHOUETTE_IMAGE_BOX.yMax),
      width: boxW,
      height: padY,
      color: rgb(0, 0, 0),
    });
    page.drawRectangle({
      x: SILHOUETTE_IMAGE_BOX.xMin,
      y: toY(SILHOUETTE_IMAGE_BOX.yMax) + padY + drawH,
      width: boxW,
      height: padY,
      color: rgb(0, 0, 0),
    });
  }
  // Fill vertical bars (left and right of the PNG).
  if (padX > 0.01) {
    page.drawRectangle({
      x: SILHOUETTE_IMAGE_BOX.xMin,
      y: toY(SILHOUETTE_IMAGE_BOX.yMax),
      width: padX,
      height: boxH,
      color: rgb(0, 0, 0),
    });
    page.drawRectangle({
      x: SILHOUETTE_IMAGE_BOX.xMin + padX + drawW,
      y: toY(SILHOUETTE_IMAGE_BOX.yMax),
      width: padX,
      height: boxH,
      color: rgb(0, 0, 0),
    });
  }

  page.drawImage(silhouette, {
    x: drawX,
    y: drawY,
    width: drawW,
    height: drawH,
  });

  // 3) Stamp the three lines of customer text on TOP. reg is solid
  //    white toner; paint name and paint code are stroke-only so their
  //    letter interiors stay clear for paint to show through.
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