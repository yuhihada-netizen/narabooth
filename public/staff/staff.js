// スタッフ画面（受付・ブース操作・お知らせ・連絡・管理）
// 権限の判定はサーバー側で必ず行う。ここでのボタンの出し分けは操作しやすさのためだけ。
import { Conn, fmtClock, esc, lsGet, lsSet, toast, connLabel } from "/conn.js";

const $ = (id) => document.getElementById(id);
const K = { token: "nazo.staffToken", name: "nazo.staffName", cache: "nazo.staffCache", issued: "nazo.issued" };
const STATUS_JA = { waiting: "順番待ち", called: "呼び出し中", playing: "参加中", done: "終了", absent: "不在", cancelled: "取消" };
const ROLE_JA = { admin: "全体管理者", sub: "サブ管理者", support: "サポート担当" };
const SCOPE_JA = { all: "全体", booth: "ブース全体", calling: "呼び出し中の回", next: "次の回", res: "特定の組" };

const S = {
  token: lsGet(K.token),
  st: null, // サーバーから受け取った状態
  conn: null,
  tab: "booth",
  booth: null,
  selected: new Set(),
  pending: new Map(),
  issued: [],
  chatCh: "all",
  commsView: "chat",
  stateAt: 0,
  fromCache: false,
  findQuery: "",
};

// ================= 起動 =================
async function boot() {
  fetch("/api/info")
    .then((r) => r.json())
    .then((i) => {
      if (i.env) {
        $("loginEnv").textContent = i.env;
        $("loginEnv").classList.remove("hidden");
      }
      if (i.needsSetup) location.href = "/setup.html";
    })
    .catch(() => {});
  // 画面のファイルを端末に保存し、通信できない時でも開き直せるようにする（無料枠は使わない）
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/staff/sw.js", { scope: "/staff/" }).catch(() => {});
  readHash();
  if (!S.token) return showLogin();
  const cache = lsGet(K.cache);
  if (cache?.st) {
    // 通信できない時でも、最後に受信した内容を表示する
    setState(cache.st, true);
    S.stateAt = cache.at;
    S.fromCache = true;
  }
  startApp();
}

function showLogin(msg) {
  S.conn?.stop();
  $("app").classList.add("hidden");
  $("loginSec").classList.remove("hidden");
  $("lName").value = lsGet(K.name) ?? "";
  if (msg) {
    $("loginMsg").textContent = msg;
    $("loginMsg").classList.remove("hidden");
  }
}

$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  $("loginBtn").disabled = true;
  try {
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("lName").value, password: $("lPw").value }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) {
      $("loginMsg").textContent = b.error ?? "ログインできませんでした";
      $("loginMsg").classList.remove("hidden");
      return;
    }
    S.token = b.token;
    lsSet(K.token, b.token);
    lsSet(K.name, $("lName").value);
    lsSet(K.cache, null);
    $("lPw").value = "";
    $("loginMsg").classList.add("hidden");
    startApp();
  } catch {
    $("loginMsg").textContent = "通信できませんでした。もう一度お試しください。";
    $("loginMsg").classList.remove("hidden");
  } finally {
    $("loginBtn").disabled = false;
  }
};

function startApp() {
  $("loginSec").classList.add("hidden");
  $("app").classList.remove("hidden");
  S.issued = lsGet(K.issued) ?? [];
  S.conn = new Conn({
    credential: "s." + S.token,
    onMessage,
    onStatus: () => renderTop(),
    onAuthFail: () => {
      lsSet(K.token, null);
      lsSet(K.cache, null);
      S.token = null;
      showLogin("ログインが無効になりました（ログアウト・パスワード変更・アクセス停止など）。もう一度ログインしてください。");
    },
  });
  S.conn.start();
  render();
}

// ================= 画面の新しい版の確認 =================
// 接続（再接続）のたびに画面のファイルの版を確認し、修正版が公開されていたら「更新」を案内する。
// 画面のファイルの確認は無料・無制限の部分で、無料枠は使わない。
const VER_FILES = ["/staff/", "/staff/staff.js", "/staff/staff.css", "/style.css", "/conn.js"];
let verSig = null;
async function checkVersion() {
  try {
    const sig = (
      await Promise.all(
        VER_FILES.map(async (u) => {
          const r = await fetch(u, { method: "HEAD", cache: "no-store" });
          return r.ok ? (r.headers.get("etag") ?? r.headers.get("last-modified") ?? r.headers.get("content-length") ?? "") : "";
        }),
      )
    ).join("|");
    if (sig.replace(/\|/g, "") === "") return;
    if (verSig === null) verSig = sig;
    else if (sig !== verSig) $("updateBanner").classList.remove("hidden");
  } catch {}
}

// ================= 受信 =================
function setState(m, fromCache = false) {
  S.st = { ...m, res: new Map(m.res.map((r) => [r.id, r])), rounds: new Map(m.rounds.map((r) => [r.id, r])) };
  if (!fromCache) S.fromCache = false;
}

function onMessage(m) {
  if (m.t === "snap") {
    const prevEpoch = S.st?.epoch;
    setState(m);
    S.stateAt = Date.now();
    if (prevEpoch && prevEpoch !== m.epoch) {
      S.selected.clear();
      S.issued = [];
      lsSet(K.issued, []);
    }
    // 再接続した時：結果が分からなかった操作を同じ操作IDで再送（サーバー側で二重処理しない）
    for (const p of S.pending.values()) S.conn.send({ id: p.id, cmd: p.cmd, a: p.a, ep: p.ep });
    saveCacheSoon();
    checkVersion();
  } else if (m.t === "d" && S.st) {
    for (const r of m.res ?? []) S.st.res.set(r.id, r);
    for (const r of m.rounds ?? []) S.st.rounds.set(r.id, r);
    for (const id of m.delRounds ?? []) S.st.rounds.delete(id);
    for (const k of ["eventName", "viewerKey", "viewTexts", "sponsors", "devices", "booths", "notices", "reqs", "staff", "days", "counters", "warnings", "templates", "usage"]) if (m[k]) S.st[k] = m[k];
    if (m.chat) {
      S.st.chat.push(...m.chat);
      for (const c of m.chat) if (c.name !== S.st.me.name) toast(`💬 ${c.ch === "all" ? "全体" : "ブース" + c.ch}｜${c.name}：${c.text.slice(0, 40)}`, "", 5000);
    }
    if (m.reqs) {
      const known = S.knownReqs ?? new Set();
      for (const q of m.reqs) if (!known.has(q.id) && q.status === "open" && S.knownReqs) toast(`🔔 対応依頼：${q.text.slice(0, 40)}`, "warn", 7000);
      S.knownReqs = new Set(m.reqs.map((q) => q.id));
    }
    S.stateAt = Date.now();
    saveCacheSoon();
  } else if (m.t === "reset") {
    toast("全リセットが実行されました。画面を新しい状態に更新しました。", "warn", 8000);
  } else if (m.t === "r") {
    const p = S.pending.get(m.id);
    if (p) {
      S.pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve(m);
    }
  }
  if (S.st && !S.knownReqs) S.knownReqs = new Set(S.st.reqs.map((q) => q.id));
  scheduleRender();
}

let cacheTimer = null;
function saveCacheSoon() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    if (!S.st) return;
    const st = { ...S.st, res: [...S.st.res.values()], rounds: [...S.st.rounds.values()], chat: S.st.chat.slice(-100) };
    lsSet(K.cache, { at: S.stateAt, st });
  }, 3000);
}

// ================= 送信 =================
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function send(cmd, a) {
  return new Promise((resolve) => {
    if (!S.st || !S.conn.isOpen()) {
      toast("通信できないため送信していません。接続が戻ってから操作してください。", "error", 6000);
      return resolve(null);
    }
    const id = uuid();
    const p = { id, cmd, a, ep: S.st.epoch, resolve };
    S.pending.set(id, p);
    S.conn.send({ id, cmd, a, ep: p.ep });
    p.timer = setTimeout(() => renderTop(), 6000);
    renderTop();
  }).finally(() => renderTop());
}

// 操作を送り、確認が必要なら確認してから再送する
async function cmd(name, a = {}, btn = null, opts = {}) {
  if (btn) {
    if (btn.classList.contains("busy")) return null; // 連打防止
    btn.classList.add("busy");
  }
  try {
    let r = await send(name, a);
    if (r && !r.ok && r.confirm) {
      const ok = await confirmModal(opts.confirmTitle ?? "確認", r.error, opts.confirmOk ?? "はい、実行する");
      if (!ok) return null;
      r = await send(name, { ...a, ...(opts.confirmArgs ?? { force: true }) });
      if (r && !r.ok && r.confirm) {
        const ok2 = await confirmModal("確認", r.error, "はい、実行する");
        if (!ok2) return null;
        r = await send(name, { ...a, ...(opts.confirmArgs ?? {}), force: true });
      }
    }
    if (!r) return null;
    if (!r.ok) {
      toast(r.error ?? "操作できませんでした", "error", 7000);
      return null;
    }
    if (r.dup) toast(r.msg ?? "この操作はすでに反映されています", "warn");
    else if (r.msg) toast(r.msg, "warn");
    return r;
  } finally {
    btn?.classList.remove("busy");
  }
}

// ================= 補助 =================
const L = (r) => `${r.booth}${r.num}`;
const yen = (n) => `${Number(n || 0).toLocaleString("ja-JP")}円`;
const me = () => S.st?.me;
const isAdmin = () => me()?.role === "admin";
const canOp = (b) => isAdmin() || (me()?.role === "sub" && me().booths.includes(b));
const canIssue = (b) => isAdmin() || (me()?.canIssue && me().booths.includes(b));
// 受付権限（「受付もできる」）がある人は、担当ブースの並び替え・修正・復元・お知らせもできる
const canNotice = (b) => isAdmin() || (me()?.canIssue && (!b || me().booths.includes(b)));
const canAllNotice = () => isAdmin() || !!me()?.canIssue;
const boothName = (id) => S.st?.booths.find((b) => b.id === id)?.name ?? id;
const enabledBooths = () => (S.st?.booths ?? []).filter((b) => b.enabled);
// 役割名ごとの「今ログイン中の端末数」（全体管理者の画面だけに届く）
const deviceBadge = (id) => {
  const n = S.st?.devices?.[id] ?? 0;
  return n ? ` <span class="badge ok">今 ${n}台でログイン中</span>` : ` <span class="badge">ログイン中の端末なし</span>`;
};
// 協賛・お知らせ枠の画像：選ばれたファイルを覚えておき、保存時に縮小して送る
let sponsorFile = null;
document.addEventListener("change", (e) => {
  if (e.target?.name === "sponsorImg") sponsorFile = e.target.files?.[0] ?? null;
});
async function shrinkImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, ng) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = ng;
      i.src = url;
    });
    let w = img.naturalWidth, h = img.naturalHeight;
    const scale = Math.min(1, 800 / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    for (const q of [0.85, 0.75, 0.6, 0.45, 0.3]) {
      const out = c.toDataURL("image/jpeg", q);
      if (out.length <= 190000) return out;
    }
    throw new Error("too large");
  } finally {
    URL.revokeObjectURL(url);
  }
}
// 掲示用QRコードの作成画面のアドレス（参加者用アドレスは # の後ろに入れるので、サーバーには送られない）
const participantUrl = () => `${location.origin}/?k=${encodeURIComponent(S.st?.viewerKey ?? "")}`;
const qrPageUrl = () => `/qr.html#u=${encodeURIComponent(participantUrl())}`;
const staffQrPageUrl = () => `/qr.html#t=staff&u=${encodeURIComponent(location.origin + "/staff/")}`;
// スタッフの担当ブースの選択肢：使用中のブース＋その人にすでに割り当て済みのブース
const staffBoothIds = (s) => (S.st?.booths ?? []).filter((b) => b.enabled || s?.booths?.includes(b.id)).map((b) => b.id);
const today = () => [...(S.st?.res.values() ?? [])].filter((r) => r.day === S.st.activeDay);
const nowMs = () => Date.now();
const mins = (ms) => Math.floor(ms / 60000);

function boothQ(b) {
  const mine = today().filter((r) => r.booth === b.id);
  const rounds = [...S.st.rounds.values()].filter((r) => r.booth === b.id);
  const waiting = mine.filter((r) => r.status === "waiting").sort((x, y) => x.pos - y.pos || x.id - y.id);
  const planned = [];
  for (let i = 0; i < waiting.length; i += Math.max(1, b.capacity)) planned.push(waiting.slice(i, i + b.capacity));
  const calling = rounds.find((r) => r.status === "calling") ?? null;
  const playingRounds = rounds.filter((r) => r.status === "playing");
  return {
    mine,
    waiting,
    planned,
    calling,
    callingMembers: calling ? mine.filter((r) => r.round === calling.id && r.status === "called") : [],
    playing: mine.filter((r) => r.status === "playing").sort((x, y) => x.startedAt - y.startedAt || x.num - y.num),
    lateCalled: mine.filter((r) => r.status === "called" && playingRounds.some((p) => p.id === r.round)),
    playingRounds,
    absent: mine.filter((r) => r.status === "absent"),
    recent: mine.filter((r) => r.status === "done" || r.status === "cancelled").sort((x, y) => (y.endedAt ?? y.createdAt) - (x.endedAt ?? x.createdAt)),
  };
}

