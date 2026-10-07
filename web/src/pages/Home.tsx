import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useCategories } from "../lib/useCategories";
import { useReviewCount } from "../lib/useReviewCount";
import { money, signedTotal } from "../lib/format";
import { ChevronRight } from "../components/Icons";
import ReceiptRow from "../components/ReceiptRow";
import type { Receipt } from "../lib/types";

const COLUMNS =
  "id, source, status, review_reasons, document_type, merchant, order_number, purchase_date, currency, total, category_id, files, created_at";

function monthStart(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export default function Home() {
  const { categories } = useCategories();
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const reviewCount = useReviewCount();
  const [month, setMonth] = useState<Receipt[] | null>(null);
  const [recent, setRecent] = useState<Receipt[] | null>(null);

  useEffect(() => {
    supabase.from("receipts").select(COLUMNS).gte("purchase_date", monthStart())
      .then(({ data }) => setMonth((data ?? []) as Receipt[]));
    supabase.from("receipts").select(COLUMNS)
      .order("purchase_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(5)
      .then(({ data }) => setRecent((data ?? []) as Receipt[]));
  }, []);

  const totals = useMemo(() => {
    let business = 0, personal = 0;
    for (const r of month ?? []) {
      const v = signedTotal(r);
      if (r.category_id && catById.get(r.category_id)?.is_business) business += v;
      else personal += v;
    }
    const all = business + personal;
    return { all, business, personal, businessPct: all > 0 ? Math.max(0, Math.min(100, (business / all) * 100)) : 0 };
  }, [month, catById]);

  const monthLabel = new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" });

  if (recent && recent.length === 0) return <GetStarted />;

  return (
    <div className="stack">
      <div className="page-head">
        <span className="eyebrow">{monthLabel}</span>
        <h1>Receipts</h1>
      </div>

      <section className="card hero">
        <span className="eyebrow">Spent this month</span>
        <span className="big-number">{month ? money(totals.all) : "—"}</span>
        <div className="split-bar" aria-hidden="true">
          {totals.all > 0 ? (
            <>
              <span className="seg business" style={{ width: `${totals.businessPct}%` }} />
              <span className="seg personal" />
            </>
          ) : <span className="seg empty" />}
        </div>
        <div className="legend">
          <span><i className="dot business" />Business <b>{money(totals.business)}</b></span>
          <span><i className="dot personal" />Personal <b>{money(totals.personal)}</b></span>
        </div>
      </section>

      {reviewCount > 0 && (
        <Link to="/review" className="review-banner">
          <span className="count">{reviewCount}</span>
          <span className="grow">{reviewCount === 1 ? "receipt needs" : "receipts need"} a quick look</span>
          <span className="strong">Review</span>
          <ChevronRight />
        </Link>
      )}

      <section>
        <div className="section-head">
          <h2>Recent</h2>
          <Link to="/receipts">See all</Link>
        </div>
        <div className="card list-card">
          {recent === null ? <p className="muted pad">Loading…</p> : recent.map((r) => (
            <ReceiptRow key={r.id} r={r} category={r.category_id ? catById.get(r.category_id) : undefined} />
          ))}
        </div>
      </section>
    </div>
  );
}

function GetStarted() {
  return (
    <div className="stack">
      <div className="page-head">
        <span className="eyebrow">Welcome</span>
        <h1>Let’s catch your first receipt</h1>
      </div>
      <ol className="card steps">
        <li>
          <span className="step-num">1</span>
          <span className="grow"><b>Connect Gmail</b><span className="muted">Online orders from Walmart, Target, Amazon and more come in on their own.</span></span>
          <Link to="/settings" className="btn">Connect</Link>
        </li>
        <li>
          <span className="step-num">2</span>
          <span className="grow"><b>Copy your forwarding address</b><span className="muted">Forward receipts from any other inbox or store app.</span></span>
          <Link to="/settings" className="btn">Copy</Link>
        </li>
        <li>
          <span className="step-num">3</span>
          <span className="grow"><b>Snap a paper receipt</b><span className="muted">It’s read in a few seconds.</span></span>
          <Link to="/add" className="btn primary">Snap</Link>
        </li>
      </ol>
    </div>
  );
}
