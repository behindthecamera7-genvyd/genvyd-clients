/**
 * A tiny text-only PDF writer for the campaign approval record. No libraries: the Worker has
 * no build step for dependencies worth adding for this, and a record only needs headings,
 * wrapped text and monospaced blocks (hashes, the summary as approved).
 *
 * Fonts are the standard PDF ones (Helvetica, Helvetica-Bold, Courier), so nothing is embedded.
 * Text is WinAnsi: common typographic characters are mapped to plain ones, anything else
 * outside Latin-1 becomes "?".
 */

export type PdfBlock =
  | { kind: "title"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "text"; text: string; bold?: boolean }
  | { kind: "field"; label: string; value: string }
  | { kind: "mono"; text: string }
  | { kind: "space"; size?: number };

// Helvetica advance widths (per 1000 em) for ASCII 32..126.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const MAP: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u2013": "-", "\u2014": "-",
  "\u2012": "-", "\u2212": "-", "\u2026": "...", "\u2022": "-", "\u00B7": "-", "\u2192": "->", "\u2190": "<-", "\u2713": "v",
  "\u2714": "v", "\u2715": "x", "\u2716": "x", "\u00A0": " ", "\u2009": " ", "\u202F": " ", "\u200B": "", "\uFEFF": "",
};

function winAnsi(s: string) {
  let out = "";
  for (const ch of s.replace(/\r/g, "")) {
    if (MAP[ch] !== undefined) out += MAP[ch];
    else if (ch === "\t") out += "    ";
    else if (ch === "\n") out += "\n";
    else {
      const code = ch.codePointAt(0)!;
      out += (code >= 32 && code < 127) || (code >= 160 && code <= 255) ? ch : "?";
    }
  }
  return out;
}

function width(s: string, size: number, font: "helv" | "bold" | "mono") {
  if (font === "mono") return s.length * 600 * size / 1000;
  let w = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? HELV[c - 32] : 556;
  }
  return (w * size / 1000) * (font === "bold" ? 1.06 : 1);
}

