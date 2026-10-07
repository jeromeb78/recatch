// Store adapters. Only link discovery is store-specific; Claude reads the order pages themselves.
export const STORES = {
  walmart: { label: "Walmart", host: /(^|\.)walmart\.com$/, historyUrl: "https://www.walmart.com/orders" },
  target: { label: "Target", host: /(^|\.)target\.com$/, historyUrl: "https://www.target.com/orders" },
  amazon: { label: "Amazon", host: /(^|\.)amazon\.com$/, historyUrl: "https://www.amazon.com/gp/css/order-history" },
};

export function storeFor(url) {
  try {
    const host = new URL(url).hostname;
    return Object.keys(STORES).find((k) => STORES[k].host.test(host)) ?? null;
  } catch {
    return null;
  }
}

// Runs INSIDE the store page (chrome.scripting.executeScript), so it must be self-contained.
export function collectOrderLinks(store) {
  const found = new Map();
  for (const a of document.querySelectorAll("a[href]")) {
    let u;
    try { u = new URL(a.getAttribute("href"), location.href); } catch { continue; }
    if (store === "amazon") {
      const id = u.searchParams.get("orderID") || u.searchParams.get("orderId");
      // Physical orders look like 123-1234567-1234567; digital (D01-…) orders have no receipt worth importing.
      if (id && /^\d{3}-\d{7}-\d{7}$/.test(id)) {
        found.set(id, `https://www.amazon.com/gp/css/summary/print.html?orderID=${id}`);
      }
    } else if (store === "walmart") {
      const m = u.hostname.endsWith("walmart.com") && u.pathname.match(/^\/orders\/([\w-]{6,})\/?$/);
      // Keep the query (e.g. ?storePurchase=true) — in-store receipts may need it to render.
      if (m && (!found.has(m[1]) || u.search)) found.set(m[1], `https://www.walmart.com/orders/${m[1]}${u.search}`);
    } else if (store === "target") {
      const m = u.hostname.endsWith("target.com") && u.pathname.match(/^\/orders\/((?:stores\/)?[\w-]{6,})\/?$/);
      if (m && m[1] !== "stores" && (!found.has(m[1]) || u.search)) found.set(m[1], `https://www.target.com/orders/${m[1]}${u.search}`);
    }
  }
  return [...found.entries()].map(([key, url]) => ({ key, url }));
}

// Runs inside any page: its readable text.
export function readPage() {
  return { url: location.href, title: document.title, text: document.body ? document.body.innerText : "" };
}
