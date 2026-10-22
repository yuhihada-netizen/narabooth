// 実際のブラウザ（Chromium）で、スタッフ画面と参加者画面をスマホサイズで操作する画面テスト。
// 実行: npm test（手元のテスト用サーバーを起動して行う。本番には触れない）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { startServer, setupAdmin, Staff, sleep } from "./helpers.mjs";

const SHOTS = process.env.SHOT_DIR || "test-results";
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
let srv, browser, api, adminCtx, subCtx, viewerCtx, admin, sub, viewer;
const errors = [];

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  srv = await startServer();
  const tok = await setupAdmin(srv.base, "管理者", "admin-pass-1");
  api = await new Staff(srv.base, tok).connect();
  await api.ok("staffCreate", { name: "Aさん", role: "sub", booths: ["A"], password: "sub-a-pass" });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium" });
  adminCtx = await browser.newContext(PHONE);
  subCtx = await browser.newContext(PHONE);
  viewerCtx = await browser.newContext(PHONE);
  for (const ctx of [adminCtx, subCtx, viewerCtx]) {
    ctx.on("page", (p) => {
      p.on("pageerror", (e) => errors.push(`${p.url()}: ${e.message}`));
      p.on("console", (m) => m.type() === "error" && !/WebSocket|Failed to load resource/.test(m.text()) && errors.push(`${p.url()}: ${m.text()}`));
    });
  }
  admin = await adminCtx.newPage();
  sub = await subCtx.newPage();
  viewer = await viewerCtx.newPage();
});
after(async () => {
  api?.close();
  await browser?.close();
  await srv?.stop();
});

async function staffLogin(page, name, pw) {
  await page.goto(srv.base + "/staff/");
  await page.fill("#lName", name);
  await page.fill("#lPw", pw);
  await page.click("#loginBtn");
  await page.waitForSelector("#conn.online");
}

test("スタッフがログインし、受付で予約を発行すると番号とコードが大きく表示される", async () => {
  await staffLogin(admin, "管理者", "admin-pass-1");
  await admin.click('nav.tabs button[data-tab="reception"]');
  await admin.click('#peopleBtns button[data-n="2"]');
  await admin.click('#issueBtns button[data-b="A"]');
  await admin.waitForSelector(".issued .n");
  assert.equal(await admin.textContent(".issued .n"), "A1");
  // 料金 0 円（無料）の初期状態では、お預かり金額は表示しない
  assert.equal(await admin.$(".issued .fee"), null);
  const code = (await admin.textContent(".issued .c")).trim();
  assert.match(code, /^\d{4}$/);
  await admin.screenshot({ path: `${SHOTS}/01-reception.png`, fullPage: true });
  // 2 組目・3 組目
  await admin.click('#peopleBtns button[data-n="2"]');
  await admin.click('#issueBtns button[data-b="A"]');
  await admin.waitForFunction(() => document.querySelector(".issued .n")?.textContent === "A2");
  await admin.click('#peopleBtns button[data-n="2"]');
  await admin.click('#issueBtns button[data-b="A"]');
  await admin.waitForFunction(() => document.querySelector(".issued .n")?.textContent === "A3");
  await admin.click('#peopleBtns button[data-n="2"]');
  await admin.click('#issueBtns button[data-b="A"]');
  await admin.waitForFunction(() => document.querySelector(".issued .n")?.textContent === "A4");
  // 別の端末で発行した番号も「最近発行した番号（全受付共通）」に出る（大きな表示は自分の発行分のまま）
  const other = await api.ok("issue", { booth: "C" });
  const lbl = `C${other.res.num}`;
  await admin.waitForFunction((l) => [...document.querySelectorAll("#issuedArea .qn")].some((e) => e.textContent === l), lbl);
  assert.equal(await admin.textContent(".issued .n"), "A4");
  await api.ok("cancel", { id: other.res.id });
});

test("参加者が番号とコードを入力すると状況が表示され、再訪問時は入力不要", async () => {
  const a1 = api.find("A1");
  await viewer.goto(srv.base + "/?k=" + api.state.viewerKey);
  await viewer.waitForSelector("#entry:not(.hidden)");
  // ブースのボタンを押さずに、番号欄へ英字込み（小文字）で入力しても使える
  await viewer.fill("#num", "a1");
  assert.equal(await viewer.getAttribute('#boothBtns button[data-b="A"]', "aria-pressed"), "true");
  await viewer.fill("#code", a1.code);
  await viewer.click("#entryBtn");
  await viewer.waitForSelector("#viewSec:not(.hidden)");
  assert.equal(await viewer.textContent("#vNum"), "A1");
  assert.match(await viewer.textContent("#vHead"), /次の回です。ブースAの待機場所へお戻りください/);
  await viewer.screenshot({ path: `${SHOTS}/02-viewer-next.png`, fullPage: true });
  await viewer.reload();
  await viewer.waitForSelector("#viewSec:not(.hidden)");
  assert.equal(await viewer.textContent("#vNum"), "A1");
});