function wrap(text: string, size: number, font: "helv" | "bold" | "mono", max: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (font === "mono") {
      // Keep the exact text: break long lines at the column limit, never reflow.
      const cols = Math.max(10, Math.floor(max / (600 * size / 1000)));
      if (!para.length) out.push("");
      for (let i = 0; i < para.length; i += cols) out.push(para.slice(i, i + cols));
      continue;
    }
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const next = line + word;
      if (width(next, size, font) <= max || !line.trim()) {
        // A single word wider than the line (a long URL or hash) is split by characters.
        if (width(next, size, font) > max) {
          let chunk = "";
          for (const ch of next) {
            if (width(chunk + ch, size, font) > max) { out.push(chunk); chunk = ""; }
            chunk += ch;
          }
          line = chunk;
        } else line = next;
      } else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

export function makePdf(blocks: PdfBlock[], footer: string): Uint8Array {
  const W = 612, H = 792, M = 54, MAXW = W - M * 2;
  type Line = { x: number; y: number; font: "F1" | "F2" | "F3"; size: number; text: string };
  const pages: Line[][] = [[]];
  let y = H - M;
  const newPage = () => { pages.push([]); y = H - M; };
  const put = (text: string, font: "F1" | "F2" | "F3", size: number, x = M, lead = size * 1.35) => {
    if (y - lead < M + 24) newPage();
    y -= lead;
    pages[pages.length - 1].push({ x, y, font, size, text });
  };
  for (const b of blocks) {
    if (b.kind === "space") { y -= b.size ?? 8; continue; }
    if (b.kind === "title") { for (const l of wrap(winAnsi(b.text), 18, "bold", MAXW)) put(l, "F2", 18, M, 24); y -= 4; continue; }
    if (b.kind === "heading") {
      y -= 10;
      if (y - 60 < M + 24) newPage(); // keep a heading with at least a few lines under it
      for (const l of wrap(winAnsi(b.text), 12.5, "bold", MAXW)) put(l, "F2", 12.5, M, 17);
      y -= 2;
      continue;
    }
    if (b.kind === "text") { for (const l of wrap(winAnsi(b.text), 10, b.bold ? "bold" : "helv", MAXW)) put(l, b.bold ? "F2" : "F1", 10); continue; }
    if (b.kind === "field") {
      const labelW = 128;
      const lines = wrap(winAnsi(b.value || "-"), 10, "helv", MAXW - labelW);
      lines.forEach((l, i) => {
        if (i === 0) {
          put(winAnsi(b.label), "F2", 10);
          pages[pages.length - 1].push({ x: M + labelW, y, font: "F1", size: 10, text: l });
        } else put(l, "F1", 10, M + labelW);
      });
      continue;
    }
    if (b.kind === "mono") { for (const l of wrap(winAnsi(b.text), 8, "mono", MAXW)) put(l, "F3", 8, M, 10.5); continue; }
  }

  const n = pages.length;
  const objs: string[] = [];
  // 1 catalog, 2 pages, 3-5 fonts, then a page and a content stream per page.
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = pages.map((_, i) => `${6 + i * 2} 0 R`).join(" ");
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>";
  pages.forEach((lines, i) => {
    let s = "";
    for (const l of lines) s += `BT /${l.font} ${l.size} Tf ${l.x.toFixed(1)} ${l.y.toFixed(1)} Td (${esc(l.text)}) Tj ET\n`;
    const foot = winAnsi(`${footer}   Page ${i + 1} of ${n}`);
    s += `0.45 g BT /F1 7.5 Tf ${M} ${M - 18} Td (${esc(foot)}) Tj ET\n`;
    objs[6 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${7 + i * 2} 0 R >>`;
    objs[7 + i * 2] = `<< /Length ${s.length} >>\nstream\n${s}endstream`;
  });

  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character is Latin-1 by now, so one byte each (lengths and offsets above are bytes).
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

// ---------------------------------------------------------------------------
// A one-page drawing surface for color reports (the client Results report). Coordinates are
// from the top left in points (612 x 792), and converted to PDF's bottom-left system here.
// ---------------------------------------------------------------------------

export type RGB = [number, number, number];
export const hex = (h: string): RGB => {
  const m = h.replace("#", "");
  return [parseInt(m.slice(0, 2), 16) / 255, parseInt(m.slice(2, 4), 16) / 255, parseInt(m.slice(4, 6), 16) / 255];
};
/** The color mixed with white, e.g. tint(green, 0.12) for a 12% tinted background. */
export const tint = (c: RGB, a: number): RGB => [1 - (1 - c[0]) * a, 1 - (1 - c[1]) * a, 1 - (1 - c[2]) * a];
const col = (c: RGB) => c.map((v) => v.toFixed(3)).join(" ");

export class PdfCanvas {
  readonly W = 612;
  readonly H = 792;
  private ops: string[] = [];
  private Y = (y: number) => (this.H - y).toFixed(1);

  rect(x: number, y: number, w: number, h: number, fill: RGB, stroke?: RGB, lw = 0.75) {
    this.ops.push(`${col(fill)} rg ${stroke ? `${col(stroke)} RG ${lw} w ` : ""}${x.toFixed(1)} ${(this.H - y - h).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re ${stroke ? "B" : "f"}`);
  }
  /** Rounded rectangle (r = corner radius). */
  round(x: number, y: number, w: number, h: number, r: number, fill: RGB, stroke?: RGB, lw = 0.75) {
    const k = 0.5523 * r, X = x, Yt = this.H - y, B = Yt - h, R = x + w;
    const p = [
      `${X + r} ${Yt} m`, `${R - r} ${Yt} l`, `${R - r + k} ${Yt} ${R} ${Yt - r + k} ${R} ${Yt - r} c`,
      `${R} ${B + r} l`, `${R} ${B + r - k} ${R - r + k} ${B} ${R - r} ${B} c`, `${X + r} ${B} l`,
      `${X + r - k} ${B} ${X} ${B + r - k} ${X} ${B + r} c`, `${X} ${Yt - r} l`, `${X} ${Yt - r + k} ${X + r - k} ${Yt} ${X + r} ${Yt} c`,
    ].join(" ");
    this.ops.push(`${col(fill)} rg ${stroke ? `${col(stroke)} RG ${lw} w ` : ""}${p} h ${stroke ? "B" : "f"}`);
  }
  circle(cx: number, cy: number, r: number, fill: RGB) { this.round(cx - r, cy - r, r * 2, r * 2, r, fill); }
  line(x1: number, y1: number, x2: number, y2: number, color: RGB, lw = 1) {
    this.ops.push(`${col(color)} RG ${lw} w ${x1.toFixed(1)} ${this.Y(y1)} m ${x2.toFixed(1)} ${this.Y(y2)} l S`);
  }
  polyline(pts: [number, number][], color: RGB, lw = 1.5) {
    if (pts.length < 2) return;
    this.ops.push(`${col(color)} RG ${lw} w 1 J 1 j ${pts.map(([x, y], i) => `${x.toFixed(1)} ${this.Y(y)} ${i ? "l" : "m"}`).join(" ")} S`);
  }
  width(s: string, size: number, bold = false) { return width(winAnsi(s), size, bold ? "bold" : "helv"); }
  /** Text with its baseline at y. align: left, right or center around x. */
  text(x: number, y: number, s: string, size: number, color: RGB, opts: { bold?: boolean; mono?: boolean; align?: "left" | "right" | "center" } = {}) {
    const t = winAnsi(s).replace(/\n/g, " ");
    const w = opts.mono ? t.length * 0.6 * size : width(t, size, opts.bold ? "bold" : "helv");
    const x0 = opts.align === "right" ? x - w : opts.align === "center" ? x - w / 2 : x;
    this.ops.push(`BT ${col(color)} rg /${opts.mono ? "F3" : opts.bold ? "F2" : "F1"} ${size} Tf ${x0.toFixed(1)} ${this.Y(y)} Td (${esc(t)}) Tj ET`);
    return w;
  }
  /** Wrapped text block. Returns the y after the last line. Stops at maxLines (adds "..."). */
  para(x: number, y: number, s: string, size: number, color: RGB, maxW: number, opts: { bold?: boolean; lead?: number; maxLines?: number } = {}) {
    let lines = wrap(winAnsi(s), size, opts.bold ? "bold" : "helv", maxW);
    if (opts.maxLines && lines.length > opts.maxLines) { lines = lines.slice(0, opts.maxLines); lines[lines.length - 1] = lines[lines.length - 1].replace(/\s*\S{0,12}$/, "") + "..."; }
    const lead = opts.lead ?? size * 1.35;
    for (const l of lines) { y += lead; this.text(x, y - lead * 0.25, l, size, color, { bold: opts.bold }); }
    return y;
  }
  /** Truncates to fit a width, adding "..." when cut. */
  fit(s: string, size: number, maxW: number, bold = false) {
    let t = winAnsi(s);
    if (width(t, size, bold ? "bold" : "helv") <= maxW) return t;
    while (t.length > 1 && width(t + "...", size, bold ? "bold" : "helv") > maxW) t = t.slice(0, -1);
    return t + "...";
  }
  toBytes(): Uint8Array {
    const stream = this.ops.join("\n") + "\n";
    const objs: string[] = [];
    objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objs[2] = "<< /Type /Pages /Kids [6 0 R] /Count 1 >>";
    objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
    objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>";
    objs[6] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents 7 0 R >>`;
    objs[7] = `<< /Length ${stream.length} >>\nstream\n${stream}endstream`;
    let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
    const offsets: number[] = [];
    for (let i = 1; i < objs.length; i++) { offsets[i] = pdf.length; pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objs.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(pdf.length);
    for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
    return bytes;
  }
}
