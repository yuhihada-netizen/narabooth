// 受付〜終了までの一連の動作を、手元のテスト用サーバーで自動確認する。
// 実行: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, setupAdmin, login, post, Staff, Viewer, sleep, SETUP_TOKEN } from "./helpers.mjs";

let srv, admin, admin2, subA, subB, support, reception;
const lbl = (r) => `${r.booth}${r.num}`;

before(async () => {
  srv = await startServer();
});
after(async () => {
  for (const c of [admin, admin2, subA, subB, support, reception]) c?.close();
  await srv?.stop();
});

test("初期設定：合言葉が違うと管理者を作れない／一度作ったら再実行できない", async () => {
  const bad = await post(srv.base, "/api/setup", { token: "wrong-token", name: "x", password: "123456" });
  assert.equal(bad.status, 403);
  // 前後の空白・全角で入力しても合言葉として受け付ける
  const wide = SETUP_TOKEN.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
  const made = await post(srv.base, "/api/setup", { token: `  ${wide} `, eventName: "テストイベント", boothCount: 3, name: "管理者", password: "admin-pass-1" });
  assert.equal(made.status, 200);
  const tok = await login(srv.base, "管理者", "admin-pass-1");
  const again = await post(srv.base, "/api/setup", { token: SETUP_TOKEN, name: "y", password: "123456" });
  assert.equal(again.status, 409);
  admin = await new Staff(srv.base, tok).connect();
  assert.equal(admin.state.me.role, "admin");
  assert.equal(admin.state.env, "テスト環境");
  const wrong = await post(srv.base, "/api/login", { name: "管理者", password: "nope-nope" });
  assert.equal(wrong.status, 401);
});

test("初期設定：イベント名と使うブースの数（A から順に使用中、残りは使用しない）。イベント名は管理者だけ変更でき、全端末に反映", async () => {
  const infoRes = await fetch(srv.base + "/api/info");
  assert.equal(infoRes.headers.get("access-control-allow-origin"), "*", "スタッフ用アプリから公開の情報を読める");
  const info = await infoRes.json();
  assert.equal(info.eventName, "テストイベント");
  assert.deepEqual(info.booths.filter((b) => b.enabled).map((b) => b.id), ["A", "B", "C"]);
  assert.equal(info.booths.length, 10);
  await admin.ok("eventSet", { eventName: "春のイベント" });
  await admin.until(() => admin.state.eventName === "春のイベント");
  assert.equal((await (await fetch(srv.base + "/api/info")).json()).eventName, "春のイベント");
  assert.equal((await admin.send("eventSet", { eventName: "  " })).ok, false);
  await admin.ok("eventSet", { eventName: "テストイベント" });
});

test("スタッフ追加と、各役割での同時ログイン", async () => {
  await admin.ok("staffCreate", { name: "Aさん", role: "sub", booths: ["A"], password: "sub-a-pass" });
  await admin.ok("staffCreate", { name: "Bさん", role: "sub", booths: ["B"], password: "sub-b-pass" });
  await admin.ok("staffCreate", { name: "サポ", role: "support", booths: [], password: "support-pass" });
  await admin.ok("staffCreate", { name: "受付", role: "sub", booths: ["A", "B", "C"], canIssue: true, password: "recept-pass" });
  const dup = await admin.send("staffCreate", { name: "Aさん", role: "sub", booths: ["A"], password: "xxxxxx" });
  assert.equal(dup.ok, false);
  subA = await new Staff(srv.base, await login(srv.base, "Aさん", "sub-a-pass")).connect();
  subB = await new Staff(srv.base, await login(srv.base, "Bさん", "sub-b-pass")).connect();
  support = await new Staff(srv.base, await login(srv.base, "サポ", "support-pass")).connect();
  reception = await new Staff(srv.base, await login(srv.base, "受付", "recept-pass")).connect();
  // 同じ管理者アカウントで 2 台目
  admin2 = await new Staff(srv.base, await login(srv.base, "管理者", "admin-pass-1")).connect();
  assert.equal(admin2.state.me.name, "管理者");
});

test("予約追加：番号A1から連番、確認コードは4桁（先頭0含む文字列）、他端末へ即反映", async () => {
  const r1 = await admin.ok("issue", { booth: "A" });
  assert.equal(lbl(r1.res), "A1");
  assert.match(r1.res.code, /^\d{4}$/);
  assert.equal(typeof r1.res.code, "string");
  await subA.until(() => subA.find("A1"));
  await admin2.until(() => admin2.find("A1"));
  // サブ管理者（受付権限なし）には確認コードを渡さない
  assert.equal(subA.find("A1").code, undefined);
  assert.equal(support.find("A1")?.code, undefined);
});

test("同時受付：3端末から同時に60件発行しても番号が重複しない", async () => {
  const jobs = [];
  for (let i = 0; i < 20; i++) for (const c of [admin, admin2, reception]) jobs.push(c.ok("issue", { booth: "B" }));
  const rs = await Promise.all(jobs);
  const nums = rs.map((r) => r.res.num).sort((a, b) => a - b);
  assert.deepEqual(nums, Array.from({ length: 60 }, (_, i) => i + 1));
  const codes = new Set(rs.map((r) => r.res.code));
  assert.ok(codes.size > 40); // ランダム（重複はありうるが偏っていない）
  // テスト用に B の予約は取り消しておく（取消済み番号は再利用されない）
  for (const r of rs) await admin.ok("cancel", { id: r.res.id });
  const next = await admin.ok("issue", { booth: "B" });
  assert.equal(next.res.num, 61);
  await admin.ok("cancel", { id: next.res.id });
});