test("画面の文字は選択（反転表示）されず、入力欄は入力できる", async () => {
  const sel = await viewer.evaluate(() => getComputedStyle(document.body).userSelect);
  assert.equal(sel, "none");
  const inp = await admin.evaluate(() => getComputedStyle(document.querySelector("#issueNote")).userSelect);
  assert.notEqual(inp, "none");
});

test("ブーススタッフが開始・終了を押すと、参加者画面と管理者画面に自動反映される", async () => {
  await staffLogin(sub, "Aさん", "sub-a-pass");
  await sub.waitForSelector(".booth-head");
  assert.match(await sub.textContent(".booth-head .bname"), /ブース A/);
  await sub.screenshot({ path: `${SHOTS}/03-booth-before.png`, fullPage: true });
  // A1 の開始（次の回の 3 組がまとまる）
  await sub.click(`button[data-act="start"][data-id="${api.find("A1").id}"]`);
  await viewer.waitForFunction(() => document.querySelector("#vHead")?.textContent === "参加中です");
  // A2 は呼び出し中として表示される
  await sub.waitForSelector(`button[data-act="start"][data-id="${api.find("A2").id}"]`);
  await sub.screenshot({ path: `${SHOTS}/04-booth-playing.png`, fullPage: true });
  // 「まとめて開始」で残り 2 組
  await sub.click('button[data-act="startAll"]');
  await api.until(() => api.find("A3").status === "playing");
  await admin.click('nav.tabs button[data-tab="booth"]');
  await admin.waitForSelector(`button[data-act="end"][data-id="${api.find("A2").id}"]`);
  // A1 を個別に終了
  await sub.click(`button[data-act="end"][data-id="${api.find("A1").id}"]`);
  await viewer.waitForFunction(() => document.querySelector("#vHead")?.textContent === "ご参加ありがとうございました");
  await viewer.screenshot({ path: `${SHOTS}/05-viewer-done.png`, fullPage: true });
  // 終了後は「次の受付番号を入力する」ボタンが出て、押すと入力画面に戻る
  assert.equal(await viewer.isVisible("#nextBtn"), true);
  // 残りをまとめて終了（確認ダイアログあり）
  await sub.click('button[data-act="endAll"]');
  await sub.click('.modal [data-x="yes"]');
  await api.until(() => api.find("A3").status === "done");
  // 自動で次の回は始まらない
  await sleep(300);
  assert.equal(api.find("A4").status, "waiting");
});

test("終了後、次の受付番号を入力する画面に戻れる", async () => {
  await viewer.click("#nextBtn");
  await viewer.waitForSelector("#entry:not(.hidden)");
  // 参加中・順番待ちの画面ではボタンは出ない（次の番号で確認）
  const a4 = api.find("A4");
  await viewer.fill("#num", "A4");
  await viewer.fill("#code", a4.code);
  await viewer.click("#entryBtn");
  await viewer.waitForSelector("#viewSec:not(.hidden)");
  assert.equal(await viewer.textContent("#vNum"), "A4");
  assert.equal(await viewer.isVisible("#nextBtn"), false);
});

test("不在と入れ直しの操作ができる", async () => {
  await sub.click(`button[data-act="absent"][data-id="${api.find("A4").id}"]`);
  await sub.click('.modal [data-x="yes"]');
  await api.until(() => api.find("A4").status === "absent");
  await sub.click(`button[data-act="ret"][data-mode="front"][data-id="${api.find("A4").id}"]`);
  await api.until(() => api.find("A4").status === "waiting");
});

test("チャットがスタッフ間で同期する", async () => {
  await sub.click('nav.tabs button[data-tab="comms"]');
  await sub.click('#chChips button[data-ch="A"]');
  await sub.fill("#chatText", "ブースAです、鉛筆が足りません");
  await sub.click("#chatForm button");
  await admin.click('nav.tabs button[data-tab="comms"]');
  await admin.click('#chChips button[data-ch="A"]');
  await admin.waitForFunction(() => [...document.querySelectorAll(".msg .body")].some((e) => e.textContent.includes("鉛筆が足りません")));
  await admin.screenshot({ path: `${SHOTS}/06-chat.png`, fullPage: true });
});

