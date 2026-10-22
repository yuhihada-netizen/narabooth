// 待ち時間の目安などの計算ロジックの単体テスト（サーバー不要）
// Node.js の TypeScript 型除去機能で src/logic.ts を直接読み込む
import { test } from "node:test";
import assert from "node:assert/strict";
import { boothQueue, estimate, viewerView, parseNumber, overlapWarnings, defaultStart, can } from "../src/logic.ts";

const MIN = 60000;
const booth = { id: "A", name: "A", enabled: true, capacity: 3, durMin: 15, durMax: 20, paused: false, pauseReason: "", gather: "" };
let idSeq = 1;
const mk = (status, extra = {}) => ({ id: idSeq++, day: 1, booth: "A", num: idSeq, code: "0123", grp: idSeq, status, pos: idSeq, round: null, createdAt: 0, startedAt: null, endedAt: null, v: 1, note: "", by: "", ...extra });

test("進行中の回が予定を超過しても、残り時間はマイナスにならない", () => {
  const now = 100 * MIN;
  const round = { id: 1, day: 1, booth: "A", seq: 1, status: "playing", calledAt: 0, startedAt: now - 30 * MIN, endedAt: null };
  const playing = mk("playing", { round: 1 });
  const w = mk("waiting");
  const q = boothQueue(booth, [playing, w], [round]);
  const e = estimate(booth, q, w, now);
  assert.equal(e.overrun, true);
  assert.equal(e.from, now);
  assert.equal(e.to, now);
});

test("待ち時間は「前の回数 × 所要時間」の幅で計算される", () => {
  const now = 0;
  const list = Array.from({ length: 7 }, () => mk("waiting"));
  const q = boothQueue(booth, list, []);
  const e = estimate(booth, q, list[6], now); // 3 回目の回（前に 2 回）
  assert.equal(e.groupsAhead, 6);
  assert.equal(e.roundsAhead, 2);
  assert.equal(e.from, 2 * 15 * MIN);
  assert.equal(e.to, 2 * 20 * MIN);
  const v0 = viewerView(booth, q, list[0], now, true);
  assert.equal(v0.phase, "next");
  const v3 = viewerView(booth, q, list[3], now, true);
  assert.equal(v3.phase, "waiting");
  assert.equal(v3.headline, "順番待ち：ほかの場所を回っていただけます");
});

test("呼び出し中の回がある場合：呼び出し中の組は「あなたの番」、次の予定の回は「次の回」", () => {
  const rd = { id: 9, day: 1, booth: "A", seq: 1, status: "calling", calledAt: 0, startedAt: null, endedAt: null };
  const c = mk("called", { round: 9 });
  const w = mk("waiting");
  const q = boothQueue(booth, [c, w], [rd]);
  assert.equal(viewerView(booth, q, c, 0, true).headline, "あなたの番です。スタッフに画面をお見せください");
  const vw = viewerView(booth, q, w, 0, true);
  assert.equal(vw.phase, "next");
  assert.equal(vw.headline, "次の回です。ブースAの待機場所へお戻りください");
});

test("一時停止中は目安を出さず理由を示す", () => {
  const b = { ...booth, paused: true };
  const w = mk("waiting");
  const v = viewerView(b, boothQueue(b, [w], []), w, 0, true);
  assert.equal(v.from, null);
  assert.ok(v.unknown.includes("一時停止"));
  assert.equal(v.phase, "waiting");
});

test("各状態の表示文言", () => {
  const q = boothQueue(booth, [], []);
  assert.equal(viewerView(booth, q, mk("playing"), 0, true).headline, "参加中です");
  assert.equal(viewerView(booth, q, mk("done"), 0, true).headline, "ご参加ありがとうございました");
  assert.equal(viewerView(booth, q, mk("cancelled"), 0, true).headline, "この予約は取り消されました");
});

test("受付番号の入力ゆれ（全角・小文字・空白）を解釈できる", () => {
  assert.deepEqual(parseNumber("a12"), { booth: "A", num: 12 });
  assert.deepEqual(parseNumber("Ａ１２"), { booth: "A", num: 12 });
  assert.deepEqual(parseNumber(" B 201 "), { booth: "B", num: 201 });
  assert.equal(parseNumber("12"), null);
});

test("営業日の開始番号：1日目=1、2日目=201", () => {
  assert.equal(defaultStart(1), 1);
  assert.equal(defaultStart(2), 201);
  assert.equal(defaultStart(3), 401);
});

test("番号帯の重なり警告", () => {
  const days = [
    { id: 1, label: "1日目", starts: { A: 1, B: 1, C: 1 } },
    { id: 2, label: "2日目", starts: { A: 201, B: 201, C: 201 } },
  ];
  assert.equal(overlapWarnings(days, { "1:A": { min: 1, max: 150 } }).length, 0);
  assert.ok(overlapWarnings(days, { "1:A": { min: 1, max: 201 } }).length > 0);
});

test("権限：サブ管理者は担当ブースのみ、サポートは予約を変更できない", () => {
  const sub = { id: 1, name: "s", role: "sub", booths: ["A"], canIssue: false, active: true };
  const sup = { id: 2, name: "p", role: "support", booths: [], canIssue: false, active: true };
  assert.equal(can(sub, "start", "A"), true);
  assert.equal(can(sub, "start", "B"), false);
  assert.equal(can(sub, "issue", "A"), false);
  assert.equal(can(sub, "boothSet", "A"), false);
  assert.equal(can(sub, "notice", "A"), false, "受付権限がなければお知らせ不可");
  const rec = { id: 3, name: "受付", role: "support", booths: ["A", "B", "C"], canIssue: true, active: true };
  for (const c of ["issue", "cancel", "swap", "move", "edit", "restore", "reissue"]) assert.equal(can(rec, c, "B"), true, c);
  assert.equal(can(rec, "notice", null), true, "全体宛てのお知らせ");
  assert.equal(can(rec, "start", "B"), false, "サポート＋受付は開始・終了しない");
  for (const c of ["daySwitch", "staffCreate", "resetExecute", "boothSet", "audit"]) assert.equal(can(rec, c, null), false, c);
  assert.equal(can(sup, "start", "A"), false);
  assert.equal(can(sup, "chat", null), true);
  assert.equal(can(sup, "reqTake", null), true);
  assert.equal(can({ ...sub, active: false }, "chat", null), false);
});
