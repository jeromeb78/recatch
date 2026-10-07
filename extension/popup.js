import { STORES, storeFor } from "./stores.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
let tab = null;
let scanned = null;

function parseCode(code) {
  try {
    const { u, t } = JSON.parse(atob(code.trim()));
    if (!/^https:\/\/.+\/functions\/v1\/ingest-page$/.test(u) || !/^rc_/.test(t)) return null;
    return { endpoint: u, token: t };
  } catch {
    return null;
  }
}

async function render() {
  const { conn, job } = await chrome.storage.local.get(["conn", "job"]);
  $("connect").hidden = !!conn;
  $("main").hidden = !conn;
  $("disconnect").hidden = !conn;
  if (!conn) return;

  const store = tab ? storeFor(tab.url) : null;
  $("onStore").hidden = !store || (job && job.state === "running");
  $("offStore").hidden = !!store;
  if (store) $("storeName").textContent = STORES[store].label;

  $("job").hidden = !job;
  if (job) {
    const done = job.total - job.queue.length;
    const c = job.counts || {};
    $("jobTitle").textContent = job.state === "done" ? `${STORES[job.store]?.label ?? ""} import finished`
      : job.state === "paused" ? "Import paused" : `Importing from ${STORES[job.store]?.label ?? job.store}`;
    $("jobCount").textContent = `${done} / ${job.total}`;
    $("jobBar").style.width = `${job.total ? (done / job.total) * 100 : 0}%`;
    $("jobStats").textContent = `${c.receipt || 0} new · ${c.duplicate || 0} already had · ${c.skipped || 0} not receipts · ${c.failed || 0} failed`;
    $("jobError").hidden = !job.error;
    $("jobError").textContent = job.error || "";
    $("pauseBtn").hidden = job.state !== "running";
    $("resumeBtn").hidden = job.state !== "paused";
  }
}

$("connectBtn").onclick = async () => {
  const conn = parseCode($("code").value);
  if (!conn) {
    $("connectMsg").className = "msg error";
    $("connectMsg").textContent = "That doesn’t look like a connection code.";
    return;
  }
  $("connectBtn").disabled = true;
  const res = await send({ type: "ping", ...conn });
  $("connectBtn").disabled = false;
  if (!res.ok) {
    $("connectMsg").className = "msg error";
    $("connectMsg").textContent = res.status === 401 ? "This code was revoked or is wrong. Create a new one in Settings." : `Couldn’t reach Receipt Catcher (${res.error || res.status}).`;
    return;
  }
  await chrome.storage.local.set({ conn });
  render();
};

$("disconnect").onclick = async () => {
  await chrome.storage.local.remove(["conn", "job"]);
  render();
};

$("scanBtn").onclick = async () => {
  $("scanMsg").textContent = "Looking…";
  const res = await send({ type: "scan", tabId: tab.id, url: tab.url });
  if (res.error) {
    $("scanMsg").textContent = res.error;
    return;
  }
  scanned = res;
  const already = res.orders.length - res.fresh.length;
  $("scanMsg").textContent = res.orders.length
    ? `Found ${res.orders.length} order${res.orders.length === 1 ? "" : "s"}${already ? ` (${already} already imported)` : ""}.`
    : "No orders found here. Make sure your order list is showing, then try again.";
  $("importBtn").hidden = res.fresh.length === 0;
  $("importBtn").textContent = `Import ${res.fresh.length} order${res.fresh.length === 1 ? "" : "s"}`;
};

$("importBtn").onclick = async () => {
  if (!scanned?.fresh.length) return;
  await send({ type: "start", store: scanned.store, items: scanned.fresh });
  $("importBtn").hidden = true;
  $("scanMsg").textContent = "";
  render();
};

$("pauseBtn").onclick = async () => { await send({ type: "pause" }); render(); };
$("resumeBtn").onclick = async () => { await send({ type: "resume" }); render(); };
$("clearBtn").onclick = async () => { await send({ type: "clear" }); render(); };

$("sendBtn").onclick = async () => {
  $("sendBtn").disabled = true;
  $("sendMsg").className = "msg";
  $("sendMsg").textContent = "Reading this page…";
  const res = await send({ type: "sendTab", tabId: tab.id });
  $("sendBtn").disabled = false;
  if (res.error) {
    $("sendMsg").className = "msg error";
    $("sendMsg").textContent = res.error;
  } else if (res.outcome === "receipt") {
    $("sendMsg").className = "msg ok";
    $("sendMsg").textContent = res.status === "needs_review" ? "Captured — needs a quick review in the app." : "Captured.";
  } else {
    $("sendMsg").textContent = res.detail || "Nothing captured.";
  }
};

for (const a of document.querySelectorAll("[data-store]")) {
  a.onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: STORES[a.dataset.store].historyUrl });
  };
}

chrome.storage.onChanged.addListener(render);
[tab] = await chrome.tabs.query({ active: true, currentWindow: true });
render();
