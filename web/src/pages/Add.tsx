import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BUCKET, supabase } from "../lib/supabase";
import { CameraIcon, FileIcon } from "../components/Icons";

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

export default function Add() {
  const [results, setResults] = useState<Result[]>([]);
  const photoRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const update = (i: number, patch: Partial<Result>) =>
    setResults((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function handle(files: FileList | null) {
    if (!files?.length) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const list = Array.from(files);
    const offset = results.length;
    setResults((rs) => [...rs, ...list.map((f) => ({ name: f.name, state: "working" as const, text: "Uploading…" }))]);

    for (const [k, file] of list.entries()) {
      const i = offset + k;
      try {
        const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
        const body = isPdf ? file : await prepareImage(file);
        const base = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60) || "receipt";
        const path = `${user.id}/uploads/${Date.now()}-${base}.${isPdf ? "pdf" : body === file ? file.name.split(".").pop() : "jpg"}`;
        const contentType = isPdf ? "application/pdf" : body.type || file.type;

        const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, body, { contentType });
        if (upErr) throw upErr;

        update(i, { text: "Reading receipt…" });
        const { data, error } = await supabase.functions.invoke("process-upload", { body: { path } });
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
        <button className="big" onClick={() => fileRef.current?.click()}><FileIcon size={20} />Upload photo or PDF</button>
      </div>
      <input ref={photoRef} type="file" accept="image/*" capture="environment" hidden
        onChange={(e) => { handle(e.target.files); e.target.value = ""; }} />
      <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple hidden
        onChange={(e) => { handle(e.target.files); e.target.value = ""; }} />
      <p className="muted small">
        Lay the receipt flat in good light and fill the frame. Long receipts: take it in one shot if you can read it, otherwise upload a PDF scan.
      </p>

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
