import { useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { FileIcon, UploadIcon } from "../components/Icons";
import { ReceiptImport } from "../components/ReceiptImport";
import { UploadResults } from "../components/UploadResults";
import { isPdf, useUploads } from "../lib/uploads";
import { isSpreadsheet, readSpreadsheet, SPREADSHEET_ACCEPT } from "../lib/xlsx";

const ACCEPT = `${SPREADSHEET_ACCEPT},application/pdf,.pdf`;

/**
 * Import receipts the user already has as files: spreadsheets (CSV / Excel — Amazon order history, bank or card
 * statements, any list) go through the column-matching importer with a preview; PDFs (invoices, e-receipts) are each read
 * as one receipt. Opened from the Import button next to Snap.
 */
export default function Import() {
  const { results, upload } = useUploads();
  const [sheet, setSheet] = useState<{ name: string; text: string } | null>(null);
  const [queue, setQueue] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function open(files: File[]) {
    for (const [i, f] of files.entries()) {
      try {
        setSheet(await readSpreadsheet(f));
        setQueue(files.slice(i + 1));
        return;
      } catch (e) {
        setError((e as Error).message);
      }
    }
    setSheet(null);
    setQueue([]);
  }

  function handle(list: FileList | File[] | null) {
    if (!list?.length) return;
    setError(null);
    const files = Array.from(list);
    const sheets = files.filter(isSpreadsheet);
    const docs = files.filter((f) => !isSpreadsheet(f) && (isPdf(f) || f.type.startsWith("image/")));
    const other = files.filter((f) => !sheets.includes(f) && !docs.includes(f));
    if (other.length) setError(`${other.map((f) => f.name).join(", ")} ${other.length === 1 ? "isn't" : "aren't"} a CSV, Excel or PDF file.`);
    if (sheets.length) {
      if (sheet) setQueue((q) => [...q, ...sheets]);
      else open(sheets);
    }
    upload(docs);
  }

  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); handle(e.dataTransfer.files); };
  const working = results.filter((r) => r.state === "working").length;
  const added = results.filter((r) => r.state === "done" && !r.duplicate).length;
  const dupes = results.filter((r) => r.duplicate).length;
  const failed = results.filter((r) => r.state === "error").length;

  return (
    <div className="narrow import-page">
      <h1>Import receipts</h1>
      <p className="muted">
        Bring in receipts you already have as files — from your computer, or your phone's Files, iCloud Drive or Google Drive.
      </p>

      {!sheet && (
        <div className={`dropzone${over ? " over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)} onDrop={drop}>
          <UploadIcon size={32} />
          <button className="primary big" onClick={() => input.current?.click()}>Choose files</button>
          <span className="muted small pointer-only">or drag them here</span>
          <span className="muted small">CSV · Excel (.xlsx) · PDF — pick several at once</span>
        </div>
      )}
      <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { handle(e.target.files); e.target.value = ""; }} />
      {error && <p className="error" role="alert">{error}</p>}

      {sheet && (
        <>
          {queue.length > 0 && <p className="muted small">Then {queue.length} more spreadsheet{queue.length === 1 ? "" : "s"}: {queue.map((f) => f.name).join(", ")}</p>}
          <ReceiptImport key={sheet.name} initial={sheet} onClose={() => open(queue)} />
        </>
      )}

      {results.length > 0 && (
        <section className="stack-sm">
          <div className="row-between">
            <h2>PDFs</h2>
            <span className="muted small">{working ? `Reading ${working} of ${results.length}…`
              : [`${added} added`, dupes && `${dupes} already saved`, failed && `${failed} couldn't be read`].filter(Boolean).join(" · ")}</span>
          </div>
          <UploadResults results={results} />
          {!working && added > 0 && <Link className="btn" to="/receipts">See receipts</Link>}
        </section>
      )}

      {!sheet && !results.length && (
        <div className="format-list">
          <section className="card stack-sm">
            <h2><span className="format-badge">CSV</span><span className="format-badge">XLSX</span>Spreadsheets</h2>
            <ul className="small">
              <li><b>Amazon order history</b> — the order report from Amazon's Request Your Data or order reports page.</li>
              <li><b>Bank or credit-card statement</b> — download transactions as CSV or Excel from your bank's website.</li>
              <li><b>Any list of purchases</b> with a date, store and amount — you match the columns.</li>
            </ul>
            <p className="muted small">You'll see a preview before anything is saved, and purchases already in Receipt Catcher are skipped.</p>
          </section>
          <section className="card stack-sm">
            <h2><span className="format-badge pdf">PDF</span>Receipts &amp; invoices</h2>
            <p className="small">
              Emailed invoices, store-app receipts and scans. Each PDF becomes a receipt — Claude reads the store, items, tax and total.
              Pick a whole folder's worth at once.
            </p>
            <p className="muted small"><FileIcon size={14} /> Photos of paper receipts? Use <Link to="/add">Snap</Link>.</p>
          </section>
        </div>
      )}
    </div>
  );
}
