import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CameraIcon, FileIcon, UploadIcon } from "../components/Icons";
import { ReceiptImport } from "../components/ReceiptImport";
import { UploadResults } from "../components/UploadResults";
import { useUploads } from "../lib/uploads";
import { isSpreadsheet, readSpreadsheet, SPREADSHEET_ACCEPT } from "../lib/xlsx";

/** Files shared to the installed app from another app (Android share sheet → public/sw.js). */
async function takeSharedFiles(): Promise<File[]> {
  if (!("caches" in window)) return [];
  const cache = await caches.open("shared-receipts");
  const files: File[] = [];
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    if (res) {
      const name = decodeURIComponent(res.headers.get("X-File-Name") ?? "shared");
      files.push(new File([await res.blob()], name, { type: res.headers.get("Content-Type") ?? "" }));
    }
    await cache.delete(req);
  }
  return files;
}

export default function Add() {
  const { results, upload } = useUploads();
  const [params, setParams] = useSearchParams();
  const [sharedNote, setSharedNote] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  // A spreadsheet of purchases (CSV or Excel) opens the importer, whether picked here or shared from another app.
  const [importing, setImporting] = useState<null | { name: string; text: string }>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Arrived from the share sheet: upload what was shared, then tidy the URL.
  useEffect(() => {
    if (!params.has("shared")) return;
    const note = params.get("note");
    setParams({}, { replace: true });
    takeSharedFiles().then((files) => {
      if (files.length) handle(files);
      else if (note) setSharedNote(note);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handle(files: FileList | File[] | null) {
    if (!files?.length) return;
    setFileError(null);
    const all = Array.from(files);
    const sheet = all.find(isSpreadsheet);
    if (sheet) readSpreadsheet(sheet).then(setImporting, (e) => setFileError((e as Error).message));
    await upload(all.filter((f) => !isSpreadsheet(f)));
  }

  return (
    <div className="narrow">
      <h1>Add a receipt</h1>
      <div className="add-buttons">
        <button className="big primary" onClick={() => photoRef.current?.click()}><CameraIcon size={20} />Take photo</button>
        <button className="big" onClick={() => fileRef.current?.click()}><FileIcon size={20} />Choose photos or PDFs</button>
      </div>
      {importing ? (
        <ReceiptImport key={importing.name} initial={importing} onClose={() => setImporting(null)} />
      ) : (
        <Link className="btn import-link" to="/import"><UploadIcon size={18} />Import CSV, Excel or PDF files</Link>
      )}
      {fileError && <p className="error">{fileError}</p>}
      <input ref={photoRef} type="file" accept="image/*" capture="environment" hidden
        onChange={(e) => { handle(e.target.files); e.target.value = ""; }} />
      <input ref={fileRef} type="file" accept={`image/*,application/pdf,${SPREADSHEET_ACCEPT}`} multiple hidden
        onChange={(e) => { handle(e.target.files); e.target.value = ""; }} />
      <p className="muted small">
        Lay the receipt flat in good light and fill the frame. Long receipts: take it in one shot if you can read it, otherwise upload a PDF scan.
      </p>
      <p className="muted small">
        Already have receipts on your phone — photos, screenshots of e-receipts, PDFs from store apps or email? Choose as many as you
        like at once; ones you've added before are skipped. Faster: <Link to="/settings#phone">send them from any app's Share button</Link>.
        Have an Amazon order history or a bank/card statement as a CSV or Excel file, or a folder of PDF invoices? Use <b>Import</b> — it works
        from your phone's Files, iCloud Drive or Google Drive.
      </p>
      {sharedNote && (
        <p className="banner warn">
          Only text was shared ({sharedNote.slice(0, 120)}). Share the receipt's screenshot or PDF instead, or forward the email to your
          forwarding address.
        </p>
      )}

      <UploadResults results={results} />
    </div>
  );
}
