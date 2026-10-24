// Reads Excel workbooks (.xlsx — what Excel, Google Sheets, Numbers and most bank exports save) in the browser, with no
// library: an .xlsx is a zip of XML files. The first sheet with data becomes CSV text, so spreadsheets go through the same
// importer as CSV files. Cells formatted as dates become YYYY-MM-DD. Pure apart from DecompressionStream, for tests.

/* ---------------- zip ---------------- */

/** Files in a zip archive, unpacked on demand. */
export async function unzip(data: ArrayBuffer | Uint8Array): Promise<(name: string) => Promise<Uint8Array | null>> {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // End of central directory: last 22+ bytes (more when the archive has a comment).
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This file isn't a valid Excel workbook (.xlsx).");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const entries = new Map<string, { method: number; size: number; offset: number }>();
  const dec = new TextDecoder();
  for (let n = 0; n < count && v.getUint32(p, true) === 0x02014b50; n++) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    entries.set(dec.decode(b.subarray(p + 46, p + 46 + nameLen)).replace(/^\/+/, ""), { method, size, offset });
    p += 46 + nameLen + extra + comment;
  }
  return async (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
    const raw = b.subarray(start, start + e.size);
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new Error("This workbook uses a compression Receipt Catcher can't read. Save it as CSV instead.");
    const stream = new Blob([raw.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
}

/* ---------------- xml helpers ---------------- */

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
export function xmlText(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()])
    .replace(/_x([0-9a-f]{4})_/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
/** All <t> text inside a fragment (rich text runs), ignoring phonetic hints. */
const texts = (frag: string) => xmlText([...frag.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

/* ---------------- dates ---------------- */

const BUILTIN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
export function isDateFormat(id: number, code?: string): boolean {
  if (BUILTIN_DATES.has(id)) return true;
  if (!code) return false;
  const bare = code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  return /[dy]/i.test(bare) || /m{3,}/i.test(bare);
}

/** Excel serial day → YYYY-MM-DD (1900 system, or 1904 for old Mac workbooks). */
export function serialDate(serial: number, date1904 = false): string {
  const ms = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30) + Math.floor(serial) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

const colIndex = (ref: string) => [...ref.replace(/\d+$/, "").toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const tidyNumber = (s: string) => { const n = Number(s); return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : s; };

/* ---------------- workbook ---------------- */

/** Rows of the first worksheet that has data, as strings. */
export async function readXlsx(data: ArrayBuffer | Uint8Array): Promise<string[][]> {
  const get = await unzip(data);
  // Some exporters prefix every tag (<x:row>, <x:c>); drop tag prefixes so one set of patterns reads both.
  const read = async (n: string) => { const f = await get(n); return f ? new TextDecoder().decode(f).replace(/<(\/?)[A-Za-z][\w.-]*:(?=[A-Za-z])/g, "<$1") : null; };
  const workbook = await read("xl/workbook.xml");
  if (!workbook) throw new Error("This file isn't an Excel workbook (.xlsx). Save it as .xlsx or CSV and try again.");
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);

  // Sheets in tab order → their files.
  const rels = (await read("xl/_rels/workbook.xml.rels")) ?? "";
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id"), attr(m[0], "Target") ?? ""]));
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const t = target.get(attr(m[0], "r:id")) ?? "";
    return t.startsWith("/") ? t.slice(1) : `xl/${t}`;
  });
  if (!sheets.length) sheets.push("xl/worksheets/sheet1.xml");

  const shared = [...((await read("xl/sharedStrings.xml")) ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  const styles = (await read("xl/styles.xml")) ?? "";
  const custom = new Map([...styles.matchAll(/<numFmt\b[^>]*>/g)].map((m) => [Number(attr(m[0], "numFmtId")), xmlText(attr(m[0], "formatCode") ?? "")]));
  const xfs = styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  const dateStyle = [...xfs.matchAll(/<xf\b[^>]*>/g)].map((m) => { const id = Number(attr(m[0], "numFmtId") ?? 0); return isDateFormat(id, custom.get(id)); });

  for (const path of sheets) {
    const xml = await read(path);
    if (!xml) continue;
    const rows: string[][] = [];
    let next = 0;
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = Number(attr(rm[1], "r")) || next + 1;
      next = r;
      const row: string[] = [];
      let col = 0;
      for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(cm[1], "r");
        col = ref ? colIndex(ref) : col;
        const type = attr(cm[1], "t") ?? "n", body = cm[2] ?? "";
        const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value = "";
        if (type === "s") value = shared[Number(raw)] ?? "";
        else if (type === "inlineStr") value = texts(body);
        else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
        else if (type === "e") value = "";
        else if (raw !== undefined) {
          const text = xmlText(raw);
          const n = Number(text);
          value = type === "n" && dateStyle[Number(attr(cm[1], "s") ?? 0)] && Number.isFinite(n) && n >= 1 ? serialDate(n, date1904)
            : type === "n" ? tidyNumber(text) : text;
        }
        while (row.length < col) row.push("");
        row[col] = value;
        col++;
      }
      while (rows.length < r - 1) rows.push([]);
      rows[r - 1] = row;
    }
    const filled = rows.map((r) => r.map((c) => c ?? ""));
    while (filled.length && filled[filled.length - 1].every((c) => !c.trim())) filled.pop();
    if (filled.some((r) => r.some((c) => c.trim()))) return filled;
  }
  return [];
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
}

/* ---------------- any spreadsheet file ---------------- */

export const SPREADSHEET_ACCEPT = ".csv,text/csv,text/comma-separated-values,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xls,application/vnd.ms-excel";

export function isSpreadsheet(f: { name: string; type: string }): boolean {
  return /\.(csv|xlsx|xls)$/i.test(f.name) || /csv|comma-separated|spreadsheetml|ms-excel/.test(f.type);
}

/** A CSV or Excel file as CSV text for the importer. Old binary .xls files need re-saving. */
export async function readSpreadsheet(file: File): Promise<{ name: string; text: string }> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b) return { name: file.name, text: toCsv(await readXlsx(await file.arrayBuffer())) };
  if (head[0] === 0xd0 && head[1] === 0xcf) {
    throw new Error(`${file.name} is an older Excel file (.xls). In Excel or Numbers choose File → Save As → Excel Workbook (.xlsx) or CSV, then import that.`);
  }
  return { name: file.name, text: await file.text() };
}
