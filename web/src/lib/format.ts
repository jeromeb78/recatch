export function money(n: number | null | undefined, currency = "USD"): string {
  if (n == null) return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(n));
}

export function date(d: string | null | undefined): string {
  if (!d) return "—";
  // purchase_date is a plain date; avoid timezone shifts.
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** "Oct 6" this year, "Oct 6, 2025" otherwise. */
export function shortDate(d: string | null | undefined): string {
  if (!d) return "No date";
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (y !== new Date().getFullYear()) opts.year = "numeric";
  return new Date(y, m - 1, day).toLocaleDateString(undefined, opts);
}

export function relative(ts: string | null | undefined): string {
  if (!ts) return "never";
  const mins = Math.round((Date.now() - Date.parse(ts)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} h ago`;
  return new Date(ts).toLocaleDateString();
}

/** Refunds count against spend. */
export function signedTotal(r: { total: number | null; document_type: string }): number {
  const t = Number(r.total ?? 0);
  return r.document_type === "refund" ? -t : t;
}
