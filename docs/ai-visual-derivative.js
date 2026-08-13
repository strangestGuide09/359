const VISUAL_SANITIZER_VERSION = "visual-cells-v6";
const MAX_DERIVATIVE_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 5;
export const VISUAL_RENDER_SCALE = 2.5;
export const VISUAL_JPEG_QUALITY = 0.94;

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

function normalized(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function geometryHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function vendorFor(merchant) {
  const value = normalized(merchant);
  if (value.includes("blinkit")) return "blinkit";
  if (value.includes("instamart")) return "instamart";
  return "";
}

const privateToken = /(?:\b(?:customer|buyer|recipient|deliver(?:y|ed)?|ship(?:ping|ped)?|bill(?:ing|ed)?|address|phone|mobile|email|contact|landmark|payment|card|upi|transaction|account|bank|order\s*(?:id|number|no)|invoice\s*(?:id|number|no))\b|@|\b(?:\+?91[\s-]?)?[6-9]\d{9}\b)/i;
const operationalChargeToken = /\b(?:delivery\s+and\s+other(?:\s+(?:fee|fees|charge|charges))?|(?:delivery|handling|platform|service)\s+(?:fee|fees|charge|charges))\b/i;
const hasPrivateToken = token => privateToken.test(String(token.text || ""));
const serialValue = token => {
  const match = String(token.text || "").trim().match(/^(\d{1,3})[.)]?$/);
  return match ? Number(match[1]) : undefined;
};
const numericToken = token => /^(?:₹\s*)?-?\d[\d,]*(?:\.\d{1,2})?$/.test(String(token.text || "").trim());
const summaryToken = /(?:^(?:sub\s*total|grand\s*total|total|tax|discount|round(?:ing|ed)?|amount\s+(?:paid|payable)|invoice\s+value)$|\b(?:cgst|sgst|igst|cess)\b)/i;

function pageSerials(tokens, pageSize) {
  const width = number(pageSize?.width);
  if (!width) return [];
  const bins = new Map();
  tokens.forEach(token => {
    const value = serialValue(token);
    if (value == null || number(token.x) > width * 0.28) return;
    const key = Math.round(number(token.x) / width * 100) / 100;
    const entries = bins.get(key) || [];
    entries.push({ ...token, serial: value });
    bins.set(key, entries);
  });
  return [...bins.values()]
    .map(entries => entries.sort((a, b) => b.y - a.y))
    .filter(entries => entries.length >= 2 && entries.every((entry, index) => index === 0 || entry.serial === entries[index - 1].serial + 1))
    .sort((a, b) => b.length - a.length)[0] || [];
}

function inferredAmountRows(tokens, pageSize) {
  const width = number(pageSize?.width);
  const height = number(pageSize?.height);
  if (!width || !height) return [];
  const bins = new Map();
  tokens.forEach(token => {
    if (!numericToken(token) || number(token.x) < width * 0.55) return;
    const key = Math.round(number(token.x) / width * 50) / 50;
    const entries = bins.get(key) || [];
    entries.push(token);
    bins.set(key, entries);
  });
  const columns = [...bins.values()].filter(entries => entries.length >= 2).sort((a, b) => {
    const rightA = Math.max(...a.map(token => number(token.x) + number(token.width)));
    const rightB = Math.max(...b.map(token => number(token.x) + number(token.width)));
    return rightB - rightA || b.length - a.length;
  });
  for (const column of columns) {
    const anchors = column
      .filter(anchor => {
        const nearby = tokens.filter(token => Math.abs(number(token.y) - number(anchor.y)) <= Math.max(5, number(anchor.height) * 0.8));
        const words = nearby.filter(token => !numericToken(token) && number(token.x) < width * 0.72 && String(token.text || "").trim().length > 1);
        const numericCells = nearby.filter(numericToken);
        const wordsText = words.map(token => token.text).join(" ");
        return words.length > 0 && numericCells.length >= 2 && !operationalChargeToken.test(wordsText) && !words.some(token => summaryToken.test(String(token.text || "").trim()));
      })
      .sort((a, b) => b.y - a.y);
    const distinct = anchors.filter((anchor, index) => index === 0 || Math.abs(anchor.y - anchors[index - 1].y) > 5);
    if (distinct.length >= 2) return distinct.map(token => ({ ...token, inferred: true }));
  }
  return [];
}

