import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { accountId } from "../lib/account";
import { money } from "../lib/format";
import { buildPnl, type PBuyLine, type PSaleLine, type PTrip, type Pnl } from "../lib/pnl";
import { reconcile, type RAccount, type RChannel, type ROrder, type RPayment } from "../lib/reconcile";
import { reconcileShipping, type RShipment } from "../lib/shipping";

const BUY_COLUMNS = "id, description, woo_sku, units, quantity, landed_total, tax_line, use_type, business_pct, purchase_date, merchant";

/** Home: this month's profit across all businesses, once sales are connected. Renders nothing otherwise. */
export function ProfitTile() {
  const [pnl, setPnl] = useState<Pnl | null>(null);

  useEffect(() => {
    let gone = false;
    (async () => {
      const [{ data: channels }, { data: accounts }, { data: shippers }] = await Promise.all([
        supabase.from("sales_channels").select("id, kind, store_url").eq("user_id", accountId()),
        supabase.from("payment_accounts").select("id, business_id").eq("user_id", accountId()),
        supabase.from("shipping_accounts").select("id, business_id").eq("user_id", accountId()),
      ]);
      if (!channels?.length && !accounts?.length && !shippers?.length) return;
      const now = new Date();
      const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const to = now.toISOString().slice(0, 10);
      const own = accountId();
      const [orders, payments, shipments, lines, inv, buys, trips] = await Promise.all([
        supabase.from("sales_orders")
          .select("id, order_date, status, items_total, shipping_charged, tax_collected, refunded, fees, channel_id, external_id, order_number, business_id, payment_method, payment_ref")
          .eq("user_id", own).gte("order_date", from).limit(5000),
        supabase.from("payments")
          .select("id, account_id, external_id, payment_intent, payment_date, status, amount, refunded, fee, disputed, description, order_ref, site_url")
          .eq("user_id", own).gte("payment_date", from).limit(5000),
        supabase.from("shipments").select("id, account_id, external_id, order_ref, ship_date, state, label_cost, courier, tracking")
          .eq("user_id", own).gte("ship_date", from).limit(5000),
        supabase.from("sales_lines").select("order_id, sku, name, quantity, total, sales_orders!inner(order_date)")
          .eq("user_id", own).gte("sales_orders.order_date", from).limit(20000),
        supabase.from("inventory_lines").select(BUY_COLUMNS).eq("user_id", own).not("woo_sku", "is", null).limit(20000),
        supabase.from("inventory_lines").select(BUY_COLUMNS).eq("user_id", own).gte("purchase_date", from).limit(5000),
        supabase.from("trips").select("trip_date, miles").eq("user_id", own).gte("trip_date", from),
      ]);
      if (gone || orders.error || lines.error) return;
      const merged = accounts?.length
        ? reconcile({ orders: (orders.data ?? []) as ROrder[], payments: (payments.data ?? []) as RPayment[], channels: (channels ?? []) as RChannel[], accounts: accounts as RAccount[] }).orders
        : (orders.data ?? []) as ROrder[];
      const labels = shippers?.length ? reconcileShipping({
        orders: merged, shipments: (shipments.data ?? []) as RShipment[], accounts: shippers, today: to,
        wooChannels: new Set((channels ?? []).filter((c) => c.kind === "woocommerce").map((c) => c.id)),
      }).expenses.map((e) => ({ key: "ship", label: "Shipping labels (Easyship)", date: e.date, amount: e.amount })) : [];
      const periodBuys = ((buys.data ?? []) as (PBuyLine & { merchant?: string | null })[])
        .filter((l) => !labels.length || !/easyship/i.test(l.merchant ?? ""));
      setPnl(buildPnl({
        from, to, saleLines: (lines.data ?? []) as unknown as PSaleLine[], orders: merged, otherExpenses: labels,
        inventoryBuys: (inv.data ?? []) as PBuyLine[], periodBuys, trips: (trips.data ?? []) as PTrip[],
      }));
    })();
    return () => { gone = true; };
  }, []);

  if (!pnl) return null;
  return (
    <Link to="/reports?tab=profit" className="card profit-tile">
      <span className="eyebrow">Profit this month</span>
      <span className={`big-number sm ${pnl.profit < 0 ? "neg" : ""}`}>{money(pnl.profit)}</span>
      <span className="muted small">
        {money(pnl.netSales)} sales − {money(pnl.cogs)} goods − {money(pnl.fees + pnl.expenseTotal + pnl.mileage)} fees &amp; expenses
        {pnl.unmatched.length > 0 && ` · ${pnl.unmatched.length} product${pnl.unmatched.length === 1 ? "" : "s"} without a cost`}
      </span>
    </Link>
  );
}
