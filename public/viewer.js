// 参加者画面：受付番号＋確認コードで自分の状況を見るだけ（操作はできない）
import { Conn, fmtClock, esc, lsGet, lsSet, connLabel } from "/conn.js";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "nazo.viewerToken";
const DEVICE_KEY = "nazo.device";
const QR_KEY = "nazo.qrKey";
const OLD_QR_MSG = "このQRコードは現在使えません。会場に掲示されている新しいQRコードを読み取ってください。";
// 掲示のQRコードのアドレスに含まれる合言葉（?k=…）。番号を入力し直す時のために端末に保存しておく
const urlKey = new URLSearchParams(location.search).get("k");
if (urlKey) lsSet(QR_KEY, urlKey);
const qrKey = urlKey ?? lsGet(QR_KEY) ?? "";
let device = lsGet(DEVICE_KEY);
if (!device) {
  device = Math.random().toString(36).slice(2) + Date.now().toString(36);
  lsSet(DEVICE_KEY, device);
}
let conn = null;
let last = null; // 最後に受け取った表示内容
let offset = 0; // サーバー時刻 - 端末時刻
let booth = "A";
// ブースの呼び名（表示名を付けていなければ「ブースA」）
const boothLabel = (v) => (v.boothName && v.boothName !== v.booth ? v.boothName : `ブース${v.booth}`);
let keyOk = true; // 掲示のQRコードが今も使えるか

async function init() {
  try {
    const info = await (await fetch("/api/info?s=1&k=" + encodeURIComponent(qrKey))).json();
    showSponsors(info.sponsors ?? []);
    keyOk = info.keyOk !== false;
    $("eventName").textContent = info.eventName;
    document.title = `${info.eventName}｜受付状況`;
    if (info.env) {
      $("envBadge").textContent = info.env;
      $("envBadge").classList.remove("hidden");
    }
    const enabled = info.booths.filter((b) => b.enabled);
    booth = enabled[0]?.id ?? "A";
    $("boothBtns").style.gridTemplateColumns = `repeat(${Math.min(5, Math.max(1, enabled.length))}, 1fr)`;
    $("boothBtns").innerHTML = enabled.map((b) => `<button type="button" data-b="${esc(b.id)}" aria-pressed="${b.id === booth}">${esc(b.id)}</button>`).join("");
  } catch {
    $("boothBtns").innerHTML = ["A"].map((b) => `<button type="button" data-b="${b}" aria-pressed="true">${b}</button>`).join("");
  }
  $("boothBtns").onclick = (e) => {
    const b = e.target.closest("button")?.dataset.b;
    if (b) selectBooth(b);
  };
  // 番号欄に「A12」のように英字を入れた場合は、そのブースを選んだことにする
  $("num").addEventListener("input", () => {
    const m = /^([A-Za-zＡ-Ｚａ-ｚ])/.exec($("num").value.trim());
    if (m) selectBooth(m[1].normalize("NFKC").toUpperCase());
  });
  const token = lsGet(TOKEN_KEY);
  if (token) startView(token);
  else if (!keyOk) showEntry(OLD_QR_MSG, true);
  else showEntry();
}

function selectBooth(b) {
  booth = b;
  for (const x of $("boothBtns").children) x.setAttribute("aria-pressed", String(x.dataset.b === b));
}

function showEntry(msg, noForm = false) {
  $("entryForm").classList.toggle("hidden", noForm);
  conn?.stop();
  conn = null;
  $("loading").classList.add("hidden");
  $("viewSec").classList.add("hidden");
  $("statusBar").classList.add("hidden");
  $("entry").classList.remove("hidden");
  if (msg) {
    $("entryMsg").textContent = msg;
    $("entryMsg").classList.remove("hidden");
  } else $("entryMsg").classList.add("hidden");
}