function detectTableCells(tokens, pageSize) {
  const width = number(pageSize?.width);
  const height = number(pageSize?.height);
  if (!width || !height || !Array.isArray(tokens) || !tokens.length) return undefined;
  const serials = pageSerials(tokens, pageSize);
  const anchors = serials.length ? serials : inferredAmountRows(tokens, pageSize);
  if (!anchors.length) return undefined;
  const gaps = anchors.slice(0, -1).map((token, index) => token.y - anchors[index + 1].y).filter(gap => gap > 8 && gap < height * 0.18);
  const typicalGap = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : height * 0.065;
  const cells = [];
  let privacyRisk = false;
  anchors.forEach((anchor, index) => {
    const previous = anchors[index - 1];
    const next = anchors[index + 1];
    const upper = previous ? (previous.y + anchor.y) / 2 : Math.min(height, anchor.y + typicalGap * 0.6);
    const lower = next ? (anchor.y + next.y) / 2 : Math.max(0, anchor.y - typicalGap * 0.55);
    const rowLeft = serials.length ? Math.max(0, anchor.x - width * 0.015) : 0;
    const row = tokens.filter(token => token.y <= upper && token.y >= lower && token.x >= rowLeft && token.x + number(token.width) <= width * 0.985);
    const rowText = row.map(token => token.text).join(" ");
    const operationalChargeRow = operationalChargeToken.test(rowText);
    const rowPrivate = token => hasPrivateToken(token) && !(operationalChargeRow && /^deliver(?:y|ed)?(?:\s+and\s+other)?$/i.test(String(token.text || "").trim()));
    if (row.some(rowPrivate)) privacyRisk = true;
    row.filter(token => !rowPrivate(token)).forEach(token => {
      const padX = Math.max(1.5, number(token.height) * 0.18);
      const padY = Math.max(1, number(token.height) * 0.14);
      cells.push({ x: Math.max(0, number(token.x) - padX), y: Math.max(0, number(token.y) - padY), width: Math.min(width - number(token.x) + padX, Math.max(2, number(token.width)) + padX * 2), height: Math.min(height - number(token.y) + padY, Math.max(2, number(token.height)) + padY * 2) });
    });
  });
  if (privacyRisk || cells.length < anchors.length * 3) return undefined;
  const left = Math.max(0, Math.min(...cells.map(cell => cell.x)));
  const right = Math.min(width, Math.max(...cells.map(cell => cell.x + cell.width)));
  const bottom = Math.max(0, Math.min(...cells.map(cell => cell.y)));
  const top = Math.min(height, Math.max(...cells.map(cell => cell.y + cell.height)));
  if (right - left < width * 0.35 || top - bottom < height * 0.04) return undefined;
  return { x: left, y: bottom, width: right - left, height: top - bottom, pageWidth: width, pageHeight: height, cells, rowCount: anchors.length, evidence: serials.length ? "serial" : "amount-column", serials: serials.map(token => token.serial) };
}

/**
 * Identify a receipt line-item table without transmitting any source material.
 * A plan exists only when every page has an independently identifiable table.
 */
