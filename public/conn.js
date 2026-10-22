// サーバーとのリアルタイム接続（WebSocket）。
// ・サーバーは 1 分ごとに生存通知を送る。2 分半届かなければ「接続が不安定」として再接続する。
// ・切れたら自動で再接続（間隔を少しずつ延ばす）。画面を開き直した時・通信が戻った時はすぐ再接続。
// ・通信できない間は「送信できない」ことをはっきり示す（成功したように見せない）。
export class Conn {
  constructor({ credential, onMessage, onStatus, onAuthFail }) {
    this.credential = credential;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.onAuthFail = onAuthFail;
    this.ws = null;
    this.lastMsgAt = 0;
    this.lastDataAt = 0;
    this.retry = 0;
    this.timer = null;
    this.stopped = false;
    this.status = "connecting";
    setInterval(() => this.watchdog(), 10_000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.kick();
    });
    window.addEventListener("online", () => this.kick());
    window.addEventListener("offline", () => this.setStatus("offline"));
  }
  url() {
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
  }
  start() {
    this.stopped = false;
    this.open();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    try {
      this.ws?.close();
    } catch {}
  }
  open() {
    clearTimeout(this.timer);
    if (this.stopped) return;
    try {
      this.ws?.close();
    } catch {}
    this.setStatus("connecting");
    let ws;
    try {
      ws = new WebSocket(this.url(), ["nazo", this.credential]);
    } catch {
      return this.schedule();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.lastMsgAt = Date.now();
    };
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      this.lastMsgAt = Date.now();
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === "auth" && !m.ok) {
        this.stopped = true;
        this.onAuthFail?.(m.reason);
        return;
      }
      if (m.t !== "hb") this.lastDataAt = Date.now();
      this.setStatus("online");
      this.onMessage(m);
    };
    ws.onclose = (e) => {
      if (ws !== this.ws) return;
      if (e.code === 4001 || e.code === 4002) return; // 認証切れ・リセット（onAuthFail / invalid で処理）
      this.setStatus("offline");
      this.schedule();
    };
    ws.onerror = () => {};
  }
  schedule() {
    if (this.stopped) return;
    const waits = [1000, 2000, 4000, 8000, 15000, 30000];
    const w = waits[Math.min(this.retry++, waits.length - 1)];
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), w);
  }
  kick() {
    if (this.stopped) return;
    if (!this.isOpen() || Date.now() - this.lastMsgAt > 75_000) {
      this.retry = 0;
      this.open();
    }
  }
  watchdog() {
    if (this.stopped) return;
    if (this.isOpen() && Date.now() - this.lastMsgAt > 150_000) {
      this.setStatus("offline");
      this.open();
    }
  }
  isOpen() {
    return this.ws && this.ws.readyState === WebSocket.OPEN && this.status === "online";
  }
  send(obj) {
    if (!this.isOpen()) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }
  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus?.(s);
  }
}

export function fmtClock(ms, withSec = false) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}${withSec ? ":" + p(d.getSeconds()) : ""}`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function lsGet(k, dflt = null) {
  try {
    const v = localStorage.getItem(k);
    return v === null ? dflt : JSON.parse(v);
  } catch {
    return dflt;
  }
}
export function lsSet(k, v) {
  try {
    if (v === null || v === undefined) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}

export function toast(msg, kind = "", ms = 3500) {
  let box = document.getElementById("toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    document.body.appendChild(box);
  }
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.setAttribute("role", "status");
  el.textContent = msg;
  el.onclick = () => el.remove();
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function connLabel(status, lastAt) {
  const t = lastAt ? fmtClock(lastAt, true) : "--:--";
  if (status === "online") return `接続中・最終更新 ${t}`;
  if (status === "connecting") return `再接続中…（表示は ${t} 時点）`;
  return `通信できません（表示は ${t} 時点の情報です）`;
}