test("権限：担当外ブース・受付権限なし・サポートの操作はサーバーで拒否", async () => {
  const b = await admin.ok("issue", { booth: "B" });
  const r1 = await subA.send("start", { ids: [b.res.id] });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /権限/);
  const r2 = await subA.send("issue", { booth: "A" });
  assert.equal(r2.ok, false);
  const r3 = await support.send("cancel", { id: b.res.id });
  assert.equal(r3.ok, false);
  const r4 = await subA.send("boothSet", { booth: "A", capacity: 5 });
  assert.equal(r4.ok, false);
  const r5 = await subA.send("staffCreate", { name: "x", role: "admin", password: "xxxxxxx" });
  assert.equal(r5.ok, false);
  const r6 = await subB.send("resetPrepare", {});
  assert.equal(r6.ok, false);
  // 受付権限ありのサブ管理者は発行できる
  const r7 = await reception.send("issue", { booth: "C" });
  assert.equal(r7.ok, true);
  await admin.ok("cancel", { id: r7.res.id });
  await admin.ok("cancel", { id: b.res.id });
  // 全データ出力は管理者のみ
  const ex = await fetch(srv.base + "/api/export?type=full", { headers: { Authorization: `Bearer ${subA.token}` } });
  assert.equal(ex.status, 403);
  const ex2 = await fetch(srv.base + "/api/export?type=full", { headers: { Authorization: `Bearer ${admin.token}` } });
  assert.equal(ex2.status, 200);
  const csv = await fetch(srv.base + "/api/export?type=queue", { headers: { Authorization: `Bearer ${subA.token}` } });
  assert.equal(csv.status, 200);
  assert.ok(!(await csv.text()).includes("確認コード"));
});

test("参加者：番号＋コードで閲覧、誤りは拒否、他組のコードや内部情報は含まれない", async () => {
  const a1 = admin.find("A1");
  const v = new Viewer(srv.base);
  const bad = await v.login("A1", a1.code === "0000" ? "0001" : "0000");
  assert.equal(bad.status, 404);
  const ok = await v.login("ａ１", a1.code); // 全角入力でも可
  assert.equal(ok.status, 200);
  await v.connect();
  const view = v.last;
  assert.equal(view.view.number, "A1");
  assert.ok(["waiting", "next"].includes(view.view.phase));
  const raw = JSON.stringify(view);
  assert.ok(!raw.includes(a1.code), "確認コードを含めない");
  assert.ok(!raw.includes('"grp"'));
  // 参加者端末からの操作送信は無視される
  v.ws.send(JSON.stringify({ id: "x", cmd: "cancel", a: { id: a1.id } }));
  await sleep(300);
  assert.equal(admin.find("A1").status, "waiting");
  v.close();
});

test("回の運営：定員3組、開始を順番に押しても同じ回、個別終了・一括終了、自動で次の回を始めない", async () => {
  // A2〜A7 を追加（A1 と合わせて 7 組）
  for (let i = 0; i < 6; i++) await admin.ok("issue", { booth: "A" });
  const v1 = new Viewer(srv.base);
  await v1.login("A1", admin.find("A1").code);
  await v1.connect();
  const v4 = new Viewer(srv.base);
  await v4.login("A4", admin.find("A4").code);
  await v4.connect();
  const v7 = new Viewer(srv.base);
  await v7.login("A7", admin.find("A7").code);
  await v7.connect();
  assert.equal(v1.last.view.phase, "next");
  assert.equal(v4.last.view.phase, "waiting");
  assert.equal(v4.last.view.groupsAhead, 3);
  assert.equal(v7.last.view.roundsAhead, 2);
  assert.ok(v7.last.view.from < v7.last.view.to, "幅のある目安");

  // A1 だけ開始 → A1〜A3 が同じ回に入り、A2/A3 は「あなたの番」
  await subA.ok("start", { ids: [admin.find("A1").id] });
  await v1.untilPhase("playing");
  await subA.until(() => subA.find("A2").status === "called");
  const round = subA.find("A1").round;
  assert.ok(round);
  assert.equal(subA.find("A2").round, round);
  // 2 台の端末から A2 と A3 を別々に開始しても同じ回
  await Promise.all([subA.ok("start", { ids: [subA.find("A2").id] }), admin.ok("start", { ids: [admin.find("A3").id] })]);
  await subA.until(() => subA.find("A3").status === "playing");
  assert.equal(subA.find("A3").round, round);
  // A4 は次の回の案内
  await v4.untilPhase("next");
  // 開始済みの組に「来てください」と表示しない
  assert.equal(v1.last.view.headline, "参加中です");

  // 1 組だけ終了 → 次の回は自動では始まらない
  await subA.ok("end", { ids: [subA.find("A1").id] });
  await v1.untilPhase("done");
  await sleep(200);
  assert.equal(subA.find("A4").status, "waiting");
  // 残り 2 組を一括終了
  await subA.ok("end", { ids: [subA.find("A2").id, subA.find("A3").id] });
  await subA.until(() => subA.state.rounds.get(round).status === "done");
  assert.equal(subA.find("A4").status, "waiting", "回が終わっても次の回は自動開始しない");

  // 次の回を呼び出し → A4〜A6 が「あなたの番」、A7 は次の回
  await subA.ok("call", { booth: "A" });
  await v4.untilPhase("called");
  await v7.untilPhase("next");
  // まとめて開始
  const ids = ["A4", "A5", "A6"].map((x) => subA.find(x).id);
  const st = await subA.ok("start", { ids });
  assert.deepEqual(st.started, ["A4", "A5", "A6"]);
  await v4.untilPhase("playing");
  // 二重開始は起きない（すでに開始済み）
  const again = await subA.ok("start", { ids });
  assert.deepEqual(again.started, []);
  assert.deepEqual(again.already, ["A4", "A5", "A6"]);
  await subA.ok("end", { ids });
  for (const v of [v1, v4, v7]) v.close();
});

