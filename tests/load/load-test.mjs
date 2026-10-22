// 負荷試験（手元のテスト用サーバーで実行。本番の無料枠は消費しない）
// 実行: npm run test:load
// 1 営業日分を想定より多めに再現し、操作ごとの「データ読み書き行数」「リクエスト数」を実測して、
// 本番 1 日あたりの消費量を推計する。
import { startServer, setupAdmin, login, post, Staff, Viewer, sleep } from "../helpers.mjs";

const N_RES = Number(process.env.N_RES ?? 960); // 予約件数（160組×3ブース×2倍）
const N_VIEW = Number(process.env.N_VIEW ?? 600); // 同時接続の参加者端末
const RECONNECT_ROUNDS = Number(process.env.RECONNECT ?? 3);

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))] ?? 0;
};

const srv = await startServer();
let exitCode = 0;
try {
  const admin = await new Staff(srv.base, await setupAdmin(srv.base)).connect();
  for (const b of ["A", "B", "C"]) await admin.ok("staffCreate", { name: `S${b}`, role: "sub", booths: [b], canIssue: true, password: "pass-" + b + "-123" });
  const staff = {};
  for (const b of ["A", "B", "C"]) staff[b] = await new Staff(srv.base, await login(srv.base, `S${b}`, "pass-" + b + "-123")).connect();

  async function usage() {
    await admin.ok("sync");
    await sleep(100);
    return { ...admin.state.usage };
  }
  const phases = [];
  async function phase(name, fn) {
    const u0 = await usage();
    const s = Date.now();
    const extra = await fn();
    const u1 = await usage();
    const d = { name, ms: Date.now() - s, req: u1.req - u0.req, wsIn: u1.wsIn - u0.wsIn, rr: u1.rr - u0.rr, rw: u1.rw - u0.rw, ...extra };
    phases.push(d);
    log(name, JSON.stringify(d));
    return d;
  }

  // ---- A: 予約発行（3 端末から同時） ----
  const lat = [];
  const timed = async (c, cmd, a) => {
    const s = Date.now();
    const r = await c.ok(cmd, a);
    lat.push(Date.now() - s);
    return r;
  };
  const issued = [];
  await phase("A 予約発行", async () => {
    const per = Math.ceil(N_RES / 3);
    await Promise.all(
      ["A", "B", "C"].map(async (b) => {
        for (let i = 0; i < per; i++) issued.push((await timed(staff[b], "issue", { booth: b })).res);
      }),
    );
    return { count: issued.length, opLatencyP50: pct(lat, 50), opLatencyP95: pct(lat, 95) };
  });
  // 番号の重複チェック
  for (const b of ["A", "B", "C"]) {
    const nums = issued.filter((r) => r.booth === b).map((r) => r.num).sort((x, y) => x - y);
    if (new Set(nums).size !== nums.length || nums[0] !== 1 || nums[nums.length - 1] !== nums.length) throw new Error("番号の重複・欠番 " + b);
  }

  // ---- B: 参加者のログインと同時接続 ----
  const viewers = [];
  let viewerBytes = 0;
  await phase("B 参加者ログイン＋同時接続", async () => {
    const targets = issued.slice(0, N_VIEW);
    for (let i = 0; i < targets.length; i += 50) {
      await Promise.all(
        targets.slice(i, i + 50).map(async (r) => {
          const v = new Viewer(srv.base);
          const lr = await v.login(`${r.booth}${r.num}`, r.code);
          if (lr.status !== 200) throw new Error("viewer login " + JSON.stringify(lr));
          await v.connect();
          v.ws.addEventListener("message", (e) => (viewerBytes += e.data.length));
          viewers.push(v);
        }),
      );
    }
    return { viewers: viewers.length };
  });

  // ---- C: 回の運営（各組を 1 組ずつ開始・終了＝ボタン操作が最も多い場合） ----
  lat.length = 0;
  viewerBytes = 0;
  let ops = 0;
  await phase("C 回の運営（呼び出し・個別開始・個別終了）", async () => {
    await Promise.all(
      ["A", "B", "C"].map(async (b) => {
        const c = staff[b];
        for (;;) {
          const waiting = [...c.state.res.values()].filter((r) => r.booth === b && r.status === "waiting");
          if (!waiting.length) break;
          await timed(c, "call", { booth: b });
          ops++;
          await c.until(() => [...c.state.res.values()].some((r) => r.booth === b && r.status === "called"));
          const called = [...c.state.res.values()].filter((r) => r.booth === b && r.status === "called");
          for (const r of called) {
            await timed(c, "start", { ids: [r.id], force: true });
            ops++;
          }
          for (const r of called) {
            await timed(c, "end", { ids: [r.id] });
            ops++;
          }
        }
      }),
    );
    return { ops, opLatencyP50: pct(lat, 50), opLatencyP95: pct(lat, 95), opLatencyMax: Math.max(...lat), viewerKBReceived: Math.round(viewerBytes / 1024) };
  });
  const allDone = [...admin.state.res.values()].every((r) => r.status === "done");
  if (!allDone) throw new Error("終了していない予約があります");

  // ---- D: 再接続の嵐（全端末が画面を開き直す） ----
  await phase(`D 参加者の再接続 ×${RECONNECT_ROUNDS}`, async () => {
    let n = 0;
    for (let k = 0; k < RECONNECT_ROUNDS; k++) {
      for (let i = 0; i < viewers.length; i += 100) {
        await Promise.all(
          viewers.slice(i, i + 100).map(async (v) => {
            v.close();
            v.views = [];
            await v.connect();
            n++;
          }),
        );
      }
    }
    return { reconnects: n };
  });

  // ---- E: チャット・お知らせ・対応依頼 ----
  await phase("E チャット300・お知らせ30・対応依頼30", async () => {
    for (let i = 0; i < 300; i++) await staff[["A", "B", "C"][i % 3]].ok("chat", { ch: ["A", "B", "C"][i % 3], text: "負荷試験メッセージ " + i });
    for (let i = 0; i < 30; i++) await admin.ok("notice", { scope: "all", text: "お知らせ " + i, expiresMin: 5 });
    for (let i = 0; i < 30; i++) {
      await staff.A.ok("reqCreate", { booth: "A", text: "依頼 " + i });
    }
    for (const q of admin.state.reqs) {
      await admin.ok("reqTake", { id: q.id });
      await admin.ok("reqDone", { id: q.id });
    }
    return {};
  });

  // ---- G: スリープ復帰時の読み込み量・スタッフ画面の接続コスト ----
  let reloadRows = 0;
  await phase("G スリープ復帰の読み込み・スタッフ接続×20", async () => {
    const d = await admin.ok("diag");
    reloadRows = d.reloadRows;
    const u0 = await usage();
    const cs = [];
    for (let i = 0; i < 20; i++) cs.push(await new Staff(srv.base, staff.A.token).connect());
    const u1 = await usage();
    for (const c of cs) c.close();
    return { reloadRows, inMemory: d.inMemory, staffConnectRows: (u1.rr - u0.rr) / 20 };
  });

  // ---- F: 全リセット（大量データでも完了するか） ----
  await phase("F 全リセット", async () => {
    const p = await admin.ok("resetPrepare");
    await sleep(2600);
    const r = await admin.ok("resetExecute", { ticket: p.ticket, phrase: "すべてリセットする" });
    await admin.until(() => admin.state.epoch === r.epoch);
    await sleep(300);
    const invalid = viewers.filter((v) => v.invalid).length;
    const a = await admin.ok("issue", { booth: "A" });
    return { viewersInvalidated: invalid, firstNumberAfterReset: `${a.res.booth}${a.res.num}` };
  });

  // ---- 推計 ----
  const P = Object.fromEntries(phases.map((p) => [p.name[0], p]));
  const perIssue = { rw: P.A.rw / N_RES, rr: P.A.rr / N_RES };
  const perOp = { rw: P.C.rw / P.C.ops, rr: P.C.rr / P.C.ops };
  const opsPerRes = P.C.ops / N_RES;
  const perLogin = { rw: P.B.rw / P.B.viewers, rr: P.B.rr / P.B.viewers };
  const perReconnect = { rw: P.D.rw / P.D.reconnects, rr: P.D.rr / P.D.reconnects };
  const perChat = { rw: P.E.rw / 420, rr: P.E.rr / 420 };
  const staffConnectRows = P.G.staffConnectRows;
  const scenario = (name, s) => {
    const workerReq = s.logins + s.viewerConnects + s.staffConnects + s.misc;
    const doReq = workerReq + s.res * (1 + opsPerRes) + s.chat + s.alarms;
    const rw = s.res * (perIssue.rw + opsPerRes * perOp.rw) + s.logins * perLogin.rw + s.viewerConnects * perReconnect.rw + s.chat * perChat.rw + s.alarms + s.staffLogins * 2;
    const rr = s.res * (perIssue.rr + opsPerRes * perOp.rr) + s.logins * perLogin.rr + s.viewerConnects * perReconnect.rr + s.chat * perChat.rr + s.staffConnects * staffConnectRows + s.wakes * reloadRows;
    return { name, workerReq: Math.round(workerReq), doReq: Math.round(doReq), rowsWritten: Math.round(rw), rowsRead: Math.round(rr) };
  };
  const scenarios = [
    // 想定：160組/日、全組が3ブース、1組平均2台のスマホ、1台20回の再接続
    scenario("想定（160組×3ブース）", { res: 480, logins: 480, viewerConnects: 320 * 20, staffConnects: 10 * 50, staffLogins: 10, chat: 300, alarms: 720, wakes: 1000, misc: 500 }),
    // 余裕：予約2倍・スマホ2倍・再接続2倍・チャット3倍・スタッフ2倍・アラーム24時間分
    scenario("余裕（想定の2〜3倍）", { res: 960, logins: 960, viewerConnects: 640 * 40, staffConnects: 20 * 100, staffLogins: 20, chat: 1000, alarms: 1440, wakes: 2600, misc: 1000 }),
  ];
  const free = { workerReq: 100000, doReq: 100000, rowsWritten: 100000, rowsRead: 5000000 };
  console.log("\n===== 実測（1単位あたり） =====");
  console.log(JSON.stringify({ perIssue, perOp, opsPerRes, perLogin, perReconnect, perChatOrNotice: perChat, staffConnectRows, reloadRows }, null, 1));
  console.log("\n===== 推計（本番1日あたり） =====");
  console.log("| ケース | Workerリクエスト | DOリクエスト | 書き込み行 | 読み取り行 |");
  console.log("|---|---|---|---|---|");
  for (const s of scenarios) {
    const f = (k) => `${s[k].toLocaleString()}（${((s[k] / free[k]) * 100).toFixed(1)}%）`;
    console.log(`| ${s.name} | ${f("workerReq")} | ${f("doReq")} | ${f("rowsWritten")} | ${f("rowsRead")} |`);
  }
  console.log("\nRESULT_JSON " + JSON.stringify({ phases, scenarios }));
  for (const v of viewers) v.close();
  for (const c of [admin, ...Object.values(staff)]) c.close();
} catch (e) {
  console.error("負荷試験の失敗:", e);
  exitCode = 1;
} finally {
  await srv.stop();
  log("finished");
  process.exit(exitCode);
}