test("全リセット：3段階の確認文言、キャンセル・Enterキーでは進まず、最後まで押した場合だけリセット", async () => {
  await admin.click('nav.tabs button[data-tab="admin"]');
  await admin.screenshot({ path: `${SHOTS}/07-admin.png`, fullPage: true });
  const before = api.state.res.size;
  // 1段階目でキャンセル
  await admin.click('button[data-act="reset"]');
  await admin.waitForSelector(".reset-step h2");
  assert.equal(await admin.textContent(".reset-step h2"), "リセットを本当にしますか？");
  const body = await admin.textContent(".reset-step");
  assert.match(body, /削除されるもの/);
  assert.match(body, /そのまま残るもの/);
  await admin.screenshot({ path: `${SHOTS}/08-reset-step1.png`, fullPage: true });
  await admin.click('.reset-step [data-z="cancel"]');
  await admin.waitForSelector(".reset-step", { state: "detached" });
  // 1段階目→2段階目でキャンセル
  await admin.click('button[data-act="reset"]');
  await admin.waitForSelector('.reset-step [data-z="go"]:not([disabled])');
  await admin.click('.reset-step [data-z="go"]');
  await admin.waitForFunction(() => document.querySelector(".reset-step h2")?.textContent === "本当の本当に？");
  await admin.click('.reset-step [data-z="cancel"]');
  await admin.waitForSelector(".reset-step", { state: "detached" });
  assert.equal(api.state.res.size, before, "キャンセルでは何も変わらない");
  // Enter キーの押しっぱなしでは進まない
  await admin.click('button[data-act="reset"]');
  await admin.waitForSelector('.reset-step [data-z="go"]:not([disabled])');
  await admin.focus('.reset-step [data-z="go"]');
  for (let i = 0; i < 10; i++) await admin.keyboard.press("Enter");
  await sleep(300);
  assert.equal(await admin.textContent(".reset-step h2"), "リセットを本当にしますか？");
  // 最後まで進める
  await admin.click('.reset-step [data-z="go"]');
  await admin.waitForFunction(() => document.querySelector(".reset-step h2")?.textContent === "本当の本当に？");
  await admin.waitForSelector('.reset-step [data-z="go"]:not([disabled])');
  await admin.click('.reset-step [data-z="go"]');
  await admin.waitForFunction(() => document.querySelector(".reset-step h2")?.textContent === "いいんだな、今ここで！");
  assert.equal((await admin.textContent('.reset-step [data-z="go"]')).trim(), "すべてリセットする");
  await admin.screenshot({ path: `${SHOTS}/09-reset-step3.png`, fullPage: true });
  assert.equal(api.state.res.size, before, "3段階目の表示中もまだ変わらない");
  await admin.waitForSelector('.reset-step [data-z="go"]:not([disabled])');
  await admin.click('.reset-step [data-z="go"]');
  await admin.waitForFunction(() => document.querySelector(".modal h2")?.textContent === "リセットが完了しました");
  await api.until(() => api.state.res.size === 0);
  // 参加者画面は入力画面に戻り、理由が表示される
  await viewer.waitForSelector("#entry:not(.hidden)");
  assert.match(await viewer.textContent("#entryMsg"), /リセット/);
  await viewer.screenshot({ path: `${SHOTS}/10-viewer-after-reset.png`, fullPage: true });
  // 他のスタッフ画面も更新され、A1 から発行できる
  await admin.click('.modal [data-x="close"]');
  await admin.click('nav.tabs button[data-tab="reception"]');
  await admin.click('#peopleBtns button[data-n="2"]');
  await admin.click('#issueBtns button[data-b="A"]');
  await admin.waitForFunction(() => document.querySelector(".issued .n")?.textContent === "A1");
  await sub.click('nav.tabs button[data-tab="booth"]');
  await sub.waitForSelector(`button[data-act="start"]`);
});

