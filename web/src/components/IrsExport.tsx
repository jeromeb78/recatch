import { useState } from "react";
import { supabase } from "../lib/supabase";
import { accountId } from "../lib/account";
import { irsFilesFor, saveBlob } from "../lib/receiptImage";
import { makeZip, type ZipEntry } from "../lib/zip";
import { toCsv } from "../lib/csv";
import type { LineItem, Receipt } from "../lib/types";

const BATCH = 40; // IRS Document Upload Tool: up to 40 files per upload, 15 MB each
const NON_DEDUCTIBLE = new Set(["personal"]);

function businessAmount(lines: LineItem[]): number {
  let sum = 0;
  for (const l of lines) {
    if (l.use_type === "personal" || NON_DEDUCTIBLE.has(l.tax_line ?? "")) continue;
    const t = Number(l.total ?? 0);
    sum += l.use_type === "mixed" ? (t * (l.business_pct ?? 50)) / 100 : l.use_type === "business" || l.tax_line ? t : 0;
  }
  return Math.round(sum * 100) / 100;
}

/** Year of receipts as JPG pages (plus original PDFs) in batches of 40, with an index. */
export function IrsExport({ year, business, businessName }: { year: string; business?: string; businessName?: string }) {
  const [scope, setScope] = useState<"business" | "all">("business");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg("Finding receipts…");
    try {
      const receipts: Receipt[] = [];
      for (let from = 0; ; from += 500) {
        let q = supabase.from("receipts").select("*").eq("user_id", accountId())
          .order("purchase_date", { ascending: true }).range(from, from + 499);
        if (year !== "all") q = q.gte("purchase_date", `${year}-01-01`).lte("purchase_date", `${year}-12-31`);
        if (business === "none") q = q.is("business_id", null);
        const { data, error } = await q;
        if (error) throw error;
        receipts.push(...((data ?? []) as Receipt[]));
        if ((data ?? []).length < 500) break;
      }
      const byReceipt = new Map<string, LineItem[]>();
      for (let i = 0; i < receipts.length; i += 100) {
        const { data, error } = await supabase.from("line_items").select("*")
          .in("receipt_id", receipts.slice(i, i + 100).map((r) => r.id)).order("position");
        if (error) throw error;
        for (const l of (data ?? []) as LineItem[]) byReceipt.set(l.receipt_id, [...(byReceipt.get(l.receipt_id) ?? []), l]);
      }
      // A business's receipts: assigned to it, or with at least one item allocated to it.
      const inBusiness = (r: Receipt) => !business || business === "none" || r.business_id === business
        || (byReceipt.get(r.id) ?? []).some((l) => l.business_id === business);
      const chosen = receipts.filter((r) => inBusiness(r) && (scope === "all" || businessAmount(byReceipt.get(r.id) ?? []) > 0));
      if (!chosen.length) {
        setMsg(scope === "business" ? "No receipts with business items for this period." : "No receipts for this period.");
        return;
      }

      const entries: ZipEntry[] = [];
      const index: Record<string, unknown>[] = [];
      let batch = 1, inBatch = 0;
      for (const [n, r] of chosen.entries()) {
        setMsg(`Making images… ${n + 1} of ${chosen.length}`);
        const lines = byReceipt.get(r.id) ?? [];
        const files = await irsFilesFor(r, lines);
        // Keep a receipt's pages together in one upload batch.
        if (inBatch + files.length > BATCH) { batch++; inBatch = 0; }
        const folder = `upload-batch-${String(batch).padStart(2, "0")}`;
        for (const f of files) {
          entries.push({ name: `${folder}/${f.name}`, data: new Uint8Array(await f.blob.arrayBuffer()) });
          index.push({
            batch: folder, file: f.name, date: r.purchase_date ?? "", store: r.merchant ?? "", order_number: r.order_number ?? "",
            total: r.total ?? "", business_amount: businessAmount(lines),
            tax_lines: [...new Set(lines.map((l) => l.tax_line).filter(Boolean))].join(" "),
          });
          inBatch++;
        }
      }
      const csv = toCsv(index, ["batch", "file", "date", "store", "order_number", "total", "business_amount", "tax_lines"]);
      entries.push({ name: "index.csv", data: new TextEncoder().encode(csv) });
      entries.push({
        name: "README.txt",
        data: new TextEncoder().encode([
          `Receipt images${businessName ? ` for ${businessName}` : ""}, ${year === "all" ? "all years" : year} (${scope === "business" ? "receipts with business items" : "all receipts"}).`,
          "",
          "Each JPG is a letter-size page with the receipt's details and itemization as recorded in Receipt Catcher,",
          "followed by the original document exactly as it was captured (photo, email or store order page text).",
          "Original PDFs, when there are any, are included unchanged.",
          "",
          "Folders hold at most 40 files each — the IRS Document Upload Tool's limit per upload (JPG/PNG/PDF, 15 MB per file).",
          "Only send what the IRS letter or your tax professional asks for. index.csv lists every file.",
        ].join("\n")),
      });
      setMsg("Packing the ZIP…");
      const slug = businessName ? `-${businessName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}` : "";
      saveBlob(`receipts-irs${slug}-${year}.zip`, new Blob([makeZip(entries)], { type: "application/zip" }));
      setMsg(`Done: ${chosen.length} receipt${chosen.length === 1 ? "" : "s"}, ${index.length} file${index.length === 1 ? "" : "s"} in ${batch} upload batch${batch === 1 ? "" : "es"}.`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack-sm" id="irs">
      <h2>Receipt images for the IRS</h2>
      <p className="muted small">
        One JPG page per receipt (longer receipts get more pages): the store, date, order number, payment, each item and the totals,
        followed by the original receipt exactly as captured. Packed in folders of 40 files to match the IRS Document Upload Tool.
      </p>
      <div className="row-wrap">
        <label className="field">Receipts
          <select value={scope} onChange={(e) => setScope(e.target.value as "business" | "all")}>
            <option value="business">With business items</option>
            <option value="all">All receipts</option>
          </select>
        </label>
        <button className="btn primary" disabled={busy} onClick={run}>{busy ? "Working…" : `Download ${year === "all" ? "all years" : year} (ZIP)`}</button>
      </div>
      {msg && <p className="muted small" role="status">{msg}</p>}
      <details className="small">
        <summary>When and how to send receipts to the IRS</summary>
        <ul className="guide-list">
          <li>Don't send receipts with your return. Keep them (generally 3 years after filing, longer in some cases) and send them only when an IRS letter or auditor asks.</li>
          <li>If the letter allows online replies, use the IRS Document Upload Tool link in the letter: JPG, PNG or PDF, up to 15 MB each, 40 files per upload.</li>
          <li>Send only the receipts the letter asks about — use index.csv to find them by date, store or tax line.</li>
          <li>Digital copies are fine when they're complete and legible (Rev. Proc. 97-22). For large purchases, also keep the store's own receipt or invoice PDF.</li>
        </ul>
      </details>
    </section>
  );
}