// 新しく並ぶ組の待ち時間の目安（受付で案内する用）
function newcomerWait(b, q) {
  if (b.paused) return "一時停止中";
  const k = Math.floor(q.waiting.length / Math.max(1, b.capacity));
  let remMin = 0,
    remMax = 0;
  const last = q.playingRounds.filter((r) => r.startedAt).sort((x, y) => y.startedAt - x.startedAt)[0];
  if (last) {
    const el = nowMs() - last.startedAt;
    remMin = Math.max(0, b.durMin * 60000 - el);
    remMax = Math.max(0, b.durMax * 60000 - el);
  }
  const c = (q.calling ? 1 : 0) + k;
  const lo = Math.floor((remMin + c * b.durMin * 60000) / 60000 / 5) * 5;
  const hi = Math.ceil((remMax + c * b.durMax * 60000) / 60000 / 5) * 5;
  if (hi <= 0) return "すぐ";
  return `約${lo}〜${hi}分`;
}

// ================= 描画 =================
let rafId = 0;
function scheduleRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    render();
  });
}
setInterval(() => scheduleRender(), 15000);

function render() {
  renderTop();
  const hdr = document.querySelector("header.top");
  if (hdr) document.documentElement.style.setProperty("--hdr", hdr.offsetHeight + "px");
  if (!S.st) return;
  renderTabs();
  for (const t of ["reception", "booth", "notice", "comms", "stats", "admin", "print"]) $("tab-" + t).classList.toggle("hidden", S.tab !== t);
  const f = { reception: renderReception, booth: renderBooth, notice: renderNotice, comms: renderComms, stats: renderStats, admin: renderAdmin, print: renderPrint }[S.tab];
  f?.();
}

function renderTop() {
  const st = S.conn?.status ?? "connecting";
  $("conn").className = "conn " + st;
  $("connText").textContent = S.fromCache && st !== "online" ? connLabel("offline", S.stateAt) : connLabel(st, S.conn?.lastMsgAt || S.stateAt);
  $("offlineBanner").classList.toggle("hidden", st === "online" || !S.st);
  const slow = [...S.pending.values()].length;
  $("pendingBanner").classList.toggle("hidden", !slow);
  $("pendingBanner").textContent = slow ? `送信結果を確認中の操作が ${slow} 件あります（反映されたかどうかは、接続が戻ると確定します）` : "";
  if (!S.st) return;
  if (S.st.env) {
    $("envBadge").textContent = S.st.env;
    $("envBadge").classList.remove("hidden");
  }
  const day = S.st.days.find((d) => d.id === S.st.activeDay);
  $("dayLabel").textContent = `${S.st.eventName}｜${day?.label ?? ""}`;
  document.title = `スタッフ画面｜${S.st.eventName}`;
  $("meBtn").textContent = `${S.st.me.name}（${ROLE_JA[S.st.me.role]}）`;
}

function tabsFor() {
  const t = [];
  if (isAdmin() || me().canIssue) t.push(["reception", "受付"]);
  t.push(["booth", "ブース"]);
  if (isAdmin() || me().canIssue) t.push(["notice", "お知らせ"]);
  t.push(["comms", "連絡"]);
  if (isAdmin() || me().canIssue) t.push(["stats", "集計"]);
  if (isAdmin()) t.push(["admin", "管理"]);
  return t;
}

function unreadCount(ch) {
  const last = lsGet(`nazo.read.${S.st.epoch}.${me().id}.${ch}`, 0);
  return S.st.chat.filter((c) => c.ch === ch && c.id > last && c.name !== me().name).length;
}
function chans() {
  return ["all", ...enabledBooths().map((b) => b.id)].filter((c) => c === "all" || me().role !== "sub" || me().booths.includes(c));
}

function renderTabs() {
  const tabs = tabsFor();
  if (!tabs.some(([k]) => k === S.tab) && S.tab !== "print") S.tab = tabs.some(([k]) => k === "booth") ? "booth" : tabs[0][0];
  const unread = chans().reduce((n, c) => n + unreadCount(c), 0);
  const open = S.st.reqs.filter((q) => q.status === "open").length;
  $("tabs").innerHTML = tabs
    .map(([k, label]) => {
      const cnt = k === "comms" && unread + open ? `<span class="cnt">${unread + open}</span>` : "";
      return `<button data-act="tab" data-tab="${k}" aria-current="${S.tab === k}">${label}${cnt}</button>`;
    })
    .join("");
}

// ---------- ブース ----------
function renderBooth() {
  const list = enabledBooths().filter((b) => isAdmin() || me().role === "support" || me().booths.includes(b.id));
  const visible = list.length ? list : enabledBooths();
  if (!visible.some((b) => b.id === S.booth)) S.booth = visible[0]?.id ?? null;
  const b = S.st.booths.find((x) => x.id === S.booth);
  if (!b) {
    $("tab-booth").innerHTML = `<div class="card">使用中のブースがありません。</div>`;
    return;
  }
  const q = boothQ(b);
  const op = canOp(b.id);
  const chips =
    visible.length > 1
      ? `<div class="chips">${visible.map((x) => `<button data-act="booth" data-b="${x.id}" aria-pressed="${x.id === b.id}">ブース${esc(x.id)}</button>`).join("")}</div>`
      : "";
  let h = chips;
  h += `<div class="booth-head bg${b.id} ${b.paused ? "paused" : ""}">
    <div class="row" style="justify-content:space-between">
      <div><div class="bname">ブース ${esc(b.id)}${b.name !== b.id ? `<span style="font-size:1.1rem">｜${esc(b.name)}</span>` : ""}</div>
      <div class="meta">${b.paused ? `⏸ 一時停止中${b.pauseReason ? "：" + esc(b.pauseReason) : ""}｜` : ""}1回 ${b.capacity}組・${b.durMin}〜${b.durMax}分｜待ち ${q.waiting.length}組</div></div>
      ${op ? `<button class="mini ${b.paused ? "ok" : "warn"}" data-act="pause" data-b="${b.id}">${b.paused ? "再開する" : "一時停止"}</button>` : ""}
    </div></div>`;
  if (!op) h += `<div class="banner info">閲覧のみです（このブースの操作権限はありません）。</div>`;

  // 参加中
  const playing = q.playing;
  h += `<div class="sec-title"><h2>参加中（${playing.length}組）</h2>${op && playing.length > 1 ? selBtns("end", playing, "終了") : ""}</div>`;
  if (!playing.length) h += `<div class="empty">参加中の組はありません。</div>`;
  for (const r of playing) {
    const el = nowMs() - r.startedAt;
    const over = el > b.durMax * 60000;
    h += `<div class="rcard ${S.selected.has(r.id) ? "sel" : ""}">
      ${op && playing.length > 1 ? `<input type="checkbox" data-sel="${r.id}" ${S.selected.has(r.id) ? "checked" : ""} aria-label="${L(r)}を選択">` : ""}
      <div class="rnum">${L(r)}</div>
      <div class="rmeta">開始 <b>${fmtClock(r.startedAt)}</b>（<span class="${over ? "over" : ""}">${mins(el)}分経過${over ? "・予定超過" : ""}</span>）${noteHtml(r)}</div>
      ${op ? `<div class="ract"><button class="big ok" data-act="end" data-id="${r.id}">終了</button><button class="mini ghost" data-act="undoStart" data-id="${r.id}">開始を取消</button></div>` : ""}
    </div>`;
  }
  // 遅れて来た同じ回の組
  if (q.lateCalled.length) {
    h += `<div class="sec-title"><h2>同じ回でまだ開始していない組</h2></div>`;
    for (const r of q.lateCalled) h += calledCard(r, op);
    if (op && q.lateCalled.length > 1) h += `<button class="huge" data-act="startAll" data-ids="${q.lateCalled.map((r) => r.id).join(",")}">${q.lateCalled.length}組をまとめて開始</button>`;
  }

  // 呼び出し中の回 または 次の回
  if (q.calling) {
    const ms = q.callingMembers;
    h += `<div class="sec-title"><h2>呼び出し中の回（${ms.length}組）</h2>${op ? `<button class="mini ghost" data-act="uncall" data-b="${b.id}">呼び出しを取り消す</button>` : ""}</div>`;
    h += `<p class="small muted" style="margin:0 0 6px">呼び出し ${fmtClock(q.calling.calledAt)}。来た組から「開始」を押してください（同じ回にまとまります）。来ない組は「不在」にできます。</p>`;
    for (const r of ms) h += calledCard(r, op);
    if (op && ms.length > 1) h += `<button class="huge" data-act="startAll" data-ids="${ms.map((r) => r.id).join(",")}">この回の${ms.length}組をまとめて開始</button>`;
    if (q.planned[0]) h += `<div class="sec-title"><h2>その次の回（予定）</h2></div><div class="planned">${q.planned[0].map((r) => `<b style="font-size:1.3rem;margin-right:12px">${L(r)}</b>`).join("")}</div>`;
  } else if (q.planned[0]) {
    const first = q.planned[0];
    h += `<div class="sec-title"><h2>次の回（${first.length}組）</h2></div>`;
    h += `<div class="planned">`;
    for (const r of first)
      h += `<div class="rcard"><div class="rnum">${L(r)}</div><div class="rmeta">受付 ${fmtClock(r.createdAt)}${noteHtml(r)}</div>${op ? `<div class="ract"><button class="big" data-act="start" data-id="${r.id}">開始</button><button class="mini warn" data-act="absent" data-id="${r.id}">不在</button></div>` : ""}</div>`;
    if (op) h += `<div class="row"><button class="big sub grow" data-act="call" data-b="${b.id}">この回を呼び出す</button>${first.length > 1 ? `<button class="big grow" data-act="startAll" data-ids="${first.map((r) => r.id).join(",")}">まとめて開始</button>` : ""}</div>`;
    h += `<p class="small muted" style="margin:6px 0 0">「呼び出す」と参加者画面に「あなたの番です」と表示されます。呼び出さずに「開始」を押しても、この回の組はまとめて扱われます。</p></div>`;
  } else h += `<div class="sec-title"><h2>次の回</h2></div><div class="empty">待っている組はいません。</div>`;

  // 待ち列
  const rest = q.calling ? q.waiting : q.waiting.slice(q.planned[0]?.length ?? 0);
  const offset = q.calling ? 0 : (q.planned[0]?.length ?? 0);
  h += `<div class="sec-title"><h2>待ち列（このあと ${rest.length}組）</h2></div>`;
  if (!rest.length) h += `<div class="empty">ありません。</div>`;
  else h += `<div class="card" style="padding:4px 10px">${rest.map((r, i) => queueRow(r, i + offset + 1, q, b)).join("")}</div>`;
  if (canIssue(b.id) && q.waiting.length > 1) h += `<p class="small muted">順番の入れ替え：「▲」で1つ前の組と入れ替えます。「先頭へ」「最後尾へ」も使えます。</p>`;

  // 不在
  h += `<div class="sec-title"><h2>不在（${q.absent.length}組）</h2></div>`;
  if (!q.absent.length) h += `<div class="empty">ありません。</div>`;
  for (const r of q.absent)
    h += `<div class="rcard"><div class="rnum">${L(r)}</div><div class="rmeta">戻ってきたら、入れる場所を選んでください${noteHtml(r)}</div>${
      op
        ? `<div class="ract">${q.calling ? `<button class="mini" data-act="ret" data-mode="round" data-id="${r.id}">呼び出し中の回へ</button>` : ""}<button class="mini sub" data-act="ret" data-mode="front" data-id="${r.id}">待ち列の先頭へ</button><button class="mini ghost" data-act="ret" data-mode="back" data-id="${r.id}">最後尾へ</button>${canIssue(b.id) ? `<button class="mini danger sub" data-act="cancel" data-id="${r.id}">取消</button>` : ""}</div>`
        : ""
    }</div>`;

  // 最近の終了・取消
  const recent = q.recent.slice(0, 8);
  h += `<div class="sec-title"><h2>最近の終了・取消</h2></div>`;
  if (!recent.length) h += `<div class="empty">ありません。</div>`;
  else
    h += `<div class="card" style="padding:4px 10px">${recent
      .map(
        (r) => `<div class="qrow"><div class="qn">${L(r)}</div><div class="qm">${STATUS_JA[r.status]}${r.endedAt ? " " + fmtClock(r.endedAt) : ""}${noteHtml(r)}</div><div class="qa">${
          r.status === "done" && op ? `<button class="mini ghost" data-act="undoEnd" data-id="${r.id}">終了を取り消す</button>` : ""
        }${r.status === "cancelled" && canIssue(r.booth) ? `<button class="mini ghost" data-act="restore" data-id="${r.id}">復元</button>` : ""}</div></div>`,
      )
      .join("")}</div>`;
  $("tab-booth").innerHTML = h;
}

function calledCard(r, op) {
  return `<div class="rcard"><div class="rnum">${L(r)}</div><div class="rmeta"><span class="badge danger">呼び出し中</span>${noteHtml(r)}</div>${
    op ? `<div class="ract"><button class="big" data-act="start" data-id="${r.id}">開始</button><button class="mini warn" data-act="absent" data-id="${r.id}">不在</button></div>` : ""
  }</div>`;
}
function noteHtml(r) {
  return (r.people ? `<br><span class="small">👥${r.people}人</span>` : "") + (r.note ? `<br><span class="small">📝${esc(r.note)}</span>` : "");
}
function selBtns(act, list, word) {
  const sel = list.filter((r) => S.selected.has(r.id));
  return `<div class="row"><button class="mini sub" data-act="${act}Sel" ${sel.length ? "" : "disabled"}>選択した${sel.length}組を${word}</button><button class="mini" data-act="${act}All" data-ids="${list.map((r) => r.id).join(",")}">全${list.length}組を${word}</button></div>`;
}
function queueRow(r, ord, q, b) {
  const adm = canIssue(b.id);
  const idx = q.waiting.findIndex((x) => x.id === r.id);
  const prev = q.waiting[idx - 1];
  return `<div class="qrow"><div class="ord">${ord}</div><div class="qn">${L(r)}</div><div class="qm">受付 ${fmtClock(r.createdAt)}${noteHtml(r)}</div><div class="qa">${
    adm && prev ? `<button class="mini ghost" data-act="swap" data-id="${r.id}" data-other="${prev.id}" title="1つ前と入れ替え">▲</button>` : ""
  }${adm ? `<button class="mini ghost" data-act="more" data-id="${r.id}">操作</button>` : ""}${!adm && canOp(b.id) ? `<button class="mini warn" data-act="absent" data-id="${r.id}">不在</button>` : ""}</div></div>`;
}