test("人数を選ばないと発行できない／集計タブにグラフと合計が出て、Excelで保存できる", async () => {
  await api.ok("boothSet", { booth: "B", price: 400 });
  await admin.click('nav.tabs button[data-tab="reception"]');
  const before = api.state.res.size;
  await admin.click('#issueBtns button[data-b="B"]');
  await sleep(500);
  assert.equal(api.state.res.size, before, "人数未選択では発行しない");
  await admin.click('#peopleBtns button[data-n="3"]');
  await admin.click('#issueBtns button[data-b="B"]');
  await admin.waitForFunction(() => /1,200円/.test(document.querySelector(".issued .fee")?.textContent ?? ""));
  await admin.click('nav.tabs button[data-tab="stats"]');
  await admin.waitForSelector("#chartAmount svg");
  assert.match(await admin.textContent(".stat-tiles"), /1,200円/);
  await admin.screenshot({ path: `${SHOTS}/11-stats.png`, fullPage: true });
  const [dl] = await Promise.all([admin.waitForEvent("download"), admin.click('button[data-act="statsExcel"]')]);
  const path = `${SHOTS}/stats.xlsx`;
  await dl.saveAs(path);
  const { execFileSync } = await import("node:child_process");
  const list = execFileSync("python3", ["-c", "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);n=z.namelist();print('\\n'.join(n));print(z.read('xl/sharedStrings.xml').decode());print(z.read('xl/workbook.xml').decode())", path]).toString();
  assert.match(list, /xl\/media\/image1\.png/);
  assert.match(list, /xl\/media\/image2\.png/);
  assert.match(list, /全ブース合計/);
  assert.match(list, /name="ブースA"/);
  assert.match(list, /name="ブースB"/);
  assert.match(list, /name="予約一覧"/);
  assert.match(list, /ブースBの組ごとの一覧/);
});

test("管理タブ：使っていないブースは一覧に出ず、「ブースを追加」で次のブースを追加できる", async () => {
  await admin.click('nav.tabs button[data-tab="admin"]');
  await admin.waitForSelector('button[data-act="boothAdd"]');
  assert.equal(await admin.$$eval('button[data-act="boothEdit"]', (bs) => bs.map((b) => b.dataset.b).join("")), "ABC");
  await admin.click('button[data-act="boothAdd"]');
  await admin.fill('input[name="name"]', "体験コーナー");
  await admin.click('form button[type="submit"]');
  await api.until(() => api.state.booths.find((b) => b.id === "D")?.enabled);
  await admin.waitForFunction(() => [...document.querySelectorAll('button[data-act="boothEdit"]')].map((b) => b.dataset.b).join("") === "ABCD");
  await admin.click('nav.tabs button[data-tab="reception"]');
  await admin.waitForSelector('#issueBtns button[data-b="D"]');
  await api.ok("boothSet", { booth: "D", enabled: false });
});

test("管理タブから使い方（説明書）を開ける／イベント名が画面に表示される", async () => {
  await admin.click('nav.tabs button[data-tab="admin"]');
  assert.match(await admin.textContent("#dayLabel"), /テストイベント/);
  const [help] = await Promise.all([adminCtx.waitForEvent("page"), admin.click("#helpLink")]);
  await help.waitForLoadState();
  assert.match(await help.textContent("h1"), /使い方/);
  assert.ok(await help.isVisible("#s2"));
  await help.screenshot({ path: `${SHOTS}/13-help.png` });
  await help.close();
});

test("通信できない時でも、スタッフ画面を開き直すと端末内の最新情報が表示される", async () => {
  await admin.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 }).catch(async () => {
    await admin.reload(); // 初回は登録直後のため、開き直すと有効になる
    await admin.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 });
  });
  await admin.waitForSelector("#conn.online");
  await admin.click('nav.tabs button[data-tab="booth"]');
  await admin.waitForTimeout(1500); // 端末内への保存を待つ
  await adminCtx.setOffline(true);
  try {
    await admin.reload();
    await admin.waitForSelector("#app:not(.hidden)");
    await admin.waitForSelector("#offlineBanner:not(.hidden)");
    assert.match(await admin.textContent("#connText"), /通信できません/);
    assert.ok(await admin.isVisible("#tab-booth"), "ブース画面が表示される");
    await admin.screenshot({ path: `${SHOTS}/12-offline-reopen.png`, fullPage: true });
  } finally {
    await adminCtx.setOffline(false);
  }
  await admin.waitForSelector("#conn.online", { timeout: 40000 });
  assert.ok(await admin.isHidden("#updateBanner"), "版が変わっていなければ更新の案内は出ない");
});

test("画面のJavaScriptエラーがない", () => {
  assert.deepEqual(errors, []);
});
