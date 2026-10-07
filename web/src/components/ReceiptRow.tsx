import { Link } from "react-router-dom";
import { money, shortDate, signedTotal } from "../lib/format";
import { monogram, SOURCE_LABEL } from "../lib/merchant";
import type { Category, Receipt } from "../lib/types";

export default function ReceiptRow({ r, category }: { r: Receipt; category?: Category }) {
  const m = monogram(r.merchant);
  const review = r.status === "needs_review";
  const meta = [shortDate(r.purchase_date), review ? "Needs review" : SOURCE_LABEL[r.source], !review && category?.name]
    .filter(Boolean)
    .join(" · ");
  return (
    <Link to={`/receipts/${r.id}`} className="row">
      <span className="monogram" style={{ background: m.bg, color: m.fg }}>{m.letter}</span>
      <span className="row-main">
        <span className="row-title">
          {r.merchant ?? "Unknown merchant"}
          {r.document_type === "refund" && <span className="pill">Refund</span>}
        </span>
        <span className={review ? "row-meta warn-text" : "row-meta"}>{meta}</span>
      </span>
      <span className="amount">{money(signedTotal(r), r.currency)}</span>
    </Link>
  );
}
