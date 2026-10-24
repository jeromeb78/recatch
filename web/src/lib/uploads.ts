// Uploading receipt photos and PDFs: each file is stored under the account's folder (named by its content, so the same
// file twice is recognised) and read by the process-upload function. Shared by Snap (Add) and Import.
import { useState } from "react";
import { BUCKET, supabase } from "./supabase";
import { accountId } from "./account";

export type Result = { name: string; state: "working" | "done" | "error"; text: string; receiptId?: string; duplicate?: boolean };

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


export const isPdf = (f: { name: string; type: string }) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

/** Upload photos / PDFs and track each one's progress. */
export function useUploads() {
  const [results, setResults] = useState<Result[]>([]);
  const update = (i: number, patch: Partial<Result>) =>
    setResults((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function upload(list: File[]) {
    if (!list.length) return;
    const owner = accountId();
    const offset = results.length;
    setResults((rs) => [...rs, ...list.map((f) => ({ name: f.name, state: "working" as const, text: "Uploading…" }))]);

    for (const [k, file] of list.entries()) {
      const i = offset + k;
      try {
        const pdf = isPdf(file);
        const body = pdf ? file : await prepareImage(file);
        // Named by content, so picking the same photo again is recognised as already captured.
        const path = `${owner}/uploads/${await fingerprint(file)}.${pdf ? "pdf" : body === file ? file.name.split(".").pop() : "jpg"}`;
        const contentType = pdf ? "application/pdf" : body.type || file.type;

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
          update(i, { state: "done", duplicate: true, receiptId: data.receiptId, text: `Already saved: ${data.detail}` });
        } else {
          update(i, { state: "error", text: data.detail ?? "Not recognized as a receipt" });
        }
      } catch (e) {
        update(i, { state: "error", text: (e as Error).message });
      }
    }
  }

  return { results, upload };
}
