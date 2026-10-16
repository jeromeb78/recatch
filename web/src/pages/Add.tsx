import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BUCKET, supabase } from "../lib/supabase";
import { CameraIcon, FileIcon } from "../components/Icons";
import { ReceiptImport } from "../components/ReceiptImport";
import { accountId } from "../lib/account";

type Result = { name: string; state: "working" | "done" | "error"; text: string; receiptId?: string };

const MAX_EDGE = 2000;

/** Re-encode photos as JPEG ≤ 2000px: keeps uploads small and converts HEIC where the browser can decode it. */
async function prepareImage(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    if (["image/jpeg", "image/png", "image/webp"].includes(file.type)) return file;
    throw new Error("This browser can't read that image format. On iPhone set Settings › Camera › Formats › Most Compatible.");
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode image"))), "image/jpeg", 0.85),
  );
}

/** Content fingerprint of the original file: the same photo picked twice maps to the same upload (no duplicate). */
async function fingerprint(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
  const [results, setResults] = useState<Result[]>([]);
  const [params, setParams] = useSearchParams();
  const [sharedNote, setSharedNote] = useState<string | null>(null);
  // A spreadsheet of purchases opens the importer (from the button, the file picker, or the share sheet).
  const [importing, setImporting] = useState<null | { name: string; text: string } | "open">(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const update = (i: number, patch: Partial<Result>) =>
    setResults((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

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
    const owner = accountId();
    const all = Array.from(files);
    const csv = all.find((f) => /\.csv$/i.test(f.name) || /csv|comma-separated/.test(f.type));
    if (csv) setImporting({ name: csv.name, text: await csv.text() });
    const list = all.filter((f) => f !== csv && !/\.csv$/i.test(f.name));
    if (!list.length) return;
    const offset = results.length;
    setResults((rs) => [...rs, ...list.map((f) => ({ name: f.name, state: "working" as const, text: "Uploading…" }))]);

    for (const [k, file] of list.entries()) {
      const i = offset + k;
      try {
        const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
        const body = isPdf ? file : await prepareImage(file);
        // Named by content, so picking the same photo again is recognised as already captured.
        const path = `${owner}/uploads/${await fingerprint(file)}.${isPdf ? "pdf" : body === file ? file.name.split(".").pop() : "jpg"}`;
        const contentType = isPdf ? "application/pdf" : body.type || file.type;

        const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, body, { contentType });
        if (upErr && !/exists|duplicate/i.test(upErr.message)) throw upErr;

        update(i, { text: "Reading receipt…" });
        const { data, error } = await supabase.functions.invoke("process-upload", { body: { path, account: owner } });
        if (error) {
          const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
          throw new Error(detail?.error ?? error.message);
        }
        if (data.outcome === "receipt") {
          update(i, {
            state: "done",
            receiptId: data.receiptId,
            text: data.status === "needs_review" ? "Captured — needs review" : "Captured",
          });
        } else if (data.outcome === "duplicate") {
          update(i, { state: "done", receiptId: data.receiptId, text: `Duplicate: ${data.detail}` });
        } else {
          update(i, { state: "error", text: data.detail ?? "Not recognized as a receipt" });
        }
      } catch (e) {
        update(i, { state: "error", text: (e as Error).message });
      }
    }
  }

  return (
    <div className="narrow">
      <h1>Add a receipt</h1>
      <div className="add-buttons">
        <button className="big primary" onClick={() => photoRef.current?.click()}><CameraIcon size={20} />Take photo</button>
        <button className="big" onClick={() => fileRef.current?.click()}><FileIcon size={20} />Choose photos or PDFs</button>
      </div>
      {importing ? (
        <ReceiptImport key={typeof importing === "object" ? importing.name : "new"} initial={typeof importing === "object" ? importing : undefined}
          onClose={() => setImporting(null)} />
      ) : (
        <button className="btn import-link" onClick={() => setImporting("open")}>Import from a spreadsheet (CSV)</button>
      )}
      <input ref={photoRef} type="file" accept="image/*" capture="environment" hidden
        onChange={(e) => { handle(e.target.files); e.target.value = ""; }} />
      <input ref={fileRef} type="file" accept="image/*,application/pdf,.csv,text/csv" multiple hidden
        onChange={(e) => { handle(e.target.files); e.target.value = ""; }} />
      <p className="muted small">
        Lay the receipt flat in good light and fill the frame. Long receipts: take it in one shot if you can read it, otherwise upload a PDF scan.
      </p>
      <p className="muted small">
        Already have receipts on your phone — photos, screenshots of e-receipts, PDFs from store apps or email? Choose as many as you
        like at once; ones you've added before are skipped. Faster: <Link to="/settings#phone">send them from any app's Share button</Link>.
        Have an Amazon order history or a bank/card statement as a CSV? Use <b>Import from a spreadsheet</b> — it works from your phone's Files,
        iCloud Drive or Google Drive.
      </p>
      {sharedNote && (
        <p className="banner warn">
          Only text was shared ({sharedNote.slice(0, 120)}). Share the receipt's screenshot or PDF instead, or forward the email to your
          forwarding address.
        </p>
      )}

      {results.length > 0 && (
        <ul className="results">
          {results.map((r, i) => (
            <li key={i} className={r.state}>
              <span className="name">{r.name}</span>
              <span>{r.state === "working" && "⏳ "}{r.text}</span>
              {r.receiptId && <Link to={`/receipts/${r.receiptId}`}>Open</Link>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
