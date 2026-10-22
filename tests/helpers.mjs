// テスト用の補助：手元で wrangler dev（Cloudflare 公式のローカル実行環境）を起動し、
// 複数のスタッフ・参加者の端末を模擬する。本番の無料枠・本番データには一切触れない。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SETUP_TOKEN = "local-test-setup-token";
let portSeq = 8800 + Math.floor(Math.random() * 500);

export async function startServer() {
  const port = portSeq++;
  const dir = mkdtempSync(join(tmpdir(), "nazo-test-"));
  const proc = spawn(
    "npx",
    ["wrangler", "dev", "--env", "test", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", dir, "--var", `SETUP_TOKEN:${SETUP_TOKEN}`, "--show-interactive-dev-session=false"],
    { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try {
      const r = await fetch(base + "/api/info");
      if (r.ok) break;
    } catch {}
    if (i === 119) throw new Error("server did not start\n" + log);
  }
  return {
    base,
    log: () => log,
    async stop() {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {}
      await sleep(500);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 参加者用QRコードの合言葉（管理者の接続で受け取ったものを、参加者のログインに自動で付ける）
export const VIEWER_KEYS = new Map();
export async function post(base, path, body, token) {
  if (path === "/api/viewer" && body && !("key" in body)) body = { ...body, key: VIEWER_KEYS.get(base) ?? "" };
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

export async function setupAdmin(base, name = "管理者", password = "admin-pass-1") {
  const r = await post(base, "/api/setup", { token: SETUP_TOKEN, eventName: "テストイベント", boothCount: 3, name, password });
  if (r.status !== 200) throw new Error("setup failed " + JSON.stringify(r));
  return login(base, name, password);
}

export async function login(base, name, password) {
  const r = await post(base, "/api/login", { name, password });
  if (r.status !== 200) throw new Error("login failed " + JSON.stringify(r));
  return r.body.token;
}

let opSeq = 0;
export class Staff {
  constructor(base, token) {
    this.base = base;
    this.token = token;
    this.state = null;
    this.msgs = [];
    this.pending = new Map();
    this.listeners = new Set();
  }
  async connect() {
    this.ws = new WebSocket(this.base.replace("http", "ws") + "/ws", ["nazo", "s." + this.token]);
    this.closed = false;
    this.state = null;
    this.ws.addEventListener("message", (e) => this.onMsg(JSON.parse(e.data)));
    this.ws.addEventListener("close", (e) => {
      this.closed = true;
      this.closeCode = e.code;
    });
    await this.until(() => this.state || this.authFailed, 10000);
    return this;
  }
  onMsg(m) {
    this.msgs.push(m);
    if (m.viewerKey) VIEWER_KEYS.set(this.base, m.viewerKey);
    if (m.t === "snap") this.state = { ...m, res: new Map(m.res.map((r) => [r.id, r])), rounds: new Map(m.rounds.map((r) => [r.id, r])) };
    else if (m.t === "d" && this.state) {
      for (const r of m.res ?? []) this.state.res.set(r.id, r);
      for (const r of m.rounds ?? []) this.state.rounds.set(r.id, r);
      for (const id of m.delRounds ?? []) this.state.rounds.delete(id);
      for (const k of ["eventName", "viewerKey", "viewTexts", "sponsors", "devices", "booths", "notices", "reqs", "staff", "days", "counters", "warnings", "templates"]) if (m[k]) this.state[k] = m[k];
      if (m.chat) this.state.chat.push(...m.chat);
    } else if (m.t === "r") {
      const ps = this.pending.get(m.id);
      if (ps?.length) {
        ps.shift()(m);
        if (!ps.length) this.pending.delete(m.id);
      }
    } else if (m.t === "auth" && !m.ok) this.authFailed = true;
    for (const l of this.listeners) l(m);
  }
  send(cmd, a = {}, opts = {}) {
    const id = opts.id ?? `op-${Date.now()}-${++opSeq}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const entry = (m) => {
        clearTimeout(timer);
        resolve(m);
      };
      const timer = setTimeout(() => {
        const ps = this.pending.get(id) ?? [];
        const i = ps.indexOf(entry);
        if (i >= 0) ps.splice(i, 1);
        reject(new Error("timeout " + cmd));
      }, 15000);
      if (!this.pending.has(id)) this.pending.set(id, []);
      this.pending.get(id).push(entry);
      this.ws.send(JSON.stringify({ id, cmd, a, ep: opts.ep ?? this.state?.epoch }));
    });
  }
  async ok(cmd, a = {}, opts = {}) {
    const r = await this.send(cmd, a, opts);
    if (!r.ok) throw new Error(`${cmd} failed: ${r.error}`);
    return r;
  }
  find(lbl) {
    for (const r of this.state.res.values()) if (`${r.booth}${r.num}` === lbl && r.day === this.state.activeDay) return r;
    return null;
  }
  async until(pred, ms = 5000) {
    const t = Date.now();
    while (!pred()) {
      if (Date.now() - t > ms) throw new Error("until timeout");
      await sleep(20);
    }
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

export class Viewer {
  constructor(base) {
    this.base = base;
    this.views = [];
  }
  async login(number, code, device = "dev-" + Math.random()) {
    const r = await post(this.base, "/api/viewer", { number, code, device });
    this.loginResult = r;
    if (r.status === 200) this.token = r.body.token;
    return r;
  }
  async connect(token = this.token) {
    this.ws = new WebSocket(this.base.replace("http", "ws") + "/ws", ["nazo", "v." + token]);
    this.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.t === "view") this.views.push(m);
      if (m.t === "invalid" || (m.t === "auth" && !m.ok)) this.invalid = true;
    });
    this.ws.addEventListener("close", () => (this.closed = true));
    const t = Date.now();
    while (!this.views.length && !this.invalid) {
      if (Date.now() - t > 8000) throw new Error("viewer connect timeout");
      await sleep(20);
    }
    return this;
  }
  get last() {
    return this.views[this.views.length - 1];
  }
  async untilPhase(phase, ms = 5000) {
    const t = Date.now();
    while (this.last?.view?.phase !== phase) {
      if (Date.now() - t > ms) throw new Error(`phase ${phase} not reached; last=${JSON.stringify(this.last)}`);
      await sleep(20);
    }
    return this.last;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}