export function planVisualDerivative({ pages, pageSizes, merchant, itemCount }) {
  if (!Array.isArray(pages) || !Array.isArray(pageSizes) || !pages.length || pages.length > MAX_PAGES) return undefined;
  const crops = pages
    .map((tokens, index) => {
      const crop = detectTableCells(tokens, pageSizes[index]);
      return crop ? { ...crop, pageNumber: index + 1 } : undefined;
    })
    .filter(Boolean);
  if (!crops.length) return undefined;

  const vendor = vendorFor(merchant);
  const rowCount = crops.reduce((sum, crop) => sum + crop.rowCount, 0);
  const hasItemEvidence = Number.isInteger(itemCount) && itemCount > 0;
  const itemDifference = hasItemEvidence ? Math.abs(rowCount - itemCount) : undefined;
  if (hasItemEvidence && itemDifference > 1) return undefined;
  const itemAgreement = hasItemEvidence && itemDifference <= 1;
  const confidence = itemAgreement && rowCount >= 2 ? "high" : "medium";
  const geometry = crops
    .map(crop => `${[crop.x, crop.y, crop.width, crop.height].map(value => Math.round(value)).join(",")}:${crop.cells.map(cell => [cell.x, cell.y, cell.width, cell.height].map(value => Math.round(value)).join(",")).join(";")}`)
    .join("|");
  return {
    crops,
    vendor,
    known: Boolean(vendor) && confidence === "high",
    confidence,
    layoutKey: `${VISUAL_SANITIZER_VERSION}:${vendor || "new"}:${geometryHash(geometry)}`
  };
}

function pdfBytes(value) {
  return new TextEncoder().encode(value);
}