$("entryForm").onsubmit = async (e) => {
  e.preventDefault();
  const raw = $("num").value.normalize("NFKC").toUpperCase().replace(/[\s\-ー－]/g, "");
  const m = /^([A-Z])?(\d{1,5})$/.exec(raw);
  if (m?.[1]) selectBooth(m[1]);
  const num = m ? m[2] : "";
  const code = $("code").value.normalize("NFKC").replace(/\D/g, "");
  if (!num) return showEntry("受付番号は「A12」のように入力してください");
  if (code.length !== 4) return showEntry("確認コードは4桁の数字です（先頭が0の場合も入力してください）");
  const btn = $("entryBtn");
  btn.disabled = true;
  btn.textContent = "確認中…";
  try {
    const r = await fetch("/api/viewer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ number: booth + num, code, device, key: qrKey }) });
    const body = await r.json().catch(() => ({}));
    if (body.oldKey) return showEntry(OLD_QR_MSG, true);
    if (!r.ok) return showEntry(body.error ?? "確認できませんでした。もう一度お試しください。");
    lsSet(TOKEN_KEY, body.token);
    $("code").value = "";
    startView(body.token);
  } catch {
    showEntry("通信できませんでした。電波の良い場所でもう一度お試しください。");
  } finally {
    btn.disabled = false;
    btn.textContent = "表示する";
  }
};

function startView(token) {
  $("entry").classList.add("hidden");
  $("loading").classList.remove("hidden");
  $("statusBar").classList.remove("hidden");
  conn?.stop();
  conn = new Conn({
    credential: "v." + token,
    onMessage,
    onStatus: renderConn,
    onAuthFail: () => {
      lsSet(TOKEN_KEY, null);
      showEntry("この端末に保存されていた受付情報は使えなくなりました。お手数ですが、もう一度入力してください。");
    },
  });
  conn.start();
}

function onMessage(m) {
  if (m.now) offset = m.now - Date.now();
  if (m.t === "invalid") {
    lsSet(TOKEN_KEY, null);
    return showEntry("受付情報がリセットされました。お手数ですが、受付で伝えられた番号ともう一度入力してください。");
  }
  if (m.t === "view") {
    last = m;
    render();
  }
  renderConn();
}

function renderConn() {
  const st = conn?.status ?? "connecting";
  $("conn").className = "conn " + st;
  $("connText").textContent = connLabel(st, conn?.lastMsgAt);
}

function render() {
  if (!last) return;
  $("loading").classList.add("hidden");
  $("viewSec").classList.remove("hidden");
  if (last.none) {
    $("vNum").textContent = "—";
    $("vHead").textContent = "予約が見つかりません";
    $("vDetail").textContent = "スタッフにお声がけください。";
    return;
  }
  const v = last.view;
  $("vBooth").textContent = boothLabel(v);
  $("vNum").textContent = v.number;
  $("vState").className = "state " + v.phase;
  $("vHead").textContent = v.headline;
  $("vDetail").textContent = v.detail;
  // 終了・取消の後だけ、次の受付番号を入力するボタンを出す
  $("nextWrap").classList.toggle("hidden", !(v.phase === "done" || v.phase === "cancelled"));
  $("otherDay").classList.toggle("hidden", !v.otherDay);
  $("otherDay").textContent = v.otherDay ? `この受付番号は「${last.dayLabel}」の予約です。` : "";
  const pb = $("pauseBanner");
  if (last.paused && ["waiting", "next", "called", "absent"].includes(v.phase)) {
    pb.textContent = `${boothLabel(v)}は一時停止中です${last.pauseReason ? `（${last.pauseReason}）` : ""}。再開までお待ちください。`;
    pb.classList.remove("hidden");
  } else pb.classList.add("hidden");
  // 詳細情報
  const rows = [];
  if (v.phase === "waiting" || v.phase === "next") {
    rows.push(["前に待っている組", `${v.groupsAhead}組（${v.roundsAhead === 0 ? "次に呼ばれる回" : `あと${v.roundsAhead}回先`}）`]);
    rows.push(["待ち時間の目安", waitText(v)]);
  }
  if (["waiting", "next", "called", "absent"].includes(v.phase) && v.gather) rows.push(["集合場所", v.gather]);
  if (last.done?.length) rows.push(["参加済み", last.done.join("、")]);
  $("vInfoCard").classList.toggle("hidden", rows.length === 0);
  $("vInfo").innerHTML = rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join("");
  const ns = last.notices ?? [];
  $("vNotices").innerHTML = ns.length
    ? ns.map((n) => `<div class="notice"><div class="small muted">${fmtClock(n.at)} のお知らせ</div><div style="font-weight:700">${esc(n.text)}</div></div>`).join("")
    : `<p class="muted" style="margin:0">現在お知らせはありません。</p>`;
}

function waitText(v) {
  if (v.unknown) return v.unknown;
  if (v.from === null) return "表示できません";
  const now = Date.now() + offset;
  const lo = Math.max(0, Math.floor((v.from - now) / 60000 / 5) * 5);
  const hi = Math.max(0, Math.ceil((v.to - now) / 60000 / 5) * 5);
  if (hi <= 0) return v.overrun ? "まもなく（前の回が予定より延びています）" : "まもなく";
  const range = lo === hi ? `約${hi}分` : `約${lo}〜${hi}分`;
  return `${range}（${fmtClock(v.from - offset)}〜${fmtClock(v.to - offset)}ごろ）${v.overrun ? "※前の回が予定より延びています" : ""}`;
}

// 待ち時間の表示を時間の経過に合わせて更新（通信はしない）
setInterval(() => {
  if (last && !last.none) render();
  renderConn();
}, 15000);

$("reloadBtn").onclick = () => {
  if (conn) {
    conn.retry = 0;
    conn.open();
  }
};
$("nextBtn").onclick = () => {
  lsSet(TOKEN_KEY, null);
  last = null;
  $("num").value = "";
  showEntry();
};

// 入力し直しが必要な時（スタッフが案内する場合のみ）は、アドレスの末尾に #change を付けて開く
if (location.hash === "#change") {
  lsSet(TOKEN_KEY, null);
  history.replaceState(null, "", location.pathname);
}

init();

// ---------- 協賛・お知らせ枠（複数ある時は 8 秒ごとに切り替える） ----------
let spTimer = null;
function showSponsors(list) {
  clearInterval(spTimer);
  const box = $("sponsorBox");
  if (!list.length) return box.classList.add("hidden");
  box.classList.remove("hidden");
  let i = 0;
  const draw = () => {
    const it = list[i % list.length];
    const inner = `${it.img ? `<img src="${esc(it.img)}" alt="${esc(it.text || "協賛・お知らせ")}">` : ""}${it.text ? `<div class="sp-text">${esc(it.text)}</div>` : ""}`;
    $("sponsorItem").innerHTML = it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer nofollow sponsored">${inner}</a>` : `<div class="sp">${inner}</div>`;
    $("sponsorDots").textContent = list.length > 1 ? list.map((_, j) => (j === i % list.length ? "●" : "○")).join("") : "";
  };
  draw();
  if (list.length > 1) spTimer = setInterval(() => { i++; draw(); }, 8000);
}

