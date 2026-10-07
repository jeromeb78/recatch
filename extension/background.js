import { collectOrderLinks, readPage, storeFor } from "./stores.js";

const PAGE_SETTLE_MS = 2500;  // let the store's app render after load
const BETWEEN_ORDERS_MS = 3000; // stay at a human pace
const LOAD_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (k) => (await chrome.storage.local.get(k))[k];
const set = (obj) => chrome.storage.local.set(obj);

async function post(page, store) {
  const conn = await get("conn");
  if (!conn) throw new Error("Not connected");
  const res = await fetch(conn.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${conn.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ store, url: page.url, title: page.title, text: page.text }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error("Connection code was revoked — reconnect in the popup."), { fatal: true });
  if (!res.ok) throw new Error(body.error || `Upload failed (${res.status})`);
  return body; // { outcome, receiptId?, detail? }
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const timer = setTimeout(done, LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function readTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: readPage });
  return result;
}

async function fetchOrderPage(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForLoad(tab.id);
    await sleep(PAGE_SETTLE_MS);
    let page = await readTab(tab.id);
    if (page.text.length < 400) {
      await sleep(3000);
      page = await readTab(tab.id);
    }
    return page;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

const looksLikeLogin = (url) => /sign[-_]?in|login|\/ap\/signin|account\/login/i.test(url);

let running = false;

async function runJob() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = await get("job");
      if (!job || job.state !== "running" || job.queue.length === 0) {
        if (job && job.state === "running") await set({ job: { ...job, state: "done", current: null } });
        return;
      }
      const item = job.queue[0];
      await set({ job: { ...job, current: item.url } });

      let outcome = "failed", detail = null;
      try {
        const page = await fetchOrderPage(item.url);
        if (looksLikeLogin(page.url)) {
          const j = await get("job");
          await set({ job: { ...j, state: "paused", current: null, error: `Sign in to ${job.store} in this browser, then press Resume.` } });
          return;
        }
        const res = await post(page, job.store);
        outcome = res.outcome === "receipt" || res.outcome === "duplicate" || res.outcome === "skipped" ? res.outcome : "failed";
        detail = res.detail ?? null;
      } catch (e) {
        detail = e.message;
        if (e.fatal) {
          const j = await get("job");
          await set({ job: { ...j, state: "paused", current: null, error: e.message } });
          return;
        }
      }

      const latest = await get("job");
      if (!latest) return; // cancelled meanwhile
      const imported = (await get("imported")) || {};
      if (outcome !== "failed") imported[item.url] = outcome;
      await set({
        imported,
        job: {
          ...latest,
          queue: latest.queue.slice(1),
          counts: { ...latest.counts, [outcome]: (latest.counts[outcome] || 0) + 1 },
          last: { url: item.url, outcome, detail },
          current: null,
        },
      });
      await sleep(BETWEEN_ORDERS_MS);
    }
  } finally {
    running = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    switch (msg.type) {
      case "scan": {
        const store = storeFor(msg.url);
        if (!store) return reply({ error: "Open your Walmart, Target or Amazon order history first." });
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: msg.tabId }, func: collectOrderLinks, args: [store],
        });
        const imported = (await get("imported")) || {};
        return reply({ store, orders: result, fresh: result.filter((o) => !imported[o.url]) });
      }
      case "start": {
        await set({ job: { store: msg.store, queue: msg.items, state: "running", counts: {}, total: msg.items.length, error: null } });
        runJob();
        return reply({ ok: true });
      }
      case "pause": {
        const job = await get("job");
        if (job) await set({ job: { ...job, state: "paused" } });
        return reply({ ok: true });
      }
      case "resume": {
        const job = await get("job");
        if (job) await set({ job: { ...job, state: "running", error: null } });
        runJob();
        return reply({ ok: true });
      }
      case "clear":
        await chrome.storage.local.remove("job");
        return reply({ ok: true });
      case "sendTab": {
        try {
          const page = await readTab(msg.tabId);
          const res = await post(page, storeFor(page.url) ?? "other");
          return reply(res);
        } catch (e) {
          return reply({ error: e.message });
        }
      }
      case "ping": {
        try {
          const res = await fetch(msg.endpoint, {
            method: "POST",
            headers: { Authorization: `Bearer ${msg.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ ping: true }),
          });
          return reply({ ok: res.ok, status: res.status });
        } catch (e) {
          return reply({ ok: false, error: e.message });
        }
      }
    }
  })();
  return true; // async reply
});

// The service worker may be stopped mid-import; pick the job back up when it wakes.
get("job").then((job) => { if (job?.state === "running") runJob(); });