// ---------- 受付 ----------
function renderReception() {
  const el = $("tab-reception");
  if (!el.dataset.built) {
    el.dataset.built = "1";
    el.innerHTML = `
      <div class="card">
        <h2>予約を追加</h2>
        <p class="small muted" style="margin:0">1組が同時に予約できるのは1ブースまでです。ほかのブースでまだ待っている組でないか、受付で確認してください。</p>
        <label>人数（必ず選んでください）</label>
        <div class="chips" id="peopleBtns"></div>
        <label for="issueNote">メモ（任意。個人名は入れないでください）</label>
        <input id="issueNote" maxlength="100" autocomplete="off">
      </div>
      <div class="issue-grid" id="issueBtns"></div>
      <div id="issuedArea" style="margin-top:12px"></div>
      <div class="card">
        <h2>番号で探す</h2>
        <form id="findForm" class="row"><input id="findNum" class="grow" style="width:auto" placeholder="例：A12" autocomplete="off"><button>探す</button></form>
        <div id="findResult"></div>
      </div>
      <div class="card"><button class="sub" data-act="tab" data-tab="print">印刷・保存（紙での運営に切り替える場合）</button></div>`;
    $("findForm").onsubmit = (e) => {
      e.preventDefault();
      S.findQuery = $("findNum").value;
      renderFind();
    };
  }
  const pp = S.people;
  $("peopleBtns").innerHTML =
    [1, 2, 3, 4, 5, 6].map((n) => `<button data-act="people" data-n="${n}" aria-pressed="${pp === n}">${n}人</button>`).join("") +
    `<button data-act="peopleMore" aria-pressed="${!!pp && pp > 6}">${pp && pp > 6 ? `${pp}人` : "7人以上"}</button>`;
  $("issueBtns").classList.toggle("many", enabledBooths().filter((b) => canIssue(b.id)).length > 3);
  $("issueBtns").innerHTML = enabledBooths()
    .filter((b) => canIssue(b.id))
    .map((b) => {
      const q = boothQ(b);
      const fee = !b.price ? "" : `<small>1人 ${yen(b.price)}${pp ? `｜${pp}人で ${yen(pp * b.price)}` : ""}</small>`;
      return `<button class="bg${b.id}" data-act="issue" data-b="${b.id}">ブース${esc(b.id)}に追加${fee}<small>${b.paused ? "⏸一時停止中｜" : ""}待ち ${q.waiting.length}組・目安 ${newcomerWait(b, q)}</small></button>`;
    })
    .join("");
  const [last] = S.issued;
  let h = "";
  if (last) {
    const r = S.st.res.get(last.id);
    h += `<div class="issued"><div class="small muted">${fmtClock(last.at)} 発行${last.replaced ? `（${esc(last.replaced)} を取り消して取り直し）` : ""}</div>
      <div class="n fg${last.booth}">${esc(last.label)}</div><div>確認コード</div><div class="c">${esc(last.code)}</div>
      ${(r ?? last).people && (r ?? last).price ? `<div class="fee">${(r ?? last).people}人 × ${yen((r ?? last).price ?? 0)} ＝ <b>${yen((r ?? last).people * ((r ?? last).price ?? 0))}</b> お預かり</div>` : ""}
      <div class="say">「${esc(last.label)}、コードは ${esc(last.code.split("").join(" "))} です」</div>
      ${r ? `<div class="small" style="margin-top:6px">現在：${STATUS_JA[r.status]}</div>` : ""}
      ${(last.warnings ?? []).map((w) => `<div class="banner warn small" style="margin-top:8px">${esc(w)}</div>`).join("")}</div>`;
  }
  // 最近発行した番号：どの受付端末で発行したものも共通に表示（発行者・現在の状態つき）
  const recent = today()
    .filter((r) => canIssue(r.booth))
    .sort((x, y) => y.createdAt - x.createdAt || y.id - x.id)
    .slice(0, 10);
  if (recent.length)
    h += `<div class="card"><h3>最近発行した番号（全受付共通）</h3>${recent
      .map(
        (r) =>
          `<div class="qrow"><div class="qn fg${r.booth}">${L(r)}</div><div class="qm">コード <b style="font-size:1.1rem">${esc(r.code ?? "")}</b>｜${r.people ? `${r.people}人` : "人数未入力"}｜${fmtClock(r.createdAt)}・${esc(r.by)}<br>${STATUS_JA[r.status]}${noteHtml(r)}</div></div>`,
      )
      .join("")}</div>`;
  $("issuedArea").innerHTML = h;
  renderFind();
}

function renderFind() {
  const box = $("findResult");
  if (!box) return;
  if (!S.findQuery) return (box.innerHTML = "");
  const s = S.findQuery.normalize("NFKC").toUpperCase().replace(/\s/g, "");
  const r = today().find((x) => L(x) === s);
  if (!r) {
    // この端末に無い古い予約はサーバーに問い合わせる
    if (S.findAsked !== s) {
      S.findAsked = s;
      box.innerHTML = `<p class="muted">検索中…</p>`;
      cmd("find", { number: s }).then((x) => {
        if (x?.res) S.st.res.set(x.res.id, x.res);
        else if (x) box.innerHTML = `<p class="muted">本日の予約に ${esc(s)} は見つかりません。</p>`;
        if (x?.res) renderFind();
      });
    }
    return;
  }
  S.findAsked = null;
  const b = S.st.booths.find((x) => x.id === r.booth);
  const q = boothQ(b);
  const idx = q.waiting.findIndex((x) => x.id === r.id);
  box.innerHTML = `<div class="rcard"><div class="rnum">${L(r)}</div><div class="rmeta">${STATUS_JA[r.status]}${idx >= 0 ? `（待ち ${idx + 1}番目）` : ""}<br>受付 ${fmtClock(r.createdAt)}${r.code ? `｜確認コード <b style="font-size:1.2rem">${esc(r.code)}</b>` : ""}${noteHtml(r)}</div><div class="ract">${
    isAdmin() || canIssue(r.booth) ? `<button class="mini ghost" data-act="more" data-id="${r.id}">操作</button>` : ""
  }</div></div>`;
}

// ---------- お知らせ ----------
function renderNotice() {
  const el = $("tab-notice");
  if (!el.dataset.built) {
    el.dataset.built = "1";
    el.innerHTML = `
      <div class="card">
        <h2>参加者へのお知らせ</h2>
        <p class="small muted">参加者の画面に表示されます（一方通行）。「次の回」「呼び出し中の回」宛ては、送信した時点の組だけに表示され、後から来た組には表示されません。</p>
        <label for="nScope">対象</label>
        <select id="nScope"></select>
        <div id="nBoothWrap"><label for="nBooth">ブース</label><select id="nBooth"></select></div>
        <div id="nNumWrap" class="hidden"><label for="nNum">受付番号</label><input id="nNum" placeholder="例：A12"></div>
        <label>定型文（押すと下に入ります）</label>
        <div id="nTpl" class="row"></div>
        <label for="nText">内容</label>
        <textarea id="nText" rows="3" maxlength="500"></textarea>
        <label for="nExp">表示する時間</label>
        <select id="nExp"><option value="">表示終了を押すまで</option><option value="15">15分</option><option value="30">30分</option><option value="60">60分</option><option value="120">120分</option></select>
        <div style="margin-top:12px"><button class="huge" data-act="sendNotice">送信する</button></div>
      </div>
      <div id="noticeList"></div>`;
    $("nScope").onchange = () => {
      $("nBoothWrap").classList.toggle("hidden", ["all", "res"].includes($("nScope").value));
      $("nNumWrap").classList.toggle("hidden", $("nScope").value !== "res");
    };
  }
  const scopes = [...(canAllNotice() ? [["all", "全体（全参加者）"]] : []), ["booth", "ブース全体（待ち・参加中の組）"], ["calling", "呼び出し中の回の組"], ["next", "次の回の組"], ["res", "特定の組（番号指定）"]];
  const curS = $("nScope").value;
  $("nScope").innerHTML = scopes.map(([k, v]) => `<option value="${k}" ${k === curS ? "selected" : ""}>${v}</option>`).join("");
  $("nScope").onchange();
  const curB = $("nBooth").value || S.booth;
  $("nBooth").innerHTML = enabledBooths()
    .filter((b) => canNotice(b.id))
    .map((b) => `<option value="${b.id}" ${b.id === curB ? "selected" : ""}>ブース${esc(b.id)}${b.name !== b.id ? "｜" + esc(b.name) : ""}</option>`)
    .join("");
  $("nTpl").innerHTML = (S.st.templates ?? []).map((t, i) => `<button class="mini ghost" data-act="tpl" data-i="${i}">${esc(t.replaceAll("{booth}", "◯").slice(0, 18))}…</button>`).join("");
  const active = S.st.notices.filter((n) => !n.endedAt && (!n.expiresAt || n.expiresAt > nowMs()));
  const ended = S.st.notices.filter((n) => !active.includes(n)).slice(-10).reverse();
  const row = (n, act) =>
    `<div class="req"><div class="small muted">${fmtClock(n.at)}｜${esc(n.by)}｜${SCOPE_JA[n.scope]}${n.booth ? " " + n.booth : ""}${n.targets ? `（${n.targets.map(esc).join("、")}）` : ""}${n.expiresAt && act ? `｜${fmtClock(n.expiresAt)}まで` : ""}</div><div style="font-weight:700">${esc(n.text)}</div>${
      act && canNotice(n.booth) ? `<button class="mini danger sub" data-act="noticeEnd" data-id="${n.id}" style="margin-top:6px">表示を終了する</button>` : ""
    }</div>`;
  $("noticeList").innerHTML = `<h2>表示中のお知らせ（${active.length}）</h2>${active.length ? active.map((n) => row(n, true)).join("") : `<p class="empty">ありません。</p>`}${
    ended.length ? `<h3>終了したお知らせ</h3>${ended.map((n) => row(n, false)).join("")}` : ""
  }`;
}

// ---------- 連絡（チャット・対応依頼） ----------
function renderComms() {
  const el = $("tab-comms");
  if (!el.dataset.built) {
    el.dataset.built = "1";
    el.innerHTML = `
      <div class="chips" id="commsChips"></div>
      <div id="chatPane">
        <div class="chips" id="chChips"></div>
        <div class="chat-list" id="chatList"></div>
        <form id="chatForm" class="row"><textarea id="chatText" rows="2" class="grow" style="width:auto" maxlength="500" placeholder="スタッフ間の連絡（参加者には表示されません）"></textarea><button>送信</button></form>
        <p class="small muted">チャットは連絡用です。ここに書いた内容が自動で予約操作になることはありません。</p>
      </div>
      <div id="reqPane" class="hidden">
        <div class="card">
          <h2>対応依頼を出す</h2>
          <p class="small muted">受付を離れられない時など。サポート担当が直接「引き受ける」を押して対応します。</p>
          <label for="reqBooth">場所</label><select id="reqBooth"></select>
          <label for="reqText">内容</label><textarea id="reqText" rows="2" maxlength="500"></textarea>
          <div style="margin-top:10px"><button class="big" data-act="reqCreate">依頼する</button></div>
        </div>
        <div id="reqList"></div>
      </div>`;
    $("chatForm").onsubmit = async (e) => {
      e.preventDefault();
      const text = $("chatText").value.trim();
      if (!text) return;
      const r = await cmd("chat", { ch: S.chatCh, text }, e.submitter);
      if (r) $("chatText").value = "";
    };
  }
  const open = S.st.reqs.filter((q) => q.status === "open").length;
  const unreadAll = chans().reduce((n, c) => n + unreadCount(c), 0);
  $("commsChips").innerHTML = `<button data-act="commsView" data-v="chat" aria-pressed="${S.commsView === "chat"}">チャット${unreadAll ? `<span class="cnt">${unreadAll}</span>` : ""}</button><button data-act="commsView" data-v="req" aria-pressed="${S.commsView === "req"}">対応依頼${open ? `<span class="cnt">${open}</span>` : ""}</button>`;
  $("chatPane").classList.toggle("hidden", S.commsView !== "chat");
  $("reqPane").classList.toggle("hidden", S.commsView !== "req");
  if (S.commsView === "chat") {
    if (!chans().includes(S.chatCh)) S.chatCh = "all";
    $("chChips").innerHTML = chans()
      .map((c) => {
        const u = c === S.chatCh ? 0 : unreadCount(c);
        return `<button data-act="ch" data-ch="${c}" aria-pressed="${c === S.chatCh}">${c === "all" ? "全体" : "ブース" + c}${u ? `<span class="cnt">${u}</span>` : ""}</button>`;
      })
      .join("");
    const list = S.st.chat.filter((c) => c.ch === S.chatCh).sort((a, b) => a.id - b.id);
    const box = $("chatList");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = list.length
      ? list
          .map(
            (c) =>
              `<div class="msg ${c.name === me().name ? "mine" : ""}"><div class="who">${esc(c.name)}（${ROLE_JA[c.role] ?? ""}）${fmtClock(c.at)}</div><div class="body">${esc(c.text)}</div></div>`,
          )
          .join("")
      : `<p class="empty">まだメッセージはありません。</p>`;
    if (atBottom || !box.dataset.ch || box.dataset.ch !== S.chatCh) box.scrollTop = box.scrollHeight;
    box.dataset.ch = S.chatCh;
    // 表示したチャンネルは既読にする
    const maxId = Math.max(0, ...list.map((c) => c.id));
    if (document.visibilityState === "visible" && maxId) lsSet(`nazo.read.${S.st.epoch}.${me().id}.${S.chatCh}`, maxId);
  } else {
    const curB = $("reqBooth").value;
    $("reqBooth").innerHTML = `<option value="">全体・その他</option>` + enabledBooths().map((b) => `<option value="${b.id}" ${b.id === curB ? "selected" : ""}>ブース${esc(b.id)}</option>`).join("");
    const groups = [
      ["open", "未対応"],
      ["doing", "対応中"],
      ["done", "対応完了"],
    ];
    let h = "";
    for (const [st, title] of groups) {
      const list = S.st.reqs.filter((q) => q.status === st).sort((a, b) => b.id - a.id).slice(0, st === "done" ? 15 : 100);
      h += `<h2>${title}（${S.st.reqs.filter((q) => q.status === st).length}）</h2>`;
      if (!list.length) h += `<p class="empty">ありません。</p>`;
      for (const q of list)
        h += `<div class="req ${st}"><div class="small muted">${fmtClock(q.createdAt)}｜${esc(q.by)}｜${q.booth ? "ブース" + q.booth : "全体"}${q.assignee ? `｜担当：<b>${esc(q.assignee)}</b>` : ""}</div><div style="font-weight:700">${esc(q.text)}</div><div class="row" style="margin-top:6px">${
          st === "open" ? `<button class="mini" data-act="reqTake" data-id="${q.id}">引き受ける</button>` : ""
        }${st === "doing" ? `<button class="mini ok" data-act="reqDone" data-id="${q.id}">対応完了</button>${q.assignee !== me().name ? `<button class="mini ghost" data-act="reqTake" data-id="${q.id}">引き継ぐ</button>` : ""}` : ""}${
          st !== "open" ? `<button class="mini ghost" data-act="reqReopen" data-id="${q.id}">未対応に戻す</button>` : ""
        }</div></div>`;
    }
    $("reqList").innerHTML = h;
  }
}

