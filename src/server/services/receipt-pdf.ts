import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { ReceiptRow } from "@/domain/receipt-layout";

/**
 * Server-side receipt PDF. Draws the same rows as the HTML receipt on a
 * single tall page (80 mm or 58 mm wide, height fitted to the content).
 *
 * Fonts: DejaVu Sans (regular + bold), bundled in `src/server/assets/fonts`
 * with its licence. It covers Cyrillic (incl. Ү, Ө) and the ₮ sign; the PDF's
 * built-in Helvetica would not.
 */
export type PaperMm = 58 | 80;

const PT_PER_MM = 72 / 25.4;
const FONT_DIR = path.join(process.cwd(), "src/server/assets/fonts");

let fontBytes: Promise<{ regular: Uint8Array; bold: Uint8Array }> | undefined;
function loadFonts() {
  fontBytes ??= Promise.all([
    readFile(path.join(FONT_DIR, "DejaVuSans.ttf")),
    readFile(path.join(FONT_DIR, "DejaVuSans-Bold.ttf")),
  ]).then(([regular, bold]) => ({ regular, bold }));
  // A failed read must not poison the cache.
  fontBytes.catch(() => {
    fontBytes = undefined;
  });
  return fontBytes;
}

const SIZES = {
  80: { sm: 7, md: 8.5, lg: 10.5, margin: 9 },
  58: { sm: 6.2, md: 7.5, lg: 9, margin: 6 },
} as const;
const LEADING = 1.3;
const GAP_PT = 5;
const RULE_PT = 7;
const PAIR_GAP_PT = 6;
const INDENT_PT = 6;

interface Placed {
  text: string;
  x: number;
  top: number;
  size: number;
  bold: boolean;
}
interface PlacedRule {
  top: number;
  dashed: boolean;
}
interface PlacedBox {
  top: number;
  height: number;
}

/** Greedy word wrap; a word wider than the line is split by character. */
export function wrapText(text: string, width: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      line = "";
      let rest = word;
      while (measure(rest) > width && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && measure(rest.slice(0, cut)) > width) cut--;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    out.push(line);
  }
  return out;
}

export async function renderReceiptPdf(
  rows: readonly ReceiptRow[],
  { paperMm = 80, title }: { paperMm?: PaperMm; title?: string } = {},
): Promise<Uint8Array> {
  const { regular, bold } = await loadFonts();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fonts: { regular: PDFFont; bold: PDFFont } = {
    regular: await doc.embedFont(regular, { subset: true }),
    bold: await doc.embedFont(bold, { subset: true }),
  };
  if (title) doc.setTitle(title);
  doc.setProducer("POS");
  doc.setCreator("POS");

  const metrics = SIZES[paperMm];
  const pageWidth = paperMm * PT_PER_MM;
  const innerWidth = pageWidth - metrics.margin * 2;
  const measureWith = (isBold: boolean, size: number) => (s: string) =>
    fonts[isBold ? "bold" : "regular"].widthOfTextAtSize(s, size);

  const texts: Placed[] = [];
  const rules: PlacedRule[] = [];
  const boxes: PlacedBox[] = [];
  let top = metrics.margin;

  for (const row of rows) {
    switch (row.kind) {
      case "gap":
        top += GAP_PT;
        break;
      case "rule":
        rules.push({ top: top + RULE_PT / 2, dashed: row.style === "dashed" });
        top += RULE_PT;
        break;
      case "banner": {
        const size = metrics.lg;
        const measure = measureWith(true, size);
        const lines = wrapText(row.text, innerWidth - 12, measure);
        const height = lines.length * size * LEADING + 8;
        boxes.push({ top, height });
        lines.forEach((line, i) => {
          texts.push({
            text: line,
            x: metrics.margin + (innerWidth - measure(line)) / 2,
            top: top + 4 + i * size * LEADING,
            size,
            bold: true,
          });
        });
        top += height + 2;
        break;
      }
      case "text": {
        const size = metrics[row.size ?? "md"];
        const isBold = row.bold === true;
        const measure = measureWith(isBold, size);
        for (const line of wrapText(row.text, innerWidth, measure)) {
          const x =
            row.align === "center"
              ? metrics.margin + (innerWidth - measure(line)) / 2
              : metrics.margin;
          texts.push({ text: line, x, top, size, bold: isBold });
          top += size * LEADING;
        }
        break;
      }
      case "pair": {
        const size = metrics[row.size ?? "md"];
        const isBold = row.bold === true;
        const measure = measureWith(isBold, size);
        const indent = row.indent ? INDENT_PT : 0;
        const rightWidth = row.right ? measure(row.right) : 0;
        const leftWidth = Math.max(
          innerWidth * 0.3,
          innerWidth - indent - rightWidth - (row.right ? PAIR_GAP_PT : 0),
        );
        const leftLines = wrapText(row.left, leftWidth, measure);
        leftLines.forEach((line, i) => {
          texts.push({
            text: line,
            x: metrics.margin + indent,
            top: top + i * size * LEADING,
            size,
            bold: isBold,
          });
        });
        if (row.right) {
          texts.push({
            text: row.right,
            x: metrics.margin + innerWidth - rightWidth,
            top,
            size,
            bold: isBold,
          });
        }
        top += leftLines.length * size * LEADING;
        break;
      }
    }
  }

  const pageHeight = Math.ceil(top + metrics.margin);
  const page: PDFPage = doc.addPage([pageWidth, pageHeight]);
  const ink = rgb(0, 0, 0);
  for (const t of texts) {
    // `top` is the line box top; the baseline sits about one em below it.
    page.drawText(t.text, {
      x: t.x,
      y: pageHeight - t.top - t.size,
      size: t.size,
      font: t.bold ? fonts.bold : fonts.regular,
      color: ink,
    });
  }
  for (const r of rules) {
    page.drawLine({
      start: { x: metrics.margin, y: pageHeight - r.top },
      end: { x: metrics.margin + innerWidth, y: pageHeight - r.top },
      thickness: 0.6,
      color: ink,
      dashArray: r.dashed ? [2, 2] : undefined,
    });
  }
  for (const b of boxes) {
    page.drawRectangle({
      x: metrics.margin,
      y: pageHeight - b.top - b.height,
      width: innerWidth,
      height: b.height,
      borderColor: ink,
      borderWidth: 1,
    });
  }
  return doc.save();
}