test("連打・再送：同じ操作IDは一度だけ処理され、別端末の同時操作でも二重終了しない", async () => {
  const r = await admin.ok("issue", { booth: "C" });
  const id = r.res.id;
  // 同じ操作ID で発行を 3 回送っても 1 件だけ
  const opId = "fixed-op-issue-1";
  const results = await Promise.all([admin.send("issue", { booth: "C" }, { id: opId }), admin.send("issue", { booth: "C" }, { id: opId }), admin.send("issue", { booth: "C" }, { id: opId })]);
  assert.ok(results.every((x) => x.ok));
  await sleep(200);
  const cs = [...admin.state.res.values()].filter((x) => x.booth === "C" && x.status !== "cancelled");
  assert.equal(cs.length, 2, "C1 と、同じ操作IDの発行 1 件だけ");
  // 2 台から同時に開始・終了
  await Promise.all([admin.ok("start", { ids: [id] }), admin2.ok("start", { ids: [id] })]);
  const ends = await Promise.all([admin.ok("end", { ids: [id] }), admin2.ok("end", { ids: [id] })]);
  const doneCount = ends.reduce((n, e) => n + e.done.length, 0);
  assert.equal(doneCount, 1, "終了は 1 回だけ処理される");
  // 古い画面（古い版番号）からの取消は拒否
  const c2 = cs.find((x) => x.id !== id);
  const v = admin.state.res.get(c2.id).v;
  await admin2.ok("edit", { id: c2.id, note: "メモ", v });
  const stale = await admin.send("cancel", { id: c2.id, v });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /他のスタッフ/);
  await admin.ok("cancel", { id: c2.id });
});