// ---------- 集計（人数・金額） ----------
// 取消した予約は集計から除く（返金した扱い）。金額 = 人数 × 発行時点の1人あたり料金
function calcStats(data) {
  const booths = S.st.booths.filter((b) => b.enabled || data.rows.some((r) => r.booth === b.id));
  const days = data.days.filter((d) => data.rows.some((r) => r.day === d.id));
  const valid = data.rows.filter((r) => r.status !== "cancelled");
  const sum = (list) => ({
    groups: list.length,
    people: list.reduce((n, r) => n + (r.people ?? 0), 0),
    amount: list.reduce((n, r) => n + (r.people ?? 0) * (r.price ?? 0), 0),
    missing: list.filter((r) => r.people == null).length,
  });
  return {
    booths,
    days,
    byBooth: booths.map((b) => ({ booth: b, ...sum(valid.filter((r) => r.booth === b.id)) })),
    byDay: days.map((d) => ({ day: d, total: sum(valid.filter((r) => r.day === d.id)), cells: booths.map((b) => sum(valid.filter((r) => r.day === d.id && r.booth === b.id))) })),
    total: sum(valid),
    cancelled: data.rows.length - valid.length,
  };
}

// 棒グラフ（1系列・ブースの色で識別。値はバーの上に表示、マウスを乗せると詳細）
function barChartSvg(title, items, fmt) {
  // 見出し（上端）と、棒の上に出す数字が重ならないよう、上に余白を取り、目盛りの最大値にも余裕を持たせる
  const W = 360, H = 250, top = 62, bottom = 40, left = 12, right = 12;
  const max = Math.max(1, ...items.map((i) => i.value));
  const step = niceStep(max * 1.15);
  const yMax = Math.ceil((max * 1.15) / step) * step;
  const plotH = H - top - bottom;
  const slot = (W - left - right) / items.length;
  const bw = Math.min(64, slot * 0.5);
  const fs = items.length > 6 ? 11 : items.length > 4 ? 12 : 14; // ブースが多い時は文字を小さくして重ならないようにする
  const y = (v) => top + plotH - (v / yMax) * plotH;
  let g = "";
  for (let v = 0; v <= yMax; v += step) g += `<line x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}" stroke="#e3e6ea" stroke-width="1"/>`;
  const bars = items
    .map((it, i) => {
      const cx = left + slot * i + slot / 2;
      const h = Math.max(0, top + plotH - y(it.value));
      const x = cx - bw / 2, yy = top + plotH - h, r = Math.min(4, h);
      const path = h > 0 ? `M${x},${top + plotH} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${top + plotH} Z` : "";
      return `<g class="bar"><title>${esc(it.label)}：${esc(fmt(it.value))}</title><rect x="${cx - slot / 2}" y="${top}" width="${slot}" height="${plotH + bottom}" fill="transparent"/>${path ? `<path d="${path}" fill="${it.color}"/>` : ""}<text x="${cx}" y="${yy - 8}" text-anchor="middle" font-size="${fs}" font-weight="700" fill="#1b1d21">${esc(fmt(it.value))}</text><text x="${cx}" y="${H - 14}" text-anchor="middle" font-size="${fs + 2}" font-weight="700" fill="#5f6672">${esc(it.label)}</text></g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}" style="font-family:system-ui,'Hiragino Sans','Noto Sans JP','Yu Gothic UI',sans-serif;background:#fff"><text x="${left}" y="20" font-size="15" font-weight="800" fill="#1b1d21">${esc(title)}</text>${g}${bars}<line x1="${left}" x2="${W - right}" y1="${top + plotH}" y2="${top + plotH}" stroke="#9aa1ab" stroke-width="1"/></svg>`;
}
function niceStep(max) {
  const raw = max / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}
const BOOTH_COLOR = { A: "#1f5fd1", B: "#0b7d5b", C: "#8a3fbf", D: "#c2410c", E: "#be185d", F: "#0e7490", G: "#a16207", H: "#4d7c0f", I: "#b91c1c", J: "#475569" };

async function loadStats(force = false) {
  if (!force && S.stats && Date.now() - S.statsAt < 20000) return;
  if (S.statsLoading) return;
  S.statsLoading = true;
  try {
    const r = await cmd("stats");
    if (r) {
      S.stats = r;
      S.statsAt = Date.now();
    }
  } finally {
    S.statsLoading = false;
  }
  render();
}

function renderStats() {
  const el = $("tab-stats");
  if (!S.stats) {
    el.innerHTML = `<div class="card">読み込み中…</div>`;
    loadStats();
    return;
  }
  if (Date.now() - S.statsAt > 20000) loadStats();
  const st = calcStats(S.stats);
  const short = st.byBooth.length > 4; // ブースが多い時はグラフの下の名前を「A」「B」…だけにする
  const people = st.byBooth.map((x) => ({ label: short ? x.booth.id : `ブース${x.booth.id}`, value: x.people, color: BOOTH_COLOR[x.booth.id] ?? "#5f6672" }));
  const amount = st.byBooth.map((x) => ({ label: short ? x.booth.id : `ブース${x.booth.id}`, value: x.amount, color: BOOTH_COLOR[x.booth.id] ?? "#5f6672" }));
  const cell = (c) => `<td>${c.groups}組<br>${c.people}人<br><b>${yen(c.amount)}</b></td>`;
  let h = `<div class="row noprint" style="justify-content:space-between;margin-bottom:10px"><h2 style="margin:0">人数・金額の集計</h2><div class="row"><button class="mini sub" data-act="statsReload">最新にする</button><button class="mini" data-act="statsExcel">Excelで保存</button></div></div>`;
  h += `<p class="small muted">${fmtClock(S.statsAt, true)} 時点。全営業日の合計です。取消した予約（${st.cancelled}件）は含みません。金額は「人数 × 発行時点の1人あたり料金」です。</p>`;
  if (st.total.missing) h += `<div class="banner warn">人数が未入力の予約が ${st.total.missing} 組あります（人数・金額に含まれていません）。「受付」の「番号で探す」→「操作」→「人数を修正」で入力できます。</div>`;
  h += `<div class="stat-tiles"><div class="tile"><div class="tl">合計金額</div><div class="tv">${yen(st.total.amount)}</div></div><div class="tile"><div class="tl">合計人数</div><div class="tv">${st.total.people.toLocaleString()}人</div></div><div class="tile"><div class="tl">組数</div><div class="tv">${st.total.groups.toLocaleString()}組</div></div></div>`;
  h += `<div class="charts"><div class="card chart" id="chartPeople">${barChartSvg("ブース別の人数", people, (v) => `${v.toLocaleString()}人`)}</div><div class="card chart" id="chartAmount">${barChartSvg("ブース別の金額", amount, (v) => yen(v))}</div></div>`;
  h += `<div class="card"><h3>ブース × 営業日</h3><div style="overflow-x:auto"><table class="list stats-table"><tr><th></th>${st.days.map((d) => `<th>${esc(d.label)}</th>`).join("")}<th>合計</th></tr>${st.booths
    .map((b, i) => `<tr><th>ブース${esc(b.id)}<br><span class="small muted">1人 ${yen(b.price ?? 0)}</span></th>${st.byDay.map((d) => cell(d.cells[i])).join("")}${cell(st.byBooth[i])}</tr>`)
    .join("")}<tr class="sum"><th>全ブース</th>${st.byDay.map((d) => cell(d.total)).join("")}${cell(st.total)}</tr></table></div></div>`;
  el.innerHTML = h;
}

function cancelledNote(list) {
  const n = list.filter((r) => r.status === "cancelled").length;
  return n ? `取消 ${n} 組を除く` : "";
}

function loadScript(src) {
  return new Promise((ok, ng) => {
    if (document.querySelector(`script[src="${src}"]`) && window.ExcelJS) return ok();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => ok();
    s.onerror = () => ng(new Error("load"));
    document.head.appendChild(s);
  });
}
function svgToPng(svg) {
  return new Promise((ok, ng) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width * 2;
      c.height = img.height * 2;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ok(c.toDataURL("image/png"));
    };
    img.onerror = () => ng(new Error("svg"));
    img.src = url;
  });
}