function joinBytes(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function buildFlattenedPdf(images) {
  const objects = [];
  const pageRefs = images.map((_, index) => `${3 + index * 3} 0 R`).join(" ");
  objects.push(pdfBytes("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.push(pdfBytes(`<< /Type /Pages /Kids [${pageRefs}] /Count ${images.length} >>`));

  for (const [index, image] of images.entries()) {
    const pageNumber = 3 + index * 3;
    const imageNumber = pageNumber + 1;
    const contentNumber = pageNumber + 2;
    const pageWidth = Math.max(1, Math.round(image.width / 2));
    const pageHeight = Math.max(1, Math.round(image.height / 2));
    const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im${index} Do\nQ\n`;
    objects.push(pdfBytes(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im${index} ${imageNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`));
    objects.push(joinBytes([
      pdfBytes(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`),
      image.bytes,
      pdfBytes("\nendstream")
    ]));
    objects.push(pdfBytes(`<< /Length ${pdfBytes(content).length} >>\nstream\n${content}endstream`));
  }

  const chunks = [pdfBytes(`%PDF-1.4\n%GROCERY-LEDGER-SANITIZED:${VISUAL_SANITIZER_VERSION}\n%âãÏÓ\n`)];
  const offsets = [0];
  let position = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(position);
    const prefix = pdfBytes(`${index + 1} 0 obj\n`);
    const suffix = pdfBytes("\nendobj\n");
    chunks.push(prefix, object, suffix);
    position += prefix.length + object.length + suffix.length;
  });
  const xref = position;
  chunks.push(pdfBytes(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
  for (const offset of offsets.slice(1)) chunks.push(pdfBytes(`${String(offset).padStart(10, "0")} 00000 n \n`));
  chunks.push(pdfBytes(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return new Blob([joinBytes(chunks)], { type: "application/pdf" });
}

function canvasForCrop(source, title) {
  const headerHeight = Math.max(64, Math.min(104, Math.round(source.width * 0.085)));
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height + headerHeight;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#173b2e";
  context.font = `700 ${Math.max(18, Math.round(source.width * 0.027))}px system-ui, sans-serif`;
  context.fillText(title, Math.max(18, Math.round(source.width * 0.025)), Math.round(headerHeight * 0.42));
  context.fillStyle = "#586257";
  context.font = `${Math.max(13, Math.round(source.width * 0.018))}px system-ui, sans-serif`;
  context.fillText("Sanitized visual derivative — original receipt stays local", Math.max(18, Math.round(source.width * 0.025)), Math.round(headerHeight * 0.75));
  context.drawImage(source, 0, headerHeight);
  return canvas;
}

async function canvasJpeg(canvas) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", VISUAL_JPEG_QUALITY));
  if (!blob) throw new Error("visual_derivative_failed");
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height, previewUrl: URL.createObjectURL(blob) };
}

/** Build a local, flattened PDF containing only visual crops of receipt item tables. */
export async function createFlattenedVisualDerivative(pdfjsLib, sourcePdfBytes, plan) {
  const previews = [];
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: sourcePdfBytes.slice() }).promise;
    if (plan.crops.some(crop => !Number.isInteger(crop.pageNumber) || crop.pageNumber < 1 || crop.pageNumber > pdf.numPages)) throw new Error("visual_derivative_failed");
    const images = [];
    for (const [index, crop] of plan.crops.entries()) {
      const page = await pdf.getPage(crop.pageNumber);
      const viewport = page.getViewport({ scale: VISUAL_RENDER_SCALE });
      const fullPage = document.createElement("canvas");
      fullPage.width = Math.ceil(viewport.width);
      fullPage.height = Math.ceil(viewport.height);
      const context = fullPage.getContext("2d", { alpha: false });
      await page.render({ canvasContext: context, viewport }).promise;
      const scaleX = viewport.width / crop.pageWidth;
      const scaleY = viewport.height / crop.pageHeight;
      const sourceX = Math.max(0, Math.floor(crop.x * scaleX));
      const sourceY = Math.max(0, Math.floor((crop.pageHeight - (crop.y + crop.height)) * scaleY));
      const sourceWidth = Math.min(fullPage.width - sourceX, Math.ceil(crop.width * scaleX));
      const sourceHeight = Math.min(fullPage.height - sourceY, Math.ceil(crop.height * scaleY));
      if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error("visual_derivative_failed");
      const table = document.createElement("canvas");
      table.width = sourceWidth;
      table.height = sourceHeight;
      const tableContext = table.getContext("2d", { alpha: false });
      tableContext.fillStyle = "#ffffff";
      tableContext.fillRect(0, 0, sourceWidth, sourceHeight);
      for (const cell of crop.cells || []) {
        const cellX = Math.max(sourceX, Math.floor(cell.x * scaleX));
        const cellY = Math.max(sourceY, Math.floor((crop.pageHeight - (cell.y + cell.height)) * scaleY));
        const cellRight = Math.min(sourceX + sourceWidth, Math.ceil((cell.x + cell.width) * scaleX));
        const cellBottom = Math.min(sourceY + sourceHeight, Math.ceil((crop.pageHeight - cell.y) * scaleY));
        const cellWidth = cellRight - cellX;
        const cellHeight = cellBottom - cellY;
        if (cellWidth > 0 && cellHeight > 0) tableContext.drawImage(fullPage, cellX, cellY, cellWidth, cellHeight, cellX - sourceX, cellY - sourceY, cellWidth, cellHeight);
      }
      const image = await canvasJpeg(canvasForCrop(table, `Receipt item table — page ${crop.pageNumber}`));
      previews.push(image.previewUrl);
      images.push(image);
    }
    const derivative = buildFlattenedPdf(images);
    if (derivative.size > MAX_DERIVATIVE_BYTES) throw new Error("visual_derivative_too_large");
    return {
      derivative,
      pageCount: images.length,
      previewUrls: previews,
      layoutKey: plan.layoutKey,
      sanitizerVersion: VISUAL_SANITIZER_VERSION
    };
  } catch (error) {
    previews.forEach(URL.revokeObjectURL);
    throw error;
  } finally {
    await pdf?.destroy();
  }
}

export function hasRememberedVisualLayout(layoutKey) {
  try {
    return localStorage.getItem(`grocery-ledger.visual-layout.${layoutKey}`) === "approved";
  } catch {
    return false;
  }
}

export function rememberVisualLayout(layoutKey) {
  try {
    localStorage.setItem(`grocery-ledger.visual-layout.${layoutKey}`, "approved");
  } catch {
    // Storage is a convenience only; visual confirmation remains available.
  }
}

export function revokeVisualDerivativePreview(prepared) {
  prepared?.previewUrls?.forEach(URL.revokeObjectURL);
}