test("不在・入れ直し・取消・復元・取り直し・並び替え", async () => {
  // A7〜A10 を準備（A7 は待ち）
  for (let i = 0; i < 3; i++) await admin.ok("issue", { booth: "A" }); // A8, A9, A10
  await subA.ok("call", { booth: "A" }); // A7, A8, A9 を呼び出し
  await subA.until(() => subA.find("A9").status === "called");
  // A8 が戻ってこない → 不在
  await subA.ok("absent", { id: subA.find("A8").id });
  await subA.until(() => subA.find("A8").status === "absent");
  const va8 = new Viewer(srv.base);
  await va8.login("A8", admin.find("A8").code);
  await va8.connect();
  assert.equal(va8.last.view.phase, "absent");
  // 不在の組は開始できない
  const ng = await subA.send("start", { ids: [subA.find("A8").id] });
  assert.equal(ng.ok, false);
  // 戻ってきた → 呼び出し中の回（空きあり）へ
  await subA.ok("returnAbsent", { id: subA.find("A8").id, mode: "round" });
  await va8.untilPhase("called");
  // 取消と復元
  const a10 = admin.find("A10");
  await admin.ok("cancel", { id: a10.id });
  await admin.until(() => admin.find("A10").status === "cancelled");
  await admin.ok("restore", { id: a10.id });
  await admin.until(() => admin.find("A10").status === "waiting");
  // 並び替え：A10 と A11 を入れ替え
  const a11 = (await admin.ok("issue", { booth: "A" })).res;
  await admin.ok("swap", { id: a10.id, other: a11.id });
  await admin.until(() => admin.find("A11").pos < admin.find("A10").pos);
  // 取り直し：A11 の組が B で再受付（元の予約を取り消して新番号）
  const conflict = await admin.send("issue", { booth: "B", prev: "A11" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.confirm, true);
  const re = await admin.ok("issue", { booth: "B", prev: "A11", replace: true });
  assert.equal(re.replaced, "A11");
  await admin.until(() => admin.find("A11").status === "cancelled");
  // 取消済み A11 の復元は二重予約になるので確認が出る
  const rr = await admin.send("restore", { id: admin.find("A11").id });
  assert.equal(rr.confirm, true);
  // 取り直し後の番号は新しい（再利用しない）
  assert.ok(re.res.num > 61);
  va8.close();
  // 後片付け：呼び出し中の回を開始して終了
  const ids = ["A7", "A8", "A9"].map((x) => subA.find(x).id);
  await subA.ok("start", { ids });
  await subA.ok("end", { ids });
});

test("同じ組の識別：前の番号を入力して次のブースを予約すると、参加者画面が自動で切り替わる", async () => {
  // A7 は終了済み。A7 の組が B を予約
  const v = new Viewer(srv.base);
  await v.login("A7", admin.find("A7").code);
  await v.connect();
  await v.untilPhase("done");
  const b = await reception.ok("issue", { booth: "B", prev: "A7" });
  const t = Date.now();
  while (v.last.view.number !== lbl(b.res)) {
    if (Date.now() - t > 5000) throw new Error("not switched");
    await sleep(20);
  }
  assert.deepEqual(v.last.done, ["A7"]);
  // 参加中の組は次のブースを予約できない
  const a10 = admin.find("A10");
  await admin.ok("call", { booth: "A" });
  await admin.until(() => admin.find("A10").status === "called");
  await admin.ok("start", { ids: [a10.id] });
  const ng = await reception.send("issue", { booth: "C", prev: "A10" });
  assert.equal(ng.ok, false);
  assert.match(ng.error, /参加中/);
  v.close();
});

test("開始・終了の取り消し（誤操作の復旧）", async () => {
  const a10 = admin.find("A10");
  await subA.ok("undoStart", { id: a10.id });
  await subA.until(() => subA.find("A10").status === "called");
  await subA.ok("start", { ids: [a10.id] });
  await subA.ok("end", { ids: [a10.id] });
  await subA.until(() => subA.find("A10").status === "done");
  await subA.ok("undoEnd", { id: a10.id });
  await subA.until(() => subA.find("A10").status === "playing");
  await subA.ok("end", { ids: [a10.id] });
  // 呼び出し中の回に残っている組（A11 は取消済み、A12 以降なし）を片付ける
  const callingRound = [...subA.state.rounds.values()].find((r) => r.booth === "A" && r.status !== "done");
  if (callingRound) {
    const rest = [...subA.state.res.values()].filter((r) => r.round === callingRound.id && r.status === "called");
    for (const r of rest) await subA.ok("absent", { id: r.id });
  }
});

test("スリープ復帰後（メモリから外れた古い予約）でも、検索・復元・前の番号の参照ができる", async () => {
  const d = await admin.ok("diag");
  assert.ok(d.reloadRows < 400, `復帰時の読み込み行数 ${d.reloadRows}`);
  const f = await admin.ok("find", { number: "B1" });
  assert.equal(f.res.status, "cancelled");
  assert.match(f.res.code, /^\d{4}$/);
  await admin.ok("restore", { id: f.res.id });
  await admin.until(() => admin.find("B1")?.status === "waiting");
  await admin.ok("cancel", { id: f.res.id });
  // 終了済みの A1 を前の番号として C を予約できる
  await admin.ok("diag");
  const c = await admin.ok("issue", { booth: "C", prev: "A1" });
  const v = new Viewer(srv.base);
  await v.login("A1", (await admin.ok("find", { number: "A1" })).res.code);
  await v.connect();
  assert.equal(v.last.view.number, `${c.res.booth}${c.res.num}`);
  v.close();
  await admin.ok("cancel", { id: c.res.id });
});

test("チャット：ブース別に整理され、担当外のサブ管理者には届かない／サポートは全部見える", async () => {
  await subA.ok("chat", { ch: "A", text: "Aの紙が足りません" });
  await support.until(() => support.state.chat.some((c) => c.text === "Aの紙が足りません"));
  await admin.until(() => admin.state.chat.some((c) => c.text === "Aの紙が足りません"));
  await sleep(200);
  assert.ok(!subB.state.chat.some((c) => c.text === "Aの紙が足りません"));
  const ng = await subB.send("chat", { ch: "A", text: "x" });
  assert.equal(ng.ok, false);
  await support.ok("chat", { ch: "A", text: "持っていきます" });
  await subA.until(() => subA.state.chat.some((c) => c.text === "持っていきます" && c.name === "サポ"));
});

test("対応依頼：未対応→対応中（誰が対応中か）→完了、引き継ぎは確認", async () => {
  await reception.ok("reqCreate", { booth: "A", text: "Aで迷子の相談" });
  await support.until(() => support.state.reqs.some((r) => r.text === "Aで迷子の相談"));
  const q = support.state.reqs.find((r) => r.text === "Aで迷子の相談");
  assert.equal(q.status, "open");
  await support.ok("reqTake", { id: q.id });
  await reception.until(() => reception.state.reqs.find((r) => r.id === q.id).status === "doing");
  assert.equal(reception.state.reqs.find((r) => r.id === q.id).assignee, "サポ");
  const other = await admin.send("reqTake", { id: q.id });
  assert.equal(other.confirm, true);
  await support.ok("reqDone", { id: q.id });
  await admin.until(() => admin.state.reqs.find((r) => r.id === q.id).status === "done");
});

test("お知らせ：次の回宛ては送信時点の組だけに表示され、後から来た組には出ない／表示終了", async () => {
  const x = (await admin.ok("issue", { booth: "C" })).res;
  const y = (await admin.ok("issue", { booth: "C" })).res;
  const vx = new Viewer(srv.base);
  await vx.login(lbl(x), x.code);
  await vx.connect();
  await admin.ok("boothSet", { booth: "C", capacity: 1 });
  await admin.ok("notice", { scope: "next", booth: "C", text: "次の方はCの前へ" });
  const t = Date.now();
  while (!vx.last.notices?.some((n) => n.text === "次の方はCの前へ")) {
    if (Date.now() - t > 5000) throw new Error("notice not shown");
    await sleep(20);
  }
  // x を開始・終了後、次の回になった y には古い「次の回」お知らせは出ない
  await admin.ok("start", { ids: [x.id] });
  await admin.ok("end", { ids: [x.id] });
  const vy = new Viewer(srv.base);
  await vy.login(lbl(y), y.code);
  await vy.connect();
  assert.equal(vy.last.view.phase, "next");
  assert.ok(!vy.last.notices.some((n) => n.text === "次の方はCの前へ"));
  // 終了した x にも表示されない
  await vx.untilPhase("done");
  assert.ok(!vx.last.notices.some((n) => n.text === "次の方はCの前へ"));
  // ブース全体お知らせ → 表示終了
  await subA.send("notice", { scope: "booth", booth: "C", text: "x" }).then((r) => assert.equal(r.ok, false, "担当外ブース"));
  const n = await admin.ok("notice", { scope: "booth", booth: "C", text: "Cは5分遅れています" });
  void n;
  while (!vy.last.notices.some((n) => n.text === "Cは5分遅れています")) await sleep(20);
  const nid = admin.state.notices.find((n) => n.text === "Cは5分遅れています").id;
  await admin.ok("noticeEnd", { id: nid });
  while (vy.last.notices.some((n) => n.text === "Cは5分遅れています")) await sleep(20);
  await admin.ok("boothSet", { booth: "C", capacity: 3 });
  await admin.ok("cancel", { id: y.id });
  vx.close();
  vy.close();
});

test("受付権限：並び替え・お知らせ（全体宛ても）・復元ができ、受付権限のないサブ管理者はできない", async () => {
  const x = (await reception.ok("issue", { booth: "C" })).res;
  const y = (await reception.ok("issue", { booth: "C" })).res;
  const ng = await subA.send("swap", { id: x.id, other: y.id });
  assert.equal(ng.ok, false, "受付権限なし");
  await reception.ok("swap", { id: x.id, other: y.id });
  await reception.until(() => reception.state.res.get(y.id).pos < reception.state.res.get(x.id).pos);
  const ng2 = await subA.send("notice", { scope: "all", text: "x" });
  assert.equal(ng2.ok, false);
  await reception.ok("notice", { scope: "all", text: "受付からのお知らせ" });
  const n = reception.state.notices.find((q) => q.text === "受付からのお知らせ") ?? (await reception.until(() => reception.state.notices.some((q) => q.text === "受付からのお知らせ")), reception.state.notices.find((q) => q.text === "受付からのお知らせ"));
  await reception.ok("noticeEnd", { id: n.id });
  await reception.ok("cancel", { id: x.id });
  await reception.ok("restore", { id: x.id });
  // 全体管理者だけの操作は不可
  for (const [cmd, a] of [["daySwitch", { day: 2 }], ["staffCreate", { name: "z", role: "sub", password: "zzzzzz" }], ["resetPrepare", {}], ["audit", {}]]) {
    const r = await reception.send(cmd, a);
    assert.equal(r.ok, false, cmd);
  }
  await reception.ok("cancel", { id: x.id });
  await reception.ok("cancel", { id: y.id });
});

test("人数と金額：発行時点の料金で記録、取消は集計から除外、料金変更は過去分に影響しない、集計は受付と管理者のみ", async () => {
  await admin.ok("boothSet", { booth: "C", price: 300 });
  const x = (await reception.ok("issue", { booth: "C", people: 3 })).res;
  assert.equal(x.people, 3);
  assert.equal(x.price, 300);
  const y = (await reception.ok("issue", { booth: "C", people: 2 })).res;
  const z = (await reception.ok("issue", { booth: "C", people: 4 })).res;
  await reception.ok("cancel", { id: z.id });
  await admin.ok("boothSet", { booth: "C", price: 500 });
  const w = (await reception.ok("issue", { booth: "C", people: 1 })).res;
  assert.equal(w.price, 500);
  const bad = await reception.send("issue", { booth: "C", people: 0 });
  assert.equal(bad.ok, false);
  const st = await reception.ok("stats");
  const nums = new Set([x, y, z, w].map((q) => q.num));
  const mine = st.rows.filter((r) => r.booth === "C" && r.day === x.day && nums.has(r.num));
  assert.equal(mine.length, 4);
  const valid = mine.filter((r) => r.status !== "cancelled");
  assert.equal(valid.reduce((n, r) => n + r.people, 0), 6);
  assert.equal(valid.reduce((n, r) => n + r.people * r.price, 0), 3 * 300 + 2 * 300 + 1 * 500);
  assert.ok(st.rows.every((r) => r.code === undefined), "確認コードは含めない");
  // 人数の修正
  await reception.ok("edit", { id: y.id, people: 5 });
  await reception.until(() => reception.state.res.get(y.id)?.people === 5);
  // サブ管理者（受付権限なし）は集計を見られない
  const ng = await subA.send("stats");
  assert.equal(ng.ok, false);
  for (const r of [x, y, w]) await reception.ok("cancel", { id: r.id });
  await admin.ok("boothSet", { booth: "C", price: 0 });
});

test("一時停止：参加者に一時停止中と表示し、待ち時間の目安を出さない", async () => {
  const r = (await admin.ok("issue", { booth: "C" })).res;
  const v = new Viewer(srv.base);
  await v.login(lbl(r), r.code);
  await v.connect();
  await subA.send("pause", { booth: "C", paused: true }).then((x) => assert.equal(x.ok, false));
  await admin.ok("pause", { booth: "C", paused: true, reason: "機材調整中" });
  const t = Date.now();
  while (!v.last.paused) {
    if (Date.now() - t > 5000) throw new Error("pause not shown");
    await sleep(20);
  }
  assert.equal(v.last.pauseReason, "機材調整中");
  assert.ok(v.last.view.unknown);
  assert.equal(v.last.view.from, null);
  await admin.ok("pause", { booth: "C", paused: false });
  await admin.ok("cancel", { id: r.id });
  v.close();
});

test("確認コードの連続推測：同じ番号への失敗が続くとその番号だけロック（他の番号は使える）", async () => {
  const r = (await admin.ok("issue", { booth: "C" })).res;
  const wrong = r.code === "1111" ? "2222" : "1111";
  let last;
  for (let i = 0; i < 9; i++) last = await post(srv.base, "/api/viewer", { number: lbl(r), code: wrong, device: "d" + i });
  assert.equal(last.status, 429);
  const right = await post(srv.base, "/api/viewer", { number: lbl(r), code: r.code, device: "z" });
  assert.equal(right.status, 429, "ロック中は正しいコードでも不可（スタッフが解除できる）");
  await admin.ok("unlockNumber", { number: lbl(r) });
  const ok = await post(srv.base, "/api/viewer", { number: lbl(r), code: r.code, device: "z" });
  assert.equal(ok.status, 200);
  // 他の番号は影響を受けない
  const a1 = await post(srv.base, "/api/viewer", { number: "A1", code: admin.find("A1").code, device: "q" });
  assert.equal(a1.status, 200);
  await admin.ok("cancel", { id: r.id });
});

test("通信断・再接続：切断中の操作は送れず、再接続で最新状態を受け取り、再送しても二重処理しない", async () => {
  const r = (await admin.ok("issue", { booth: "A" })).res;
  subA.close();
  await subA.until(() => subA.closed);
  // 切断中に他端末で変更
  await admin.ok("edit", { id: r.id, note: "切断中の変更" });
  // 再接続 → 最新状態
  await subA.connect();
  assert.equal(subA.find(lbl(r)).note, "切断中の変更");
  // 結果を受け取る前に切れた想定：同じ操作IDで再送しても 1 回だけ
  const op = "resend-test-1";
  await subA.ok("call", { booth: "A" }, { id: op });
  const again = await subA.send("call", { booth: "A" }, { id: op });
  assert.equal(again.ok, true);
  assert.equal(again.dup, true);
  await subA.ok("uncall", { booth: "A" });
});

test("営業日の切替：1日目のデータは残し、2日目はA201・B201・C201から採番", async () => {
  const before = admin.state.res.size;
  assert.ok(before > 0);
  const ng = await admin.send("daySwitch", { day: 2 });
  assert.equal(ng.confirm, true, "待ちの組が残っている場合は確認");
  await admin.ok("daySwitch", { day: 2, force: true });
  await subA.until(() => subA.state.activeDay === 2);
  assert.equal(subA.state.res.size, 0, "当日の待ち列は 2 日目のみ");
  const a = await admin.ok("issue", { booth: "A" });
  const b = await admin.ok("issue", { booth: "B" });
  const c = await admin.ok("issue", { booth: "C" });
  assert.deepEqual([lbl(a.res), lbl(b.res), lbl(c.res)], ["A201", "B201", "C201"]);
  // 1 日目の履歴は残っている
  const h = await admin.ok("dayHistory", { day: 1 });
  assert.ok(h.data.length >= before);
  // 1 日目の参加者が A1 で確認すると、1 日目の予約として表示される
  const v = new Viewer(srv.base);
  await v.login("A1", h.data.find((x) => lbl(x) === "A1").code);
  await v.connect();
  assert.equal(v.last.dayLabel, "1日目");
  v.close();
});

test("番号帯の重なり：1日目の番号が201以上に達しそうな場合は管理者に警告", async () => {
  await admin.ok("daySwitch", { day: 1, force: true });
  await admin.ok("counterBump", { booth: "C", next: 201 });
  const r = await admin.ok("issue", { booth: "C" });
  assert.equal(lbl(r.res), "C201");
  assert.ok(r.warnings.length > 0);
  await admin.until(() => admin.state.warnings.length > 0);
  // 番号を戻すことはできない（再利用防止）
  const ng = await admin.send("counterBump", { booth: "C", next: 5 });
  assert.equal(ng.ok, false);
  await admin.ok("cancel", { id: r.res.id });
  await admin.ok("daySwitch", { day: 2, force: true });
});

test("参加者用QRコード：合言葉が無い・古いと番号を入力できない。新しくしても表示中の参加者はそのまま。合言葉は管理者以外に渡さない", async () => {
  const info = await (await fetch(srv.base + "/api/info")).json();
  assert.equal(info.viewerKey, undefined, "公開の情報に合言葉を含めない");
  assert.equal(support.state.viewerKey, undefined, "管理者以外のスタッフには渡さない");
  const k1 = admin.state.viewerKey;
  assert.match(k1, /^[a-z0-9]{10}$/);
  assert.equal((await (await fetch(srv.base + "/api/info?k=" + k1)).json()).keyOk, true);
  const r = await admin.ok("issue", { booth: "A", people: 1 });
  const none = await post(srv.base, "/api/viewer", { number: lbl(r.res), code: r.res.code, device: "k0", key: "" });
  assert.equal(none.status, 403);
  assert.equal(none.body.oldKey, true);
  const v = new Viewer(srv.base);
  assert.equal((await v.login(lbl(r.res), r.res.code)).status, 200);
  await v.connect();
  assert.equal((await support.send("viewerKeyRotate", {})).ok, false, "管理者以外は新しくできない");
  await admin.ok("viewerKeyRotate", {});
  await admin.until(() => admin.state.viewerKey !== k1);
  assert.equal((await (await fetch(srv.base + "/api/info?k=" + k1)).json()).keyOk, false);
  const old = await post(srv.base, "/api/viewer", { number: lbl(r.res), code: r.res.code, device: "k1", key: k1 });
  assert.equal(old.status, 403);
  await sleep(500);
  assert.ok(!v.invalid && !v.closed, "表示中の参加者はそのまま見られる");
  assert.equal((await post(srv.base, "/api/viewer", { number: lbl(r.res), code: r.res.code, device: "k2" })).status, 200, "新しい合言葉なら入力できる");
  v.close();
  await admin.ok("cancel", { id: r.res.id });
});

test("ログイン中の端末数：役割名ごとの台数が管理者の画面にだけ届き、接続・切断ですぐ変わる", async () => {
  const id = [...admin.state.staff].find((x) => x.name === "Aさん").id;
  await admin.until(() => admin.state.devices?.[id] === 1);
  const second = await new Staff(srv.base, await login(srv.base, "Aさん", "sub-a-pass")).connect();
  await admin.until(() => admin.state.devices?.[id] === 2);
  assert.equal(subA.state.devices, undefined, "管理者以外には送らない");
  second.close();
  await admin.until(() => admin.state.devices?.[id] === 1);
});

test("参加者の画面の文章：管理者が書き換えると表示中の参加者にすぐ反映。{ブース}{番号}を置き換え、空欄は初期の文章。管理者以外は変更不可", async () => {
  const r = await admin.ok("issue", { booth: "B", people: 2 });
  const v = new Viewer(srv.base);
  assert.equal((await v.login(lbl(r.res), r.res.code)).status, 200);
  await v.connect();
  const last = () => v.views[v.views.length - 1].view;
  const key = last().phase; // 列が空いていれば「次の回」、そうでなければ「順番待ち」
  const def = last().headline;
  assert.ok(key === "next" || key === "waiting");
  assert.equal((await support.send("viewTextsSet", { texts: { waiting: { headline: "x" } } })).ok, false);
  await admin.ok("viewTextsSet", { texts: { [key]: { headline: "{番号}様、{ブース}でお待ちください", detail: "" } } });
  for (let i = 0; i < 100 && !/様/.test(last().headline); i++) await sleep(50);
  assert.equal(last().headline, `${lbl(r.res)}様、ブースBでお待ちください`);
  assert.match(last().detail, /まもなく呼び出します|順番が近づくと/, "空欄は初期の文章");
  assert.equal(admin.state.viewTexts[key].headline, "{番号}様、{ブース}でお待ちください");
  await admin.ok("viewTextsSet", { texts: {} });
  for (let i = 0; i < 100 && /様/.test(last().headline); i++) await sleep(50);
  assert.equal(last().headline, def, "全部消すと初期の文章に戻る");
  v.close();
  await admin.ok("cancel", { id: r.res.id });
});

test("協賛・お知らせ枠：管理者だけが登録でき、表示中は参加者向けの情報（?s=1）にだけ含まれる。不正なリンク・画像は拒否", async () => {
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  assert.equal((await support.send("sponsorSave", { text: "x" })).ok, false, "管理者以外は登録できない");
  assert.equal((await admin.send("sponsorSave", { text: "x", url: "javascript:alert(1)" })).ok, false, "http(s) 以外のリンクは拒否");
  assert.equal((await admin.send("sponsorSave", { text: "x", img: "data:text/html;base64,PHA+" })).ok, false, "画像以外は拒否");
  assert.equal((await admin.send("sponsorSave", { text: "" })).ok, false, "画像も文章も無いものは拒否");
  const r = await admin.ok("sponsorSave", { text: "○○カフェ 本日ドリンク半額", url: "https://example.com/cafe", img: PNG });
  await admin.ok("sponsorSave", { text: "次のイベントのお知らせ" });
  const info = async (q) => (await (await fetch(srv.base + "/api/info" + q)).json()).sponsors;
  assert.deepEqual(await info("?s=1"), [], "表示をオンにするまでは出さない");
  await admin.ok("sponsorEnable", { enabled: true });
  const list = await info("?s=1");
  assert.equal(list.length, 2);
  assert.equal(list[0].img, PNG);
  assert.equal(list[0].url, "https://example.com/cafe");
  assert.equal(await info(""), undefined, "スタッフ画面用の情報（?s なし）には含めない");
  await admin.until(() => admin.state.sponsors?.items.length === 2);
  assert.equal(admin.state.sponsors.items[0].img, undefined, "管理者の画面にも画像そのものは送らない（一覧のみ）");
  assert.equal(support.state.sponsors, undefined, "管理者以外のスタッフには送らない");
  await admin.ok("sponsorMove", { id: list[1].id, dir: -1 });
  assert.equal((await info("?s=1"))[0].text, "次のイベントのお知らせ");
  await admin.ok("sponsorSave", { id: r.sponsorId, text: "画像を外した", img: null });
  assert.equal((await info("?s=1")).find((x) => x.id === r.sponsorId).img, null);
  for (const x of list) await admin.ok("sponsorDelete", { id: x.id });
  await admin.ok("sponsorEnable", { enabled: false });
  assert.deepEqual(await info("?s=1"), []);
});

test("ブースを増やす：ブースDを使用中にすると D1 から発行でき、担当外の受付は発行できない。待ちがある間は停止できない", async () => {
  const admin = await new Staff(srv.base, await login(srv.base, "管理者", "admin-pass-1")).connect();
  assert.equal((await admin.send("issue", { booth: "D" })).ok, false, "使用しないブースには発行できない");
  await admin.ok("boothSet", { booth: "D", enabled: true, name: "体験コーナー", price: 0 });
  await admin.until(() => admin.state.booths.find((b) => b.id === "D")?.enabled);
  const r = await admin.ok("issue", { booth: "D", people: 2 });
  assert.equal(lbl(r.res), `D${admin.state.days.find((d) => d.id === admin.state.activeDay).starts.D}`);
  assert.equal((await admin.send("boothSet", { booth: "D", enabled: false })).ok, false);
  await admin.ok("cancel", { id: r.res.id });
  await admin.ok("boothSet", { booth: "D", enabled: false });
  admin.close();
});

test("全リセット：確認手順なし・速すぎ・管理者以外は拒否。途中では何も変わらない", async () => {
  const count = admin.state.res.size;
  const no = await admin.send("resetExecute", { ticket: "x", phrase: "すべてリセットする" });
  assert.equal(no.ok, false);
  const p = await admin.ok("resetPrepare");
  const fast = await admin.send("resetExecute", { ticket: p.ticket, phrase: "すべてリセットする" });
  assert.equal(fast.ok, false, "確認が速すぎる場合は拒否");
  // 拒否された時点で確認チケットは無効（最初からやり直し）
  await sleep(3100);
  const reuse = await admin.send("resetExecute", { ticket: p.ticket, phrase: "すべてリセットする" });
  assert.equal(reuse.ok, false);
  const sub = await subA.send("resetExecute", { ticket: p.ticket, phrase: "すべてリセットする" });
  assert.equal(sub.ok, false);
  assert.equal(admin.state.res.size, count, "途中ではデータを変更しない");
});

test("全リセット：実行後は1日目・A1から。古い参加者画面は無効、古い画面の操作は拒否、設定とアカウントは保持", async () => {
  // リセット前の状態を用意
  await admin.ok("boothSet", { booth: "A", capacity: 2, durMin: 12, durMax: 18, name: "謎A" });
  const oldA = admin.find("A201");
  const v = new Viewer(srv.base);
  await v.login("A201", oldA.code);
  await v.connect();
  const oldEpoch = admin.state.epoch;
  // 古い画面を模擬：subB は古い epoch のまま操作を送る
  const p = await admin.ok("resetPrepare");
  await sleep(3200);
  // リセットと同時に他スタッフが予約追加
  const [res, concurrent] = await Promise.all([
    admin.send("resetExecute", { ticket: p.ticket, phrase: "すべてリセットする" }),
    reception.send("issue", { booth: "B" }),
  ]);
  assert.equal(res.ok, true, JSON.stringify(res));
  await subA.until(() => subA.state.epoch === oldEpoch + 1);
  // 同時に送られた予約追加は「リセット前に処理されて消えた」か「リセット後の新データ（B1）」のどちらか。混ざらない。
  if (concurrent.ok && concurrent.res) {
    const inNew = reception.state.res.get(concurrent.res.id);
    if (inNew) assert.equal(lbl(inNew), "B1");
  }
  // 参加者の古い閲覧は無効
  const t = Date.now();
  while (!v.invalid) {
    if (Date.now() - t > 5000) throw new Error("viewer not invalidated");
    await sleep(20);
  }
  const v2 = new Viewer(srv.base);
  await v2.connect(v.token);
  assert.equal(v2.invalid, true);
  // 古い epoch での操作は拒否
  const stale = await subA.send("start", { ids: [1] }, { ep: oldEpoch });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  // 1 日目・A1 から
  assert.equal(admin.state.activeDay, 1);
  const a = await admin.ok("issue", { booth: "A" });
  assert.equal(lbl(a.res), "A1");
  const c = await admin.ok("issue", { booth: "C" });
  assert.equal(lbl(c.res), "C1");
  // 古い A201 の確認コードで新しい予約は見えない
  const old = await post(srv.base, "/api/viewer", { number: "A201", code: oldA.code, device: "qq" });
  assert.equal(old.status, 404);
  // 番号 A1 を再利用しても、以前の A1 の参加者トークンでは見えない（上で無効化済み）
  // 設定・アカウントは保持
  assert.equal(admin.state.booths.find((b) => b.id === "A").capacity, 2);
  assert.equal(admin.state.booths.find((b) => b.id === "A").name, "謎A");
  assert.ok(admin.state.staff.some((s) => s.name === "Aさん"));
  // チャット・依頼・お知らせ・履歴は空（リセット記録のみ）
  assert.equal(admin.state.chat.length, 0);
  assert.equal(admin.state.reqs.length, 0);
  assert.equal(admin.state.notices.length, 0);
  const audit = await admin.ok("audit", {});
  assert.ok(audit.data.some((x) => x.action === "全リセット"));
  assert.ok(audit.data.length <= 4);
  // スタッフはログインしたまま操作できる
  await subA.ok("start", { ids: [subA.find("A1").id] });
  v.close();
});

test("アクセス停止：停止したスタッフの端末は即座に切断され、再ログインできない", async () => {
  const id = admin.state.staff.find((s) => s.name === "Bさん").id;
  await admin.ok("staffUpdate", { id, active: false });
  await subB.until(() => subB.closed || subB.authFailed);
  const r = await post(srv.base, "/api/login", { name: "Bさん", password: "sub-b-pass" });
  assert.equal(r.status, 401);
  // 最後の管理者は停止できない
  const me = admin.state.me.id;
  const ng = await admin.send("staffUpdate", { id: me, active: false });
  assert.equal(ng.ok, false);
});

test("パスワード変更：古いパスワードでは変更できず、変更後は新しいパスワードでログイン", async () => {
  const bad = await post(srv.base, "/api/password", { old: "wrong", password: "new-pass-123" }, support.token);
  assert.equal(bad.status, 403);
  const ok = await post(srv.base, "/api/password", { old: "support-pass", password: "new-pass-123" }, support.token);
  assert.equal(ok.status, 200);
  await login(srv.base, "サポ", "new-pass-123");
});