async function exportStatsExcel(btn) {
  btn?.classList.add("busy");
  try {
    await loadStats(true);
    if (!S.stats) return;
    await loadScript("/vendor/exceljs.min.js");
    const st = calcStats(S.stats);
    const wb = new window.ExcelJS.Workbook();
    wb.created = new Date();
    const yenFmt = '#,##0"円"';
    // シート1：集計
    const ws = wb.addWorksheet("集計");
    ws.columns = [{ width: 16 }, { width: 14 }, { width: 10 }, { width: 10 }, { width: 14 }];
    ws.addRow([`${S.st.eventName} 人数・金額の集計`]).font = { bold: true, size: 14 };
    ws.addRow([`出力：${new Date().toLocaleString("ja-JP")}（取消した予約は含みません）`]);
    ws.addRow([]);
    const head1 = ws.addRow(["ブース", "1人あたり料金", "組数", "人数", "金額"]);
    head1.font = { bold: true };
    for (const x of st.byBooth) {
      const row = ws.addRow([`ブース${x.booth.id}`, x.booth.price ?? 0, x.groups, x.people, x.amount]);
      row.getCell(2).numFmt = yenFmt;
      row.getCell(5).numFmt = yenFmt;
    }
    const tot = ws.addRow(["全ブース合計", "", st.total.groups, st.total.people, st.total.amount]);
    tot.font = { bold: true };
    tot.getCell(5).numFmt = yenFmt;
    if (st.total.missing) ws.addRow([`※人数未入力の予約 ${st.total.missing} 組は人数・金額に含まれていません`]);
    ws.addRow([]);
    const head2 = ws.addRow(["営業日", "ブース", "組数", "人数", "金額"]);
    head2.font = { bold: true };
    for (const d of st.byDay) {
      st.booths.forEach((b, i) => {
        const c = d.cells[i];
        ws.addRow([d.day.label, `ブース${b.id}`, c.groups, c.people, c.amount]).getCell(5).numFmt = yenFmt;
      });
      const r = ws.addRow([d.day.label, "合計", d.total.groups, d.total.people, d.total.amount]);
      r.font = { bold: true };
      r.getCell(5).numFmt = yenFmt;
    }
    // グラフ（画像）
    const people = st.byBooth.map((x) => ({ label: st.byBooth.length > 4 ? x.booth.id : `ブース${x.booth.id}`, value: x.people, color: BOOTH_COLOR[x.booth.id] ?? "#5f6672" }));
    const amount = st.byBooth.map((x) => ({ label: st.byBooth.length > 4 ? x.booth.id : `ブース${x.booth.id}`, value: x.amount, color: BOOTH_COLOR[x.booth.id] ?? "#5f6672" }));
    const img1 = wb.addImage({ base64: await svgToPng(barChartSvg("ブース別の人数", people, (v) => `${v.toLocaleString()}人`)), extension: "png" });
    const img2 = wb.addImage({ base64: await svgToPng(barChartSvg("ブース別の金額", amount, (v) => yen(v))), extension: "png" });
    ws.addImage(img1, { tl: { col: 6, row: 1 }, ext: { width: 360, height: 250 } });
    ws.addImage(img2, { tl: { col: 6, row: 16 }, ext: { width: 360, height: 250 } });
    // ブース別シート：そのブースの組ごとの一覧と合計（取消は金額0円で表示し、合計には含めない）
    const STATUS_B = { waiting: "順番待ち", called: "呼び出し中", playing: "参加中", done: "終了", absent: "不在", cancelled: "取消（集計に含まない）" };
    st.booths.forEach((b, i) => {
      const wsb = wb.addWorksheet(`ブース${b.id}`);
      wsb.columns = [{ width: 10 }, { width: 10 }, { width: 8 }, { width: 14 }, { width: 12 }, { width: 22 }, { width: 20 }, { width: 12 }];
      wsb.addRow([`ブース${b.id}${b.name !== b.id ? `（${b.name}）` : ""}の組ごとの一覧`]).font = { bold: true, size: 14 };
      wsb.addRow([`現在の1人あたり料金：${(b.price ?? 0).toLocaleString("ja-JP")}円（金額は発行時点の料金で計算）`]);
      wsb.addRow([]);
      const hd = wsb.addRow(["営業日", "受付番号", "人数", "1人あたり料金", "金額", "状態", "受付時刻", "発行者"]);
      hd.font = { bold: true };
      const list = S.stats.rows.filter((r) => r.booth === b.id).sort((x, y) => x.day - y.day || x.num - y.num);
      for (const r of list) {
        const day = S.stats.days.find((d) => d.id === r.day)?.label ?? `${r.day}日目`;
        const cancelled = r.status === "cancelled";
        const amt = cancelled || r.people == null ? 0 : r.people * (r.price ?? 0);
        const row = wsb.addRow([day, `${r.booth}${r.num}`, r.people ?? "未入力", r.price ?? "", amt, STATUS_B[r.status] ?? r.status, new Date(r.createdAt).toLocaleString("ja-JP"), r.by]);
        row.getCell(4).numFmt = yenFmt;
        row.getCell(5).numFmt = yenFmt;
        if (cancelled) row.font = { color: { argb: "FF888888" } };
      }
      const t = st.byBooth[i];
      const tr = wsb.addRow(["合計", `${t.groups}組`, t.people, "", t.amount, cancelledNote(list)]);
      tr.font = { bold: true };
      tr.getCell(5).numFmt = yenFmt;
      if (t.missing) wsb.addRow([`※人数未入力の組 ${t.missing} 組は合計に含まれていません`]);
    });
    // シート：予約一覧（全ブース）
    const ws2 = wb.addWorksheet("予約一覧");
    ws2.columns = [{ header: "営業日", width: 10 }, { header: "ブース", width: 8 }, { header: "受付番号", width: 10 }, { header: "状態", width: 10 }, { header: "人数", width: 8 }, { header: "1人あたり料金", width: 14 }, { header: "金額", width: 12 }, { header: "受付時刻", width: 18 }, { header: "発行者", width: 12 }];
    ws2.getRow(1).font = { bold: true };
    const STATUS = { waiting: "順番待ち", called: "呼び出し中", playing: "参加中", done: "終了", absent: "不在", cancelled: "取消" };
    for (const r of S.stats.rows) {
      const day = S.stats.days.find((d) => d.id === r.day)?.label ?? `${r.day}日目`;
      const amt = r.status === "cancelled" || r.people == null ? 0 : r.people * (r.price ?? 0);
      const row = ws2.addRow([day, r.booth, `${r.booth}${r.num}`, STATUS[r.status] ?? r.status, r.people ?? "", r.price ?? "", amt, new Date(r.createdAt).toLocaleString("ja-JP"), r.by]);
      row.getCell(6).numFmt = yenFmt;
      row.getCell(7).numFmt = yenFmt;
    }
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const d = new Date();
    a.download = `集計_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("Excelファイルを保存しました", "ok");
  } catch (e) {
    console.error(e);
    toast("Excelファイルを作成できませんでした（通信状態を確認して、もう一度お試しください）", "error", 7000);
  } finally {
    btn?.classList.remove("busy");
  }
}

// ---------- 管理 ----------
function renderAdmin() {
  const st = S.st;
  const day = st.days.find((d) => d.id === st.activeDay);
  let h = "";
  if (st.warnings?.length) h += st.warnings.map((w) => `<div class="banner warn">⚠ ${esc(w)}</div>`).join("");
  h += `<div class="card"><h2>使い方・イベント</h2>
    <p><a class="btnlink" href="/staff/help.html" target="_blank" rel="noopener" id="helpLink">📖 使い方（説明書）を開く</a></p>
    <p class="small muted">はじめて使う時の準備、当日の流れ、困った時の対処をまとめています。</p>
    <div class="qrow"><div class="grow">イベント名：<b>${esc(st.eventName)}</b><br><span class="small muted">参加者の画面とスタッフ画面の上部に表示されます</span></div><div class="qa"><button class="mini ghost" data-act="eventEdit">変更</button></div></div>
    <div class="qrow"><div class="grow">参加者用QRコード<br><span class="small muted">掲示するQRコードです。「新しくする」と、古いQRコードからは番号を入力できなくなります（表示中の参加者はそのまま見られます）。営業日ごとなど、必要に応じて新しくしてください。</span></div><div class="qa"><a class="mini btnlink" href="${esc(qrPageUrl())}" target="_blank" rel="noopener" id="qrLink">表示・印刷</a><button class="mini warn" data-act="viewerKeyRotate">新しくする</button></div></div>
    <div class="qrow"><div class="grow">スタッフ用の招待QRコード<br><span class="small muted">スタッフに見せると、スタッフ用アプリ（またはスマホのカメラ）で読み取ってログイン画面を開けます。<b>掲示はしないでください</b>。役割名とパスワードは別に伝えてください。</span></div><div class="qa"><a class="mini btnlink" href="${esc(staffQrPageUrl())}" target="_blank" rel="noopener" id="staffQrLink">表示</a></div></div></div>`;
  const sp = st.sponsors ?? { enabled: false, items: [] };
  h += `<div class="card"><h2>協賛・お知らせ枠（参加者の画面）</h2>
    <p class="small muted">協賛してくれたお店や、次のイベントの宣伝などを、参加者の画面の一番下に「協賛・お知らせ」として表示します（最大5件。複数ある時は8秒ごとに切り替わります）。スタッフの画面には表示されません。</p>
    <div class="row" style="margin-bottom:6px"><b>${sp.enabled ? "表示中" : "表示していません"}</b><button class="mini ${sp.enabled ? "warn" : "ok"}" data-act="sponsorEnable" data-on="${sp.enabled ? 0 : 1}">${sp.enabled ? "表示をやめる" : "参加者の画面に表示する"}</button></div>
    ${sp.items
      .map(
        (x, i) =>
          `<div class="qrow"><div class="qm" style="color:var(--text)">${x.hasImg ? "🖼 画像あり" : "文章のみ"}${x.text ? "｜" + esc(x.text) : ""}${x.url ? `<br><span class="small muted">リンク：${esc(x.url)}</span>` : ""}</div><div class="qa">${i > 0 ? `<button class="mini ghost" data-act="sponsorMove" data-id="${x.id}" data-dir="-1">▲</button>` : ""}<button class="mini ghost" data-act="sponsorEdit" data-id="${x.id}">変更</button><button class="mini ghost" data-act="sponsorDelete" data-id="${x.id}">削除</button></div></div>`,
      )
      .join("")}
    <div class="row" style="margin-top:8px">${sp.items.length < 5 ? `<button class="mini sub" data-act="sponsorEdit">＋ 追加</button>` : `<span class="small muted">5件まで登録できます</span>`}<a class="small" href="${esc(participantUrl())}" target="_blank" rel="noopener">参加者の画面で確認する</a></div></div>`;
  const nCustom = Object.keys(st.viewTexts ?? {}).length;
  h += `<div class="card"><h2>参加者の画面の文章</h2>
    <p class="small muted">「順番待ち」「次の回」「呼び出し中」などの時に、参加者の画面に大きく出る文章です。お店やイベントに合わせて書き換えられます。</p>
    <div class="row"><button class="mini ghost" data-act="viewTextsEdit">文章を変更</button><span class="small muted">${nCustom ? `${nCustom}項目を書き換え中` : "すべて初期の文章"}</span></div></div>`;
  h += `<div class="card"><h2>営業日</h2>
    <p>現在の営業日：<b style="font-size:1.3rem">${esc(day?.label)}</b></p>
    ${st.days
      .map(
        (d) =>
          `<div class="qrow" style="flex-wrap:wrap"><div class="grow"><b>${esc(d.label)}</b>${d.id === st.activeDay ? " <span class='badge ok'>営業中</span>" : ""}<br><span class="small">開始番号：${enabledBooths()
            .map((b) => `${b.id}${d.starts[b.id]}`)
            .join("・")}${d.id === st.activeDay ? `<br>次に発行：${enabledBooths().map((b) => `${b.id}${st.counters[`${d.id}:${b.id}`] ?? ""}`).join("・")}` : ""}</span></div><div class="qa"><button class="mini ghost" data-act="dayEdit" data-d="${d.id}">設定</button>${
            d.id !== st.activeDay ? `<button class="mini ghost" data-act="dayHistory" data-d="${d.id}">予約一覧</button><button class="mini" data-act="daySwitch" data-d="${d.id}">この日に切替</button>` : ""
          }</div></div>`,
      )
      .join("")}
    <div class="row" style="margin-top:8px"><button class="mini sub" data-act="dayAdd">営業日を追加</button><button class="mini ghost" data-act="counterBump">次の番号を進める（紙で発行した番号の後から続ける）</button></div>
    <p class="small muted">営業日は自動では切り替わりません。2日目の朝に「この日に切替」を押してください。前日の予約・履歴は消えず、当日の待ち列とは分けて表示されます。</p></div>`;

  const unused = st.booths.filter((b) => !b.enabled);
  h += `<div class="card"><h2>ブース設定</h2>${st.booths
    .filter((b) => b.enabled)
    .map(
      (b) =>
        `<div class="qrow"><div class="qn fg${b.id}">${b.id}</div><div class="qm">${b.name !== b.id ? esc(b.name) + "｜" : ""}${b.paused ? "一時停止中" : "使用中"}<br>1回 ${b.capacity}組・${b.durMin}〜${b.durMax}分・${b.price ? `1人 ${yen(b.price)}` : "無料"}<br>集合：${esc(b.gather)}</div><div class="qa"><button class="mini ghost" data-act="boothEdit" data-b="${b.id}">変更</button></div></div>`,
    )
    .join("")}
    <div class="row" style="margin-top:10px">${
      unused.length
        ? `<button class="mini sub" data-act="boothAdd">＋ ブースを追加</button><span class="small muted">（あと ${unused.length} 個まで）</span>`
        : `<span class="small muted">ブースは最大 ${st.booths.length} 個までです。</span>`
    }</div></div>`;

  h += `<div class="card"><h2>スタッフ</h2>${st.staff
    .map(
      (s) =>
        `<div class="qrow"><div class="qm" style="color:var(--text)"><b>${esc(s.name)}</b>${s.active ? "" : " <span class='badge danger'>停止中</span>"}${deviceBadge(s.id)}<br><span class="small muted">${ROLE_JA[s.role]}${s.canIssue && s.role !== "admin" ? "＋受付" : ""}｜${s.role === "admin" ? "全ブース" : s.booths.join("・") || "担当なし"}</span></div><div class="qa"><button class="mini ghost" data-act="staffEdit" data-id="${s.id}">変更</button></div></div>`,
    )
    .join("")}<div style="margin-top:8px"><button class="sub" data-act="staffAdd">スタッフを追加</button></div>
    <p class="small muted">メールアドレスは不要です。停止すると、その人の端末はすぐにログアウトされます。</p></div>`;

  h += `<div class="card"><h2>お知らせの定型文</h2><p class="small muted">{booth} はブース名に置き換わります。</p><button class="sub" data-act="tplEdit">定型文を編集</button></div>`;

  h += `<div class="card"><h2>保存・出力（障害時の手動運営用）</h2><div class="row">
    <button class="sub" data-act="exportCsv">待ち列をCSVで保存（今日）</button>
    <button class="sub" data-act="exportFull">全データを保存（JSON・履歴の保存）</button>
    <button class="sub" data-act="tab" data-tab="print">印刷用の待ち列</button></div>
    <p class="small muted">通信できない時も、「印刷用の待ち列」からこの端末に残っている最新の情報を表示・CSV保存できます。</p></div>`;

  h += `<div class="card"><h2>操作履歴</h2><button class="sub" data-act="audit">最新200件を表示</button><div id="auditBox"></div></div>`;

  const u = st.usage;
  if (u) {
    const m = (v, max, lab) => {
      const p = Math.min(100, (v / max) * 100);
      return `<div style="margin:6px 0"><div class="row" style="justify-content:space-between"><span>${lab}</span><span>${v.toLocaleString()} / ${max.toLocaleString()}（${p.toFixed(1)}%）</span></div><div class="meter ${p > 80 ? "vhi" : p > 50 ? "hi" : ""}"><i style="width:${p}%"></i></div></div>`;
    };
    h += `<div class="card"><h2>本日の使用量（このシステム分の概算）</h2>
      ${m(u.req, 100000, "Workers リクエスト（接続・ログイン等）")}
      ${m(u.req + u.wsIn + (u.alarm ?? 0), 100000, "Durable Objects リクエスト（接続＋操作＋生存通知）")}
      ${m(u.rw, 100000, "データ書き込み行数")}
      ${m(u.rr, 5000000, "データ読み取り行数")}
      <p class="small muted">集計日（UTC）：${esc(u.day)}（日本時間 9:00 に切り替わります）｜現在の接続端末数：${u.sockets}<br>無料枠は Cloudflare アカウント全体で共有です。同じアカウントの他の Worker の使用量は含まれないため、正確な値は Cloudflare のダッシュボードで確認してください。</p></div>`;
  }

  h += `<div class="card danger-zone"><h2 style="color:var(--danger)">全リセット</h2>
    <p>予約・番号・待ち列・回・お知らせ・チャット・対応依頼・履歴など、<b>イベントの運営データをすべて削除</b>し、1日目の受付開始前（各ブースの1番から）に戻します。スタッフ・パスワード・ブース設定・公開URL・QRコードはそのまま使えます。</p>
    <button class="danger" data-act="reset">全リセット</button></div>`;
  $("tab-admin").innerHTML = h;
}

// ---------- 印刷・保存（通信断時も使える） ----------
function renderPrint() {
  const st = S.st;
  let h = `<div class="noprint row" style="margin-bottom:10px"><button data-act="doPrint">印刷する</button><button class="sub" data-act="localCsv">この端末の情報をCSV保存</button><button class="ghost" data-act="tab" data-tab="${tabsFor()[0][0]}">戻る</button></div>`;
  h += `<h2>待ち列（${esc(st.days.find((d) => d.id === st.activeDay)?.label)}・${fmtClock(S.stateAt, true)} 時点の情報）</h2>`;
  if (S.conn?.status !== "online") h += `<div class="banner danger">通信できていません。この内容は ${fmtClock(S.stateAt, true)} 時点のものです。</div>`;
  for (const b of enabledBooths()) {
    const q = boothQ(b);
    const ordered = [...q.playing, ...q.lateCalled, ...q.callingMembers, ...q.waiting, ...q.absent];
    h += `<h3>ブース${esc(b.id)}${b.name !== b.id ? "｜" + esc(b.name) : ""}（次の番号：${b.id}${st.counters[`${st.activeDay}:${b.id}`] ?? "?"}）</h3>
      <table class="list"><tr><th>順</th><th>番号</th><th>状態</th>${isAdmin() || me().canIssue ? "<th>コード</th>" : ""}<th>受付</th><th>開始</th><th>メモ</th><th>済</th></tr>${ordered
        .map(
          (r, i) =>
            `<tr><td>${i + 1}</td><td><b>${L(r)}</b></td><td>${STATUS_JA[r.status]}</td>${isAdmin() || me().canIssue ? `<td>${esc(r.code ?? "")}</td>` : ""}<td>${fmtClock(r.createdAt)}</td><td>${fmtClock(r.startedAt)}</td><td>${esc(r.note)}</td><td>□</td></tr>`,
        )
        .join("")}</table>`;
  }
  $("tab-print").innerHTML = h;
}

// ================= 操作 =================
const acts = {
  tab: (d) => {
    S.tab = d.tab;
    writeHash();
    render();
    window.scrollTo(0, 0);
  },
  booth: (d) => {
    S.booth = d.b;
    S.selected.clear();
    writeHash();
    render();
  },
  account: () => accountModal(),
  start: (d, btn) => cmd("start", { ids: [Number(d.id)] }, btn, { confirmTitle: "開始の確認" }),
  startAll: (d, btn) => cmd("start", { ids: d.ids.split(",").map(Number) }, btn, { confirmTitle: "開始の確認" }),
  end: (d, btn) => cmd("end", { ids: [Number(d.id)] }, btn).then((r) => r && S.selected.delete(Number(d.id))),
  endSel: async (d, btn) => {
    const ids = [...S.selected].filter((id) => S.st.res.get(id)?.status === "playing");
    if (!ids.length) return;
    if (!(await confirmModal("まとめて終了", `${ids.map((id) => L(S.st.res.get(id))).join("、")} を終了します。よろしいですか？`, "終了する"))) return;
    if (await cmd("end", { ids }, btn)) S.selected.clear();
  },
  endAll: async (d, btn) => {
    const ids = d.ids.split(",").map(Number);
    if (!(await confirmModal("まとめて終了", `${ids.map((id) => L(S.st.res.get(id))).join("、")} の${ids.length}組をすべて終了します。よろしいですか？`, "終了する"))) return;
    if (await cmd("end", { ids }, btn)) S.selected.clear();
  },
  call: (d, btn) => cmd("call", { booth: d.b }, btn),
  uncall: async (d, btn) => {
    if (await confirmModal("呼び出しの取り消し", "呼び出し中の組を待ち列（元の順番）に戻します。", "取り消す")) cmd("uncall", { booth: d.b }, btn);
  },
  absent: async (d, btn) => {
    const r = S.st.res.get(Number(d.id));
    if (await confirmModal("不在にする", `${L(r)} を「不在」にします。戻ってきたら「不在」の欄から入れ直せます（取消ではありません）。`, "不在にする")) cmd("absent", { id: r.id }, btn);
  },
  ret: (d, btn) => cmd("returnAbsent", { id: Number(d.id), mode: d.mode }, btn),
  undoStart: async (d, btn) => {
    const r = S.st.res.get(Number(d.id));
    if (await confirmModal("開始の取り消し", `${L(r)} の開始を取り消し、「呼び出し中」に戻します（押し間違えた時用）。`, "取り消す")) cmd("undoStart", { id: r.id }, btn);
  },
  undoEnd: async (d, btn) => {
    const r = S.st.res.get(Number(d.id));
    if (await confirmModal("終了の取り消し", `${L(r)} を「参加中」に戻します。`, "戻す")) cmd("undoEnd", { id: r.id }, btn);
  },
  restore: async (d, btn) => {
    const r = S.st.res.get(Number(d.id));
    if (await confirmModal("復元", `取り消した ${L(r)} を待ち列（元の位置）に戻します。`, "復元する")) cmd("restore", { id: r.id }, btn);
  },
  cancel: async (d, btn) => {
    const r = S.st.res.get(Number(d.id));
    if (await confirmModal("予約の取消", `${L(r)} を取り消します。取り消した番号は再利用されません（必要なら管理者が復元できます）。`, "取り消す", "danger"))
      cmd("cancel", { id: r.id, v: r.v }, btn);
  },
  swap: (d, btn) => {
    const a = S.st.res.get(Number(d.id));
    const b = S.st.res.get(Number(d.other));
    cmd("swap", { id: a.id, other: b.id, v: a.v, ov: b.v }, btn);
  },
  more: (d) => moreModal(S.st.res.get(Number(d.id))),
  pause: async (d, btn) => {
    const b = S.st.booths.find((x) => x.id === d.b);
    if (b.paused) return cmd("pause", { booth: b.id, paused: false }, btn);
    const v = await formModal(`ブース${b.id}を一時停止`, `<p class="small muted">参加者の画面に「一時停止中」と表示され、待ち時間の目安は表示されなくなります。必要に応じて「お知らせ」でも案内してください。</p><label>理由（参加者に表示されます・任意）</label><input name="reason" maxlength="100" placeholder="例：機材の調整中">`, "一時停止する");
    if (v) cmd("pause", { booth: b.id, paused: true, reason: v.reason }, btn);
  },
  people: (d) => {
    S.people = Number(d.n);
    render();
  },
  peopleMore: async () => {
    const v = await formModal("人数（7人以上）", `<label>人数</label><input name="n" inputmode="numeric" value="7">`, "決定");
    if (!v) return;
    const n = Number(String(v.n).normalize("NFKC"));
    if (!Number.isInteger(n) || n < 1 || n > 50) return toast("人数は1〜50で入力してください", "error");
    S.people = n;
    render();
  },
  issue: async (d, btn) => {
    if (!S.people) return toast("先に人数を選んでください", "error", 4000);
    const note = $("issueNote").value.trim();
    const r = await cmd("issue", { booth: d.b, note, people: S.people }, btn);
    if (!r) return;
    const it = { id: r.res.id, label: L(r.res), code: r.res.code, booth: r.res.booth, at: Date.now(), replaced: r.replaced, warnings: r.warnings, people: r.res.people, price: r.res.price };
    S.issued = [it, ...S.issued].slice(0, 10);
    lsSet(K.issued, S.issued);
    $("issueNote").value = "";
    S.people = null;
    if (r.warnings?.length) toast(r.warnings[0], "warn", 8000);
    render();
  },
  sendNotice: async (d, btn) => {
    const scope = $("nScope").value;
    const text = $("nText").value.trim();
    if (!text) return toast("内容を入力してください", "error");
    const a = { scope, text, booth: $("nBooth").value, expiresMin: $("nExp").value ? Number($("nExp").value) : undefined };
    if (scope === "res") {
      const s = $("nNum").value.normalize("NFKC").toUpperCase().replace(/\s/g, "");
      const r = today().find((x) => L(x) === s);
      if (!r) return toast("その番号は本日の予約に見つかりません", "error");
      a.id = r.id;
      a.booth = r.booth;
    }
    const label = scope === "all" ? "全参加者" : scope === "res" ? $("nNum").value : `ブース${a.booth}の${SCOPE_JA[scope]}`;
    if (!(await confirmModal("お知らせの送信", `「${label}」に次の内容を表示します。\n\n${text}`, "送信する"))) return;
    const r = await cmd("notice", a, btn);
    if (r) {
      $("nText").value = "";
      toast(`送信しました${r.count ? `（${r.count}組）` : ""}`, "ok");
    }
  },
  tpl: (d) => {
    const b = S.st.booths.find((x) => x.id === $("nBooth").value);
    $("nText").value = S.st.templates[Number(d.i)].replaceAll("{booth}", b?.name ?? "");
  },
  noticeEnd: (d, btn) => cmd("noticeEnd", { id: Number(d.id) }, btn),
  commsView: (d) => {
    S.commsView = d.v;
    render();
  },
  ch: (d) => {
    S.chatCh = d.ch;
    render();
  },
  reqCreate: async (d, btn) => {
    const text = $("reqText").value.trim();
    if (!text) return toast("内容を入力してください", "error");
    if (await cmd("reqCreate", { booth: $("reqBooth").value || null, text }, btn)) {
      $("reqText").value = "";
      toast("依頼しました", "ok");
    }
  },
  reqTake: (d, btn) => cmd("reqTake", { id: Number(d.id) }, btn, { confirmTitle: "引き継ぎ" }),
  reqDone: (d, btn) => cmd("reqDone", { id: Number(d.id) }, btn),
  reqReopen: (d, btn) => cmd("reqReopen", { id: Number(d.id) }, btn),
  daySwitch: async (d, btn) => {
    const day = S.st.days.find((x) => x.id === Number(d.d));
    if (!(await confirmModal("営業日の切替", `営業日を「${day.label}」に切り替えます。前の営業日の予約・履歴は消えません。番号は ${Object.entries(day.starts).map(([b, n]) => b + n).join("・")} から発行されます（すでに発行済みの場合は続きから）。必要に応じて、切替後に「参加者用QRコード」を新しくしてください。`, "切り替える"))) return;
    if (await cmd("daySwitch", { day: day.id }, btn, { confirmTitle: "待ちの組が残っています" })) toast(`${day.label}に切り替えました`, "ok");
  },
  dayAdd: async (d, btn) => {
    const next = Math.max(...S.st.days.map((x) => x.id)) + 1;
    if (await confirmModal("営業日の追加", `${next}日目を追加します（開始番号は ${(next - 1) * 200 + 1}。後から変更できます）。`, "追加する")) cmd("daySet", { day: next }, btn);
  },
  dayEdit: async (d) => {
    const day = S.st.days.find((x) => x.id === Number(d.d));
    const v = await formModal(
      `${day.label}の設定`,
      `<label>表示名</label><input name="label" value="${esc(day.label)}" maxlength="20">${enabledBooths()
        .map((x) => x.id)
        .map((b) => `<label>ブース${b}の開始番号</label><input name="s${b}" inputmode="numeric" value="${day.starts[b] ?? ""}">`)
        .join("")}<p class="small muted">すでに番号を発行したブースの開始番号は変更できません。</p>`,
      "保存する",
    );
    if (!v) return;
    const r = await cmd("daySet", { day: day.id, label: v.label, starts: Object.fromEntries(enabledBooths().map((x) => [x.id, Number(String(v["s" + x.id]).normalize("NFKC"))])) });
    if (r?.warnings?.length) toast(r.warnings[0], "warn", 8000);
  },
  counterBump: async () => {
    const v = await formModal(
      "次の番号を進める",
      `<p class="small muted">通信障害などで紙で番号を発行した場合に、その続きからシステムの番号を発行するために使います。番号を戻すことはできません。</p><label>ブース</label><select name="booth">${enabledBooths().map((b) => `<option value="${b.id}">ブース${b.id}（現在の次の番号：${b.id}${S.st.counters[`${S.st.activeDay}:${b.id}`]}）</option>`).join("")}</select><label>次に発行する番号（数字）</label><input name="next" inputmode="numeric">`,
      "変更する",
    );
    if (v) cmd("counterBump", { booth: v.booth, next: Number(v.next) });
  },
  dayHistory: async (d) => {
    const r = await cmd("dayHistory", { day: Number(d.d) });
    if (!r) return;
    const day = S.st.days.find((x) => x.id === Number(d.d));
    infoModal(`${day.label}の予約一覧（${r.data.length}件）`, `<table class="list"><tr><th>番号</th><th>状態</th><th>受付</th><th>開始</th><th>終了</th></tr>${r.data.map((x) => `<tr><td>${L(x)}</td><td>${STATUS_JA[x.status]}</td><td>${fmtClock(x.createdAt)}</td><td>${fmtClock(x.startedAt)}</td><td>${fmtClock(x.endedAt)}</td></tr>`).join("")}</table>`);
  },
  viewerKeyRotate: async (d, btn) => {
    const ok = await confirmModal(
      "参加者用QRコードを新しくする",
      "新しいQRコードを発行します。今掲示しているQRコード（古いQRコード）からは、番号を入力できなくなります。すでに状況を表示している参加者は、そのまま見られます。発行後、新しいQRコードを印刷して掲示し直してください。",
      "新しくする",
    );
    if (ok && (await cmd("viewerKeyRotate", {}, btn))) toast("新しいQRコードを発行しました。「表示・印刷」から印刷して、掲示を差し替えてください。", "ok", 7000);
  },
  sponsorEnable: (d, btn) => cmd("sponsorEnable", { enabled: d.on === "1" }, btn),
  sponsorMove: (d, btn) => cmd("sponsorMove", { id: d.id, dir: Number(d.dir) }, btn),
  sponsorDelete: async (d, btn) => {
    if (await confirmModal("協賛・お知らせ枠の削除", "この項目を削除します。", "削除する")) cmd("sponsorDelete", { id: d.id }, btn);
  },
  sponsorEdit: async (d, btn) => {
    const x = (S.st.sponsors?.items ?? []).find((i) => i.id === d.id);
    sponsorFile = null;
    const v = await formModal(
      x ? "協賛・お知らせ枠の変更" : "協賛・お知らせ枠の追加",
      `<label>画像（任意・JPEG/PNG。自動で小さくして保存します）</label><input type="file" name="sponsorImg" accept="image/jpeg,image/png,image/webp">
      ${x?.hasImg ? `<label><input type="checkbox" name="removeImg" style="width:auto;min-height:0"> 今の画像を外す</label>` : ""}
      <label>文章（任意・80文字まで）</label><input name="text" maxlength="80" value="${esc(x?.text ?? "")}" placeholder="例：○○カフェ 本日ドリンク半額">
      <label>リンク先（任意・押した時に開くページ）</label><input name="url" inputmode="url" value="${esc(x?.url ?? "")}" placeholder="https://">
      <p class="small muted">画像か文章のどちらかは必要です。個人の連絡先など、参加者に見せてはいけない内容は入れないでください。</p>`,
      "保存する",
    );
    if (!v) return;
    const a = { id: x?.id, text: v.text, url: v.url.trim() };
    if (sponsorFile) {
      try {
        a.img = await shrinkImage(sponsorFile);
      } catch {
        return toast("画像を読み込めませんでした。別の画像でお試しください。", "error", 6000);
      }
    } else if (v.removeImg) a.img = null;
    if (await cmd("sponsorSave", a, btn)) toast(S.st.sponsors?.enabled ? "保存しました。参加者の画面に表示されます。" : "保存しました。「参加者の画面に表示する」を押すと表示されます。", "ok", 6000);
  },
  viewTextsEdit: async (d, btn) => {
    const defs = S.st.viewTextDefaults ?? {};
    const cur = S.st.viewTexts ?? {};
    const fields = Object.entries(defs)
      .map(
        ([k, def]) => `<h3 style="margin-top:14px">${esc(def.label)}</h3>
      <label>大きく出る文章（60文字まで）</label><input name="${k}.headline" maxlength="60" value="${esc(cur[k]?.headline ?? "")}" placeholder="${esc(def.headline)}">
      <label>その下の説明（200文字まで）</label><textarea name="${k}.detail" maxlength="200" rows="2" placeholder="${esc(def.detail || "（なし）")}">${esc(cur[k]?.detail ?? "")}</textarea>`,
      )
      .join("");
    const v = await formModal(
      "参加者の画面の文章",
      `<p class="small muted">空欄のままの所は、薄く表示されている初期の文章が使われます（全部消すと初期の文章に戻ります）。<br><b>{ブース}</b> はブースの表示名、<b>{番号}</b> は受付番号に自動で置き換わります。変更すると、表示中の参加者の画面にもすぐ反映されます。</p>${fields}`,
      "保存する",
    );
    if (!v) return;
    const texts = {};
    for (const k of Object.keys(defs)) texts[k] = { headline: v[k + ".headline"] ?? "", detail: v[k + ".detail"] ?? "" };
    if (await cmd("viewTextsSet", { texts }, btn)) toast("参加者の画面の文章を保存しました", "ok");
  },
  eventEdit: async () => {
    const v = await formModal("イベント名の変更", `<label>イベント名（40文字まで）</label><input name="eventName" value="${esc(S.st.eventName)}" maxlength="40" required>`, "保存する");
    if (v) cmd("eventSet", { eventName: v.eventName });
  },
  boothAdd: async (d, btn) => {
    const b = S.st.booths.find((x) => !x.enabled);
    if (!b) return toast("ブースは最大数まで使用しています", "error");
    const v = await formModal(
      `ブース${b.id}を追加`,
      `<p class="small muted">番号は「${b.id}1」「${b.id}2」…の形になります。設定は後から「変更」で直せます。</p>
      <label>表示名（例：体験コーナー）</label><input name="name" value="${b.name !== b.id ? esc(b.name) : ""}" maxlength="20" placeholder="ブース${b.id}">
      <label>1回に同時に始める組数</label><input name="capacity" inputmode="numeric" value="${b.capacity}">
      <label>所要時間（短い場合・分）</label><input name="durMin" inputmode="numeric" value="${b.durMin}">
      <label>所要時間（長い場合・分）</label><input name="durMax" inputmode="numeric" value="${b.durMax}">
      <label>集合場所の案内（参加者に表示）</label><input name="gather" value="${esc(b.gather)}" maxlength="100">
      <label>1人あたりの料金（円・無料の場合は 0）</label><input name="price" inputmode="numeric" value="${b.price ?? 0}">`,
      "追加する",
    );
    if (!v) return;
    const ok = await cmd("boothSet", { booth: b.id, enabled: true, name: v.name || b.id, capacity: Number(v.capacity), durMin: Number(v.durMin), durMax: Number(v.durMax), gather: v.gather, price: Number(String(v.price).normalize("NFKC")) }, btn);
    if (ok) toast(`ブース${b.id}を追加しました。担当するスタッフの「担当ブース」にも追加してください。`, "ok", 6000);
  },
  boothEdit: async (d) => {
    const b = S.st.booths.find((x) => x.id === d.b);
    const v = await formModal(
      `ブース${b.id}の設定`,
      `<label>表示名</label><input name="name" value="${esc(b.name)}" maxlength="20">
      <label><input type="checkbox" name="enabled" ${b.enabled ? "checked" : ""} style="width:auto;min-height:0"> このブースを使う（外すと一覧から消えます。予約の記録は残り、「ブースを追加」で戻せます）</label>
      <label>1回に同時に始める組数</label><input name="capacity" inputmode="numeric" value="${b.capacity}">
      <label>所要時間（短い場合・分）</label><input name="durMin" inputmode="numeric" value="${b.durMin}">
      <label>所要時間（長い場合・分）</label><input name="durMax" inputmode="numeric" value="${b.durMax}">
      <label>集合場所の案内（参加者に表示）</label><input name="gather" value="${esc(b.gather)}" maxlength="100">
      <label>1人あたりの料金（円・無料の場合は 0）</label><input name="price" inputmode="numeric" value="${b.price ?? 0}">
      <p class="small muted">料金を変えても、すでに発行した予約の金額は変わりません（発行時点の料金で記録されます）。</p>`,
      "保存する",
    );
    if (v) cmd("boothSet", { booth: b.id, name: v.name, enabled: !!v.enabled, capacity: Number(v.capacity), durMin: Number(v.durMin), durMax: Number(v.durMax), gather: v.gather, price: Number(String(v.price).normalize("NFKC")) });
  },
  staffAdd: () => staffModal(null),
  staffEdit: (d) => staffModal(S.st.staff.find((s) => s.id === Number(d.id))),
  tplEdit: async () => {
    const v = await formModal("定型文の編集", `<p class="small muted">1行に1つ。{booth} はブース名に置き換わります。</p><textarea name="list" rows="8">${esc((S.st.templates ?? []).join("\n"))}</textarea>`, "保存する");
    if (v) cmd("templatesSet", { list: v.list.split("\n") });
  },
  exportCsv: () => download("/api/export?type=queue"),
  exportFull: () => download("/api/export?type=full"),
  audit: async () => {
    const r = await cmd("audit", { limit: 200 });
    if (!r) return;
    $("auditBox").innerHTML = `<table class="list"><tr><th>時刻</th><th>担当</th><th>操作</th><th>対象</th></tr>${r.data
      .map((a) => `<tr><td>${fmtClock(a.at, true)}</td><td>${esc(a.staff)}</td><td>${esc(a.action)}</td><td>${esc(a.target)}</td></tr>`)
      .join("")}</table>`;
  },
  doPrint: () => window.print(),
  statsReload: () => loadStats(true),
  statsExcel: (d, btn) => exportStatsExcel(btn),
  localCsv: () => localCsv(),
  reset: () => resetFlow(),
};

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act]");
  if (!t || t.disabled) return;
  const f = acts[t.dataset.act];
  if (!f) return;
  e.preventDefault();
  f(t.dataset, t, e);
});
document.addEventListener("change", (e) => {
  const id = e.target.dataset?.sel;
  if (!id) return;
  if (e.target.checked) S.selected.add(Number(id));
  else S.selected.delete(Number(id));
  scheduleRender();
});

async function download(path) {
  try {
    const r = await fetch(path, { headers: { Authorization: `Bearer ${S.token}` } });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      return toast(b.error ?? "保存できませんでした", "error");
    }
    const blob = await r.blob();
    const name = /filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") ?? "")?.[1] ?? "export";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("保存しました", "ok");
    return true;
  } catch {
    toast("通信できないため保存できませんでした。「印刷用の待ち列」から端末内の情報を保存できます。", "error", 7000);
    return false;
  }
}

function localCsv() {
  const head = ["ブース", "受付番号", "状態", ...(isAdmin() || me().canIssue ? ["確認コード"] : []), "受付", "開始", "終了", "メモ"];
  const rows = today()
    .sort((a, b) => a.booth.localeCompare(b.booth) || a.num - b.num)
    .map((r) => [r.booth, L(r), STATUS_JA[r.status], ...(isAdmin() || me().canIssue ? [`'${r.code ?? ""}`] : []), fmtClock(r.createdAt), fmtClock(r.startedAt), fmtClock(r.endedAt), r.note ?? ""]);
  const cell = (v) => (/[",\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const csv = "﻿" + [head, ...rows].map((l) => l.map(cell).join(",")).join("\r\n") + `\r\n"この内容は ${fmtClock(S.stateAt, true)} 時点の情報です"`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `queue-local-${Date.now()}.csv`;
  a.click();
}

// ================= モーダル =================
function modal(html, { onKey } = {}) {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  $("modalRoot").appendChild(back);
  if (onKey) back.addEventListener("keydown", onKey, true);
  return { el: back, close: () => back.remove() };
}

function confirmModal(title, text, okLabel = "実行する", kind = "") {
  return new Promise((resolve) => {
    const m = modal(`<h2>${esc(title)}</h2><p style="white-space:pre-wrap">${esc(text)}</p><div class="actions"><button class="ghost" data-x="no">キャンセル</button><button class="${kind}" data-x="yes">${esc(okLabel)}</button></div>`);
    m.el.querySelector('[data-x="no"]').focus();
    m.el.onclick = (e) => {
      const x = e.target.closest("[data-x]")?.dataset.x;
      if (!x && e.target !== m.el) return;
      m.close();
      resolve(x === "yes");
    };
  });
}

function infoModal(title, html) {
  const m = modal(`<h2>${esc(title)}</h2>${html}<div class="actions"><button class="ghost" data-x="close">閉じる</button></div>`);
  m.el.onclick = (e) => {
    if (e.target.closest('[data-x="close"]') || e.target === m.el) m.close();
  };
}

function formModal(title, fieldsHtml, okLabel = "保存する") {
  return new Promise((resolve) => {
    const m = modal(`<h2>${esc(title)}</h2><form>${fieldsHtml}<div class="actions"><button type="button" class="ghost" data-x="no">キャンセル</button><button type="submit">${esc(okLabel)}</button></div></form>`);
    const f = m.el.querySelector("form");
    f.querySelector("input,select,textarea")?.focus();
    m.el.querySelector('[data-x="no"]').onclick = () => {
      m.close();
      resolve(null);
    };
    f.onsubmit = (e) => {
      e.preventDefault();
      const v = {};
      for (const el of f.elements) if (el.name) v[el.name] = el.type === "checkbox" ? el.checked : el.value;
      m.close();
      resolve(v);
    };
  });
}

function moreModal(r) {
  if (!r) return;
  const adm = canIssue(r.booth);
  const iss = canIssue(r.booth);
  const op = canOp(r.booth);
  const btns = [];
  if (adm && r.status === "waiting") btns.push(`<button class="sub" data-y="front">待ち列の先頭へ</button>`, `<button class="sub" data-y="back">待ち列の最後尾へ</button>`, `<button class="sub" data-y="moveTo">指定した番号の前へ移動</button>`);
  if (op && r.status === "waiting") btns.push(`<button class="warn" data-y="absent">不在にする</button>`);
  if (adm) btns.push(`<button class="sub" data-y="people">人数を修正</button>`, `<button class="sub" data-y="note">メモを修正</button>`);
  if (adm && ["waiting", "called", "absent"].includes(r.status)) btns.push(`<button class="sub" data-y="reissue">ブースを変更（取消して別ブースで新番号）</button>`);
  if (iss && ["waiting", "called", "absent"].includes(r.status)) btns.push(`<button class="danger sub" data-y="cancel">取消</button>`);
  if (adm && r.status === "cancelled") btns.push(`<button class="sub" data-y="restore">復元</button>`);
  if (adm) btns.push(`<button class="sub" data-y="notice">この組にお知らせ</button>`);
  const m = modal(
    `<h2>${L(r)}（${STATUS_JA[r.status]}）</h2><p class="small muted">受付 ${fmtClock(r.createdAt)}・${esc(r.by)}${r.code ? `｜確認コード <b>${esc(r.code)}</b>` : ""}${r.note ? `<br>📝${esc(r.note)}` : ""}</p><div class="actions" style="flex-direction:column">${btns.join("")}<button class="ghost" data-y="close">閉じる</button></div>`,
  );
  m.el.onclick = async (e) => {
    const y = e.target.closest("[data-y]")?.dataset.y;
    if (!y && e.target !== m.el) return;
    m.close();
    if (!y || y === "close") return;
    if (y === "front" || y === "back") return cmd("move", { id: r.id, to: y, v: r.v });
    if (y === "moveTo") {
      const v = await formModal("移動", `<label>この番号の前に移動</label><input name="t" placeholder="例：A15">`, "移動する");
      if (!v) return;
      const s = v.t.normalize("NFKC").toUpperCase().replace(/\s/g, "");
      const t = today().find((x) => L(x) === s && x.status === "waiting" && x.booth === r.booth);
      if (!t) return toast("同じブースの待ち列にその番号は見つかりません", "error");
      return cmd("move", { id: r.id, before: t.id, v: r.v });
    }
    if (y === "absent") return acts.absent({ id: r.id });
    if (y === "cancel") return acts.cancel({ id: r.id });
    if (y === "restore") return acts.restore({ id: r.id });
    if (y === "people") {
      const v = await formModal("人数の修正", `<p class="small muted">金額は「人数 × 発行時の料金（${yen(r.price ?? 0)}）」で計算されます。</p><label>人数</label><input name="n" inputmode="numeric" value="${r.people ?? ""}">`);
      if (v) cmd("edit", { id: r.id, people: Number(String(v.n).normalize("NFKC")), v: r.v });
      return;
    }
    if (y === "note") {
      const v = await formModal("メモの修正", `<label>メモ</label><input name="note" value="${esc(r.note)}" maxlength="100">`);
      if (v) cmd("edit", { id: r.id, note: v.note, v: r.v });
    }
    if (y === "reissue") {
      const v = await formModal(
        "ブースの変更",
        `<p class="small muted">${L(r)} を取り消し、選んだブースの最後尾に新しい番号で並び直します（新しい番号と確認コードを参加者に伝えてください。参加者の画面は自動で新しい番号に切り替わります）。</p><label>変更先</label><select name="to">${enabledBooths()
          .filter((b) => b.id !== r.booth && canIssue(b.id))
          .map((b) => `<option value="${b.id}">ブース${b.id}</option>`)
          .join("")}</select>`,
        "変更する",
      );
      if (!v) return;
      const x = await cmd("reissue", { id: r.id, to: v.to });
      if (x) {
        const it = { id: x.res.id, label: L(x.res), code: x.res.code, booth: x.res.booth, at: Date.now(), replaced: L(r), warnings: x.warnings };
        S.issued = [it, ...S.issued].slice(0, 10);
        lsSet(K.issued, S.issued);
        infoModal("新しい番号", `<div class="issued"><div class="n">${esc(it.label)}</div><div>確認コード</div><div class="c">${esc(it.code)}</div></div>`);
      }
    }
    if (y === "notice") {
      S.tab = "notice";
      render();
      $("nScope").value = "res";
      $("nScope").onchange();
      $("nNum").value = L(r);
      $("nText").focus();
    }
  };
}

async function staffModal(s) {
  const isNew = !s;
  const roleOpts = Object.entries(ROLE_JA)
    .map(([k, v]) => `<option value="${k}" ${s?.role === k ? "selected" : ""}>${v}</option>`)
    .join("");
  const v = await formModal(
    isNew ? "スタッフを追加" : `${s.name} の設定`,
    `<label>役割名（ログインに使います。例：受付、ブースA、サポート）</label><input name="name" value="${esc(s?.name ?? "")}" maxlength="30" required>
    <label>役割</label><select name="role">${roleOpts}</select>
    <p class="small muted">全体管理者：すべて操作可能／サブ管理者：担当ブースの開始・終了・不在など／サポート担当：閲覧・チャット・対応依頼</p>
    <label>担当ブース（サブ管理者・受付権限用）</label>
    <div class="row">${staffBoothIds(s).map((b) => `<label style="font-weight:600"><input type="checkbox" name="b${b}" ${s?.booths?.includes(b) ? "checked" : ""} style="width:auto;min-height:0"> ${b}</label>`).join("")}</div>
    <label><input type="checkbox" name="canIssue" ${s?.canIssue ? "checked" : ""} style="width:auto;min-height:0"> 受付（担当ブースの予約追加・取消）もできる</label>
    ${isNew ? "" : `<label><input type="checkbox" name="active" ${s.active ? "checked" : ""} style="width:auto;min-height:0"> 有効（外すとアクセス停止・即ログアウト）</label>`}
    <label>${isNew ? "パスワード（6文字以上）" : "新しいパスワード（変更する場合のみ。変更するとその人はログアウトされます）"}</label>
    <input name="password" type="text" autocomplete="off" ${isNew ? "required minlength=6" : ""}>
    ${isNew ? "" : `<p><button type="button" class="mini warn" id="revokeBtn">この人の端末をすべてログアウトさせる</button></p>`}`,
    isNew ? "追加する" : "保存する",
  );
  if (!v) return;
  const a = { name: v.name, role: v.role, booths: staffBoothIds(s).filter((b) => v["b" + b]), canIssue: v.canIssue };
  if (v.password) a.password = v.password;
  if (isNew) {
    if (await cmd("staffCreate", a)) toast(`「${v.name}」を追加しました。役割名とパスワードを担当者に伝えてください。`, "ok", 6000);
  } else {
    a.id = s.id;
    a.active = v.active;
    if (await cmd("staffUpdate", a)) toast("保存しました", "ok");
  }
}
document.addEventListener("click", async (e) => {
  if (e.target.id !== "revokeBtn") return;
  // スタッフ設定ダイアログ内の「すべてログアウト」
  const name = e.target.closest("form").elements.name.value;
  const s = S.st.staff.find((x) => x.name === name);
  if (s && (await confirmModal("強制ログアウト", `${s.name} さんの端末をすべてログアウトさせます。`, "ログアウトさせる"))) cmd("staffRevoke", { id: s.id });
});

function accountModal() {
  const m = modal(`<h2>${esc(me()?.name ?? "")}（${ROLE_JA[me()?.role] ?? ""}）</h2>
    <form id="pwForm"><h3>パスワード変更</h3><label>現在のパスワード</label><input name="old" type="password" autocomplete="current-password" required><label>新しいパスワード（6文字以上）</label><input name="pw" type="password" autocomplete="new-password" minlength="6" required><div style="margin-top:8px"><button>変更する</button></div></form>
    <p><a href="/staff/help.html" target="_blank" rel="noopener">📖 使い方（説明書）</a></p>
    <div class="actions"><button class="ghost" data-x="reload">画面を最新にする</button><button class="danger sub" data-x="logout">ログアウト</button><button class="ghost" data-x="close">閉じる</button></div>
    <p class="small muted">ブックマーク用：この画面のアドレスを保存すると、次回すぐにこの画面を開けます。</p>`);
  m.el.querySelector("#pwForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      const r = await fetch("/api/password", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${S.token}` }, body: JSON.stringify({ old: f.old.value, password: f.pw.value }) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) return toast(b.error ?? "変更できませんでした", "error");
      toast("パスワードを変更しました", "ok");
      m.close();
    } catch {
      toast("通信できないため変更できませんでした", "error");
    }
  };
  m.el.onclick = async (e) => {
    const x = e.target.closest("[data-x]")?.dataset.x;
    if (!x && e.target !== m.el) return;
    if (x === "logout") {
      if (!(await confirmModal("ログアウト", "この端末からログアウトします。", "ログアウト"))) return;
      try {
        await fetch("/api/logout", { method: "POST", headers: { Authorization: `Bearer ${S.token}` } });
      } catch {}
      lsSet(K.token, null);
      lsSet(K.cache, null);
      S.token = null;
      S.st = null;
      m.close();
      return showLogin();
    }
    if (x === "reload") S.conn?.open();
    m.close();
  };
}

// ================= 全リセット（3段階の確認） =================
// ・各段階の「続行」は表示後しばらく押せない（連打・押しっぱなし対策）
// ・Enter キーやキーリピートでは進まない（マウス・タップでのクリックのみ受け付ける）
// ・確認の途中ではデータを一切変更しない（サーバー側も、確認チケットの発行から3秒以上経たないと実行しない）
async function resetFlow() {
  if (!isAdmin()) return;
  const STEPS = ["リセットを本当にしますか？", "本当の本当に？", "いいんだな、今ここで！"];
  const explain = `<div class="card" style="background:#fff8f8"><b>削除されるもの</b><ul class="reset-list"><li>予約・受付番号・確認コード（すべての営業日）</li><li>待ち列・回・進行状態・開始/終了の記録</li><li>参加者向けお知らせ</li><li>スタッフ間チャット・対応依頼・未読状態</li><li>過去の予約・操作履歴</li><li>参加者の端末に保存された閲覧情報（無効になります）</li></ul>
    <b>そのまま残るもの</b><ul class="reset-list"><li>スタッフのアカウント・役割・パスワード（ログイン状態も維持）</li><li>ブース設定（名前・組数・所要時間・集合場所）・定型文・営業日の開始番号</li><li>公開URL・掲示用QRコード</li></ul>
    リセット後は1日目の受付開始前の状態になり、次の番号は A1・B1・C1 です。</div>`;
  let ticket = null;
  for (let i = 0; i < 3; i++) {
    const last = i === 2;
    const ok = await resetStep(i + 1, STEPS[i], i === 0 ? explain + `<p><button type="button" class="sub" data-z="save">リセット前に全データを保存（任意）</button></p>` : explain, last ? "すべてリセットする" : "続行", async () => {
      if (i === 0) {
        // 確認チケットの取得（データは変更しない）
        const r = await send("resetPrepare", {});
        if (!r?.ok) {
          toast(r?.error ?? "通信できないため、リセットを開始できません", "error", 7000);
          return false;
        }
        ticket = r.ticket;
      }
      return true;
    });
    if (!ok) {
      toast("リセットをキャンセルしました。何も変更していません。", "", 4000);
      return;
    }
  }
  const r = await send("resetExecute", { ticket, phrase: "すべてリセットする" });
  if (r?.ok) {
    infoModal("リセットが完了しました", `<p>1日目の受付開始前の状態に戻りました。次の番号は A1・B1・C1 です。ほかのスタッフの画面も自動で更新されます。</p>`);
  } else if (r) {
    infoModal("リセットできませんでした", `<p>${esc(r.error ?? "")}</p><p>データは変更されていません。</p>`);
  } else {
    infoModal("結果を確認できませんでした", `<p>通信が切れたため、リセットが実行されたか確認できていません。接続が戻ると自動で確認します。画面上部の表示と待ち列を確認してください。</p>`);
  }
}

function resetStep(n, title, body, okLabel, onContinue) {
  return new Promise((resolve) => {
    const m = modal(
      `<div class="reset-step"><p class="small muted">全リセットの確認（${n}/3）</p><h2>${esc(title)}</h2>${body}<div class="actions"><button class="ghost big" data-z="cancel">キャンセル</button><button class="danger big" data-z="go" disabled>${esc(okLabel)}</button></div><p class="small muted" data-z="wait">確認のため、少し待ってから押せるようになります…</p></div>`,
      {
        onKey: (e) => {
          // Enter・スペース・キーリピートで確認が進まないようにする（Esc はキャンセル）
          if (e.key === "Escape") {
            e.preventDefault();
            done(false);
          } else if (e.key === "Enter" || e.key === " " || e.repeat) e.preventDefault();
        },
      },
    );
    const go = m.el.querySelector('[data-z="go"]');
    m.el.querySelector('[data-z="cancel"]').focus();
    let finished = false;
    const done = (v) => {
      if (finished) return;
      finished = true;
      m.close();
      resolve(v);
    };
    setTimeout(() => {
      go.disabled = false;
      m.el.querySelector('[data-z="wait"]').textContent = "";
    }, 1500);
    m.el.onclick = async (e) => {
      const z = e.target.closest("[data-z]")?.dataset.z;
      if (z === "cancel") return done(false);
      if (z === "save") return download("/api/export?type=full");
      if (z === "go") {
        // キーボード操作による「クリック」（detail=0）は受け付けない
        if (go.disabled || e.detail === 0) return;
        go.disabled = true;
        const ok = await onContinue();
        done(ok);
      }
    };
  });
}

// ================= URL（ブックマーク） =================
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get("tab")) S.tab = p.get("tab");
  if (p.get("b")) S.booth = p.get("b");
}
function writeHash() {
  const p = new URLSearchParams();
  p.set("tab", S.tab === "print" ? "booth" : S.tab);
  if (S.booth) p.set("b", S.booth);
  history.replaceState(null, "", "#" + p.toString());
}
window.addEventListener("hashchange", () => {
  readHash();
  render();
});

boot();
