const VISUAL_SANITIZER_VERSION = "visual-table-v1";
const MAX_DERIVATIVE_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 5;
const RENDER_SCALE = 1.5;

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

function normalized(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function vendorFor(merchant) {
  const value = normalized(merchant);
  if (value.includes("blinkit")) return "blinkit";
  if (value.includes("instamart")) return "instamart";
  return "";
}

function tokenMatches(token, expression) {
  return expression.test(String(token.text || "").trim());
}

function nearestToken(tokens, predicate, targetY, direction) {
  const candidates = tokens.filter(token => predicate(token) && (direction === "below" ? token.y < targetY : token.y > targetY));
  if (!candidates.length) return undefined;
  return candidates.sort((a, b) => Math.abs(a.y - targetY) - Math.abs(b.y - targetY))[0];
}

function detectTableCrop(tokens, pageSize) {
  const width = number(pageSize?.width);
  const height = number(pageSize?.height);
  if (!width || !height || !Array.isArray(tokens) || !tokens.length) return undefined;

  const description = tokens.find(token => tokenMatches(token, /^(item\s*)?description$/i));
  const quantity = tokens.find(token => tokenMatches(token, /^(qty|quantity)\.?$/i));
  const total = tokens.find(token => tokenMatches(token, /^total$/i) && token.y >= (description?.y || -Infinity) - height * 0.03);
  if (!description || !quantity || !total) return undefined;

  const headerY = (description.y + quantity.y + total.y) / 3;
  const footer = nearestToken(
    tokens,
    token => tokenMatches(token, /^total$/i) && token.x < description.x,
    headerY,
    "below"
  );
  if (!footer) return undefined;

  const left = Math.max(0, description.x - width * 0.018);
  const right = Math.min(width, width - Math.max(8, width * 0.008));
  const top = Math.min(height, headerY + height * 0.028);
  const bottom = Math.max(0, footer.y - height * 0.022);
  const cropWidth = right - left;
  const cropHeight = top - bottom;
  if (cropWidth < width * 0.35 || cropHeight < height * 0.12) return undefined;

  return {
    x: left,
    y: bottom,
    width: cropWidth,
    height: cropHeight,
    pageWidth: width,
    pageHeight: height
  };
}

/**
 * Identify a receipt line-item table without transmitting any source material.
 * A plan exists only when every page has an independently identifiable table.
 */
export function planVisualDerivative({ pages, pageSizes, merchant }) {
  if (!Array.isArray(pages) || !Array.isArray(pageSizes) || !pages.length || pages.length > MAX_PAGES) return undefined;
  const crops = pages.map((tokens, index) => detectTableCrop(tokens, pageSizes[index]));
  if (crops.some(crop => !crop)) return undefined;

  const vendor = vendorFor(merchant);
  const geometry = crops
    .map(crop => [crop.x, crop.y, crop.width, crop.height].map(value => Math.round(value)).join(","))
    .join("|");
  return {
    crops,
    vendor,
    known: Boolean(vendor),
    layoutKey: `${VISUAL_SANITIZER_VERSION}:${vendor || "new"}:${geometry}`
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
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!blob) throw new Error("visual_derivative_failed");
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height, previewUrl: URL.createObjectURL(blob) };
}

/** Build a local, flattened PDF containing only visual crops of receipt item tables. */
export async function createFlattenedVisualDerivative(pdfjsLib, sourcePdfBytes, plan) {
  const previews = [];
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: sourcePdfBytes.slice() }).promise;
    if (pdf.numPages !== plan.crops.length) throw new Error("visual_derivative_failed");
    const images = [];
    for (const [index, crop] of plan.crops.entries()) {
      const page = await pdf.getPage(index + 1);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
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
      table.getContext("2d", { alpha: false }).drawImage(fullPage, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
      const image = await canvasJpeg(canvasForCrop(table, `Receipt item table — page ${index + 1}`));
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
