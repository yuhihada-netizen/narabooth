// イベント全体を管理する Durable Object（SQLite）。
// ・すべての操作はこのオブジェクト 1 個の中で順番に処理される（同時操作でも番号重複・二重開始が起きない）。
// ・変更は transactionSync でまとめて保存し、失敗したら全体を取り消す（中途半端な状態を残さない）。
// ・画面更新は WebSocket（Hibernation API）で変更があった時だけ送る。毎秒の全件取得はしない。
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import {
  ACTIVE_STATUSES,
  BOOTH_IDS,
  MIN,
  boothQueue,
  can,
  defaultStart,
  label,
  newCode,
  overlapWarnings,
  parseNumber,
  viewerView,
  type Booth,
  type Cmd,
  type DayInfo,
  type Res,
  type ResStatus,
  type Role,
  type Round,
  type Staff,
  VIEW_TEXT_DEFAULTS,
  VIEW_TEXT_MAX,
  type ViewTexts,
  type ViewTextKey,
} from "./logic";
import { hashPassword, randomToken, sha256, timingSafeEqual, verifyPassword } from "./crypto";

interface StaffRow extends Staff {
  pw: string;
  gen: number;
}
interface Notice {
  id: number;
  day: number;
  scope: "all" | "booth" | "calling" | "next" | "res";
  booth: string | null;
  targets: number[] | null;
  text: string;
  at: number;
  by: string;
  endedAt: number | null;
  expiresAt: number | null;
}
interface Req {
  id: number;
  booth: string | null;
  text: string;
  status: "open" | "doing" | "done";
  by: string;
  assignee: string | null;
  createdAt: number;
  updatedAt: number;
}
interface Chat {
  id: number;
  ch: string;
  name: string;
  role: string;
  text: string;
  at: number;
}
type Att =
  | { k: "s"; sid: number; gen: number; ep: number; adm?: boolean }
  | { k: "v"; vh: string; grp: number; day: number; ep: number };

class CmdError extends Error {
  constructor(
    msg: string,
    public confirm = false,
  ) {
    super(msg);
  }
}

const HEARTBEAT_MS = 60_000;
const SESSION_DAYS = 7;
const MAX_TEXT = 500;
const DEFAULT_EVENT_NAME = "受付・順番待ち";
const WEAK_SETUP_TOKENS = ["change-me-local-only", "my-secret", "password", "setup_token", "changeme", "change-me"];
// 協賛・お知らせ枠
interface SponsorMeta {
  enabled: boolean;
  items: { id: string; text: string; url: string; hasImg: boolean }[];
}
const SPONSOR_MAX = 5;
const SPONSOR_TEXT_MAX = 80;
const SPONSOR_IMG_MAX = 200_000; // data URL の文字数（画面側で約 140KB 以下に縮小して送る）
const SPONSOR_IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const DEFAULT_TEMPLATES = [
  "ブース{booth}は現在少し遅れています。ご迷惑をおかけします。",
  "次の回の方は、ブース{booth}の待機場所へお越しください。",
  "ブース{booth}は一時的に受付を停止しています。再開までお待ちください。",
  "呼び出し中です。ブース{booth}のスタッフにお声がけください。",
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS booths (id TEXT PRIMARY KEY, name TEXT, enabled INT, capacity INT, dur_min INT, dur_max INT, paused INT, pause_reason TEXT, gather TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS days (id INTEGER PRIMARY KEY, label TEXT, starts TEXT);
CREATE TABLE IF NOT EXISTS counters (day INT, booth TEXT, next INT, PRIMARY KEY (day, booth)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS staff (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, role TEXT, booths TEXT, can_issue INT, pw TEXT, active INT, gen INT, created_at INT);
CREATE TABLE IF NOT EXISTS sessions (h TEXT PRIMARY KEY, staff_id INT, created_at INT, expires_at INT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS res (id INTEGER PRIMARY KEY AUTOINCREMENT, day INT, booth TEXT, num INT, code TEXT, grp INT, status TEXT, pos REAL, round INT, created_at INT, started_at INT, ended_at INT, v INT, note TEXT, by_name TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS res_num ON res (day, booth, num);
CREATE INDEX IF NOT EXISTS res_grp ON res (grp);
CREATE INDEX IF NOT EXISTS res_active ON res (day) WHERE status IN ('waiting','called','playing','absent');
CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, day INT, booth TEXT, seq INT, status TEXT, called_at INT, started_at INT, ended_at INT);
CREATE INDEX IF NOT EXISTS rounds_active ON rounds (day) WHERE status != 'done';
CREATE TABLE IF NOT EXISTS viewers (h TEXT PRIMARY KEY, grp INT, day INT, ep INT, created_at INT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY AUTOINCREMENT, day INT, scope TEXT, booth TEXT, targets TEXT, text TEXT, at INT, by_name TEXT, ended_at INT, expires_at INT);
CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, ch TEXT, name TEXT, role TEXT, text TEXT, at INT);
CREATE INDEX IF NOT EXISTS chat_ch ON chat (ch);
CREATE TABLE IF NOT EXISTS reqs (id INTEGER PRIMARY KEY AUTOINCREMENT, booth TEXT, text TEXT, status TEXT, by_name TEXT, assignee TEXT, created_at INT, updated_at INT);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT, at INT, staff TEXT, action TEXT, target TEXT, before TEXT, after TEXT);
CREATE INDEX IF NOT EXISTS audit_op ON audit (op);
`;

// メモリ上だけの回数制限（確認コードの連続推測・ログイン連続試行対策）
class Limiter {
  private m = new Map<string, { n: number; until: number }>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  blocked(key: string, now: number): boolean {
    const e = this.m.get(key);
    if (!e) return false;
    if (e.until < now) {
      this.m.delete(key);
      return false;
    }
    return e.n >= this.max;
  }
  fail(key: string, now: number): void {
    const e = this.m.get(key);
    if (!e || e.until < now) this.m.set(key, { n: 1, until: now + this.windowMs });
    else e.n++;
    if (this.m.size > 5000) for (const [k, v] of this.m) if (v.until < now) this.m.delete(k);
  }
  clear(key: string): void {
    this.m.delete(key);
  }
}

export class EventDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private loaded = false;
  private writes = 0;
  // ---- メモリ上の状態（起動・復帰時に SQLite から読み込む） ----
  private epoch = 1;
  private activeDay = 1;
  private eventName = DEFAULT_EVENT_NAME;
  // 参加者用QRコードの「合言葉」。管理者が新しくすると、古いQRコードからは番号を入力できなくなる
  private viewerKey = "";
  private booths = new Map<string, Booth>();
  private days: DayInfo[] = [];
  private counters = new Map<string, number>(); // `${day}:${booth}` -> 次の番号
  private used: Record<string, { min: number; max: number }> = {};
  private res = new Map<number, Res>(); // 営業中の日の予約（全状態）
  private rounds = new Map<number, Round>(); // 営業中の日の回
  private staff = new Map<number, StaffRow>();
  private notices: Notice[] = [];
  private reqs: Req[] = [];
  private templates: string[] = DEFAULT_TEMPLATES;
  // 参加者の画面の「協賛・お知らせ枠」（主催者が登録。スタッフの画面には出さない）
  private sponsors: SponsorMeta = { enabled: false, items: [] };
  private sponsorImgs = new Map<string, string>(); // id → 画像（data URL）
  private viewTexts: ViewTexts = {}; // 参加者の画面の文章（管理者が書き換えた分だけ。空なら初期の文章）
  private grpCache = new Map<number, Res[]>(); // 組ごとの予約（参加者画面用のキャッシュ）
  private seqMax = new Map<string, number>(); // ブースごとの回の最大番号
  // ---- 処理中の変更（送信用） ----
  private dirty = { res: new Set<number>(), rounds: new Set<number>(), booths: false, notices: false, reqs: false, staff: false, days: false, chat: [] as Chat[], deletedRounds: new Set<number>(), boothIds: new Set<string>() };
  // ---- 重複送信の検出 ----
  private opCache = new Map<string, unknown>();
  // ---- 回数制限 ----
  private lim = {
    vIp: new Limiter(60, 10 * MIN),
    vDev: new Limiter(15, 10 * MIN),
    vNum: new Limiter(8, 10 * MIN),
    sName: new Limiter(5, 5 * MIN),
    sIp: new Limiter(30, 10 * MIN),
  };
  private resetTickets = new Map<number, { t: string; at: number }>();
  private viewCache = new WeakMap<WebSocket, string>();
  // ---- 使用量の計測（本システム分のみ） ----
  private usage = { day: "", req: 0, rr: 0, rw: 0, wsIn: 0, alarm: 0, savedAt: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA);
      // 後から追加した列（既存のデータを残したまま追加する）
      const cols = (t: string) => this.sql.exec(`PRAGMA table_info(${t})`).toArray().map((r: any) => r.name as string);
      const resCols = cols("res");
      if (!resCols.includes("people")) this.sql.exec("ALTER TABLE res ADD COLUMN people INT");
      if (!resCols.includes("price")) this.sql.exec("ALTER TABLE res ADD COLUMN price INT");
      if (!cols("booths").includes("price")) this.sql.exec("ALTER TABLE booths ADD COLUMN price INT DEFAULT 0");
    });
  }

  // ================= SQL ヘルパー（読み書き行数を計測） =================
  private all<T = Record<string, SqlStorageValue>>(q: string, ...p: unknown[]): T[] {
    const c = this.sql.exec(q, ...(p as SqlStorageValue[]));
    const rows = c.toArray();
    this.usage.rr += c.rowsRead;
    this.usage.rw += c.rowsWritten;
    this.writes += c.rowsWritten;
    return rows as T[];
  }
  private one<T = Record<string, SqlStorageValue>>(q: string, ...p: unknown[]): T | null {
    return this.all<T>(q, ...p)[0] ?? null;
  }
  private kvGet(k: string): string | null {
    return this.one<{ v: string }>("SELECT v FROM kv WHERE k=?", k)?.v ?? null;
  }
  private kvSet(k: string, v: string): void {
    this.all("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, v);
  }
  private countReq(kind: "req" | "wsIn" | "alarm" = "req"): void {
    const d = new Date().toISOString().slice(0, 10);
    if (this.usage.day !== d) {
      if (this.usage.day) this.persistUsage(true);
      const saved = this.loadUsage(d);
      this.usage = saved;
    }
    this.usage[kind]++;
  }
  private loadUsage(d: string): typeof this.usage {
    const raw = this.one<{ v: string }>("SELECT v FROM kv WHERE k=?", "usage:" + d)?.v;
    const base = { day: d, req: 0, rr: 0, rw: 0, wsIn: 0, alarm: 0, savedAt: Date.now() };
    if (raw) Object.assign(base, JSON.parse(raw), { day: d, savedAt: Date.now() });
    return base;
  }
  private persistUsage(force = false): void {
    if (!this.usage.day) return;
    if (!force && Date.now() - this.usage.savedAt < 10 * MIN) return;
    this.usage.savedAt = Date.now();
    const { savedAt: _s, ...rest } = this.usage;
    this.kvSet("usage:" + this.usage.day, JSON.stringify(rest));
  }

  // ================= 読み込み =================
  private ensureLoaded(): void {
    if (this.loaded) return;
    // 初期設定（初回のみ）
    if (!this.kvGet("epoch")) {
      this.ctx.storage.transactionSync(() => {
        this.kvSet("epoch", "1");
        this.kvSet("activeDay", "1");
        for (const id of BOOTH_IDS) {
          this.all(
            "INSERT OR IGNORE INTO booths (id, name, enabled, capacity, dur_min, dur_max, paused, pause_reason, gather) VALUES (?, ?, ?, 3, 15, 20, 0, '', ?)",
            id,
            id,
            id === "A" ? 1 : 0,
            `ブース${id}の前の待機場所`,
          );
        }
        this.ensureDay(1); // 2日目以降は「営業日を追加」で増やす
      });
    }
    this.epoch = Number(this.kvGet("epoch") ?? 1);
    this.activeDay = Number(this.kvGet("activeDay") ?? 1);
    this.eventName = this.kvGet("eventName") ?? DEFAULT_EVENT_NAME;
    this.viewerKey = this.kvGet("viewerKey") ?? "";
    if (!this.viewerKey) {
      this.viewerKey = newViewerKey();
      this.kvSet("viewerKey", this.viewerKey);
    }
    const t = this.kvGet("templates");
    this.templates = t ? JSON.parse(t) : DEFAULT_TEMPLATES;
    const sp = this.kvGet("sponsors");
    this.sponsors = sp ? JSON.parse(sp) : { enabled: false, items: [] };
    this.sponsorImgs.clear();
    for (const it of this.sponsors.items) {
      if (!it.hasImg) continue;
      const img = this.kvGet("sponsorImg:" + it.id);
      if (img) this.sponsorImgs.set(it.id, img);
    }
    const vt = this.kvGet("viewTexts");
    this.viewTexts = vt ? JSON.parse(vt) : {};
    this.booths.clear();
    for (const b of this.all<any>("SELECT * FROM booths ORDER BY id")) {
      this.booths.set(b.id, {
        id: b.id,
        name: b.name,
        enabled: !!b.enabled,
        capacity: b.capacity,
        durMin: b.dur_min,
        durMax: b.dur_max,
        paused: !!b.paused,
        pauseReason: b.pause_reason ?? "",
        gather: b.gather ?? "",
        price: Number(b.price ?? 0),
      });
    }
    this.days = this.all<any>("SELECT * FROM days ORDER BY id").map((d) => ({ id: d.id, label: d.label, starts: JSON.parse(d.starts) }));
    this.counters.clear();
    for (const c of this.all<any>("SELECT * FROM counters")) this.counters.set(`${c.day}:${c.booth}`, c.next);
    this.computeUsed();
    // 復帰時の読み込みを軽くするため（無料枠の節約）、当日の「有効な予約」と「最近の終了・取消」だけを読み込む。
    // それ以外の予約は必要になった時に1件ずつ読み込む。
    this.res.clear();
    this.grpCache.clear();
    this.seqMax.clear();
    for (const r of this.all<any>("SELECT * FROM res INDEXED BY res_active WHERE day=? AND status IN ('waiting','called','playing','absent')", this.activeDay)) this.res.set(r.id, rowToRes(r));
    for (const r of this.all<any>("SELECT * FROM res NOT INDEXED WHERE day=? ORDER BY id DESC LIMIT 60", this.activeDay)) if (!this.res.has(r.id)) this.res.set(r.id, rowToRes(r));
    this.rounds.clear();
    for (const r of this.all<any>("SELECT * FROM rounds INDEXED BY rounds_active WHERE day=? AND status != 'done'", this.activeDay)) this.rounds.set(r.id, rowToRound(r));
    this.staff.clear();
    for (const s of this.all<any>("SELECT * FROM staff")) this.staff.set(s.id, rowToStaff(s));
    this.notices = this.all<any>("SELECT * FROM notices ORDER BY id DESC LIMIT 100").map(rowToNotice).filter((n) => n.endedAt === null || n.at > Date.now() - 6 * 60 * MIN).reverse();
    this.reqs = this.all<any>("SELECT * FROM reqs ORDER BY id DESC LIMIT 200").map(rowToReq).reverse();
    this.loaded = true;
  }

  // 発行済み番号の範囲（カウンターと開始番号から求める＝予約表を読まない）
  private computeUsed(): void {
    this.used = {};
    for (const d of this.days)
      for (const b of BOOTH_IDS) {
        const st = d.starts[b] ?? 1;
        const next = this.counters.get(`${d.id}:${b}`) ?? st;
        if (next > st) this.used[`${d.id}:${b}`] = { min: st, max: next - 1 };
      }
  }

  private ensureDay(d: number): DayInfo {
    let day = this.days.find((x) => x.id === d);
    if (day) return day;
    const row = this.one<any>("SELECT * FROM days WHERE id=?", d);
    if (row) day = { id: row.id, label: row.label, starts: JSON.parse(row.starts) };
    else {
      const starts: Record<string, number> = {};
      for (const b of BOOTH_IDS) starts[b] = defaultStart(d);
      day = { id: d, label: `${d}日目`, starts };
      this.all("INSERT INTO days (id, label, starts) VALUES (?, ?, ?)", d, day.label, JSON.stringify(starts));
      for (const b of BOOTH_IDS) {
        this.all("INSERT OR IGNORE INTO counters (day, booth, next) VALUES (?, ?, ?)", d, b, starts[b]);
        this.counters.set(`${d}:${b}`, starts[b]);
      }
    }
    this.days.push(day);
    this.days.sort((a, b) => a.id - b.id);
    return day;
  }

  // ================= HTTP =================
  async fetch(request: Request): Promise<Response> {
    this.countReq();
    const url = new URL(request.url);
    try {
      this.ensureLoaded();
      if (url.pathname === "/ws") return await this.handleWs(request);
      const ip = request.headers.get("CF-Connecting-IP") ?? "local";
      switch (url.pathname) {
        case "/api/info":
          // 公開の情報（イベント名など）。スタッフ用アプリが登録時に確認できるよう、他の場所からの読み取りも許可する
          return withCors(json({
            env: this.env.ENV_LABEL ?? "",
            needsSetup: this.staff.size === 0,
            eventName: this.eventName,
            // 参加者画面が持っているQRコードの合言葉が今も使えるか（合言葉そのものは返さない）
            keyOk: url.searchParams.has("k") ? timingSafeEqual(url.searchParams.get("k") ?? "", this.viewerKey) : undefined,
            booths: [...this.booths.values()].map((b) => ({ id: b.id, name: b.name, enabled: b.enabled })),
            // 協賛・お知らせ枠は参加者の画面からの要求（?s=1）にだけ付ける（スタッフ画面では読み込まない）
            sponsors: url.searchParams.get("s") === "1" ? this.sponsorsOut() : undefined,
          }));
        case "/api/setup":
          return await this.apiSetup(request);
        case "/api/login":
          return await this.apiLogin(request, ip);
        case "/api/logout":
          return await this.apiLogout(request);
        case "/api/password":
          return await this.apiPassword(request);
        case "/api/viewer":
          return await this.apiViewer(request, ip);
        case "/api/export":
          return await this.apiExport(request, url);
      }
      return json({ error: "見つかりません" }, 404);
    } catch (e) {
      console.error(e);
      this.loaded = false;
      return json({ error: "サーバー内部でエラーが発生しました。もう一度お試しください。" }, 500);
    }
  }

  private async body(request: Request): Promise<any> {
    if (request.method !== "POST") throw new CmdError("POST で送信してください");
    try {
      return await request.json();
    } catch {
      throw new CmdError("送信内容を読み取れませんでした");
    }
  }

  private async apiSetup(request: Request): Promise<Response> {
    const b = await this.body(request).catch((e) => ({ __err: e.message }));
    if (b.__err) return json({ error: b.__err }, 400);
    if (this.staff.size > 0) return json({ error: "初期設定はすでに完了しています。管理者でログインしてください。" }, 409);
    // 入力のずれ（前後の空白・全角文字）で合わなくならないよう、両方をそろえてから比べる
    const normTok = (v: unknown) => String(v ?? "").normalize("NFKC").trim();
    const tok = normTok(this.env.SETUP_TOKEN);
    if (!tok) return json({ error: "サーバーに初期設定用の合言葉（SETUP_TOKEN）が登録されていません。Cloudflare の Worker の「Settings」→「Variables and Secrets」で登録してください。" }, 400);
    // 短すぎる・見本のままの合言葉では初期設定できない（誰でも管理者を作れてしまうため）
    if (tok.length < 12 || WEAK_SETUP_TOKENS.includes(tok.toLowerCase())) {
      return json({ error: "初期設定用の合言葉（SETUP_TOKEN）が短すぎるか、見本のままです。Cloudflare の Worker の「Settings」→「Variables and Secrets」で、12文字以上の推測されにくい合言葉に変えてから、もう一度お試しください。" }, 400);
    }
    if (!timingSafeEqual(normTok(b.token), tok)) {
      await sleep(800);
      return json({ error: "初期設定用の合言葉が違います" }, 403);
    }
    const name = cleanName(b.name);
    const pwErr = checkPassword(b.password);
    if (!name) return json({ error: "役割名を入力してください" }, 400);
    if (pwErr) return json({ error: pwErr }, 400);
    const eventName = cleanText(b.eventName, 40);
    const boothCount = clampInt(b.boothCount, 1, BOOTH_IDS.length, 1);
    const pw = await hashPassword(b.password);
    if (this.staff.size > 0) return json({ error: "初期設定はすでに完了しています" }, 409);
    this.ctx.storage.transactionSync(() => {
      if (eventName) {
        this.eventName = eventName;
        this.kvSet("eventName", eventName);
      }
      // 使うブースの数（A から順に使用中にする。後から「管理」→ ブース設定で変更できる）
      BOOTH_IDS.forEach((id, i) => {
        const bo = this.booths.get(id);
        if (bo) {
          bo.enabled = i < boothCount;
          this.saveBooth(bo);
        }
      });
      const r = this.one<any>(
        "INSERT INTO staff (name, role, booths, can_issue, pw, active, gen, created_at) VALUES (?, 'admin', '[]', 1, ?, 1, 1, ?) RETURNING *",
        name,
        pw,
        Date.now(),
      );
      this.staff.set(r.id, rowToStaff(r));
      this.audit(null, "system", "初期管理者を作成", name, null, null);
    });
    return json({ ok: true });
  }

  private async apiLogin(request: Request, ip: string): Promise<Response> {
    const b = await this.body(request).catch((e) => ({ __err: e.message }));
    if (b.__err) return json({ error: b.__err }, 400);
    const now = Date.now();
    const name = cleanName(b.name);
    if (this.lim.sIp.blocked(ip, now) || this.lim.sName.blocked(name, now)) {
      return json({ error: "ログインの失敗が続いたため、しばらく（5〜10分）お待ちください。急ぐ場合は管理者に連絡してください。" }, 429);
    }
    const s = [...this.staff.values()].find((x) => x.name === name);
    const ok = s && s.active ? await verifyPassword(String(b.password ?? ""), s.pw) : false;
    if (!s || !ok) {
      this.lim.sIp.fail(ip, now);
      this.lim.sName.fail(name, now);
      await sleep(500);
      return json({ error: s && !s.active ? "このアカウントは停止されています" : "役割名またはパスワードが違います" }, 401);
    }
    this.lim.sName.clear(name);
    const token = randomToken();
    const h = await sha256(token);
    this.all("INSERT INTO sessions (h, staff_id, created_at, expires_at) VALUES (?, ?, ?, ?)", h, s.id, now, now + SESSION_DAYS * 24 * 60 * MIN);
    // 期限切れのセッションを掃除
    this.all("DELETE FROM sessions WHERE expires_at < ?", now);
    return json({ token, staff: publicStaff(s) });
  }

  private async authBearer(request: Request): Promise<StaffRow | null> {
    const m = /^Bearer\s+(.+)$/.exec(request.headers.get("Authorization") ?? "");
    if (!m) return null;
    return this.staffFromToken(m[1]);
  }
  private async staffFromToken(token: string): Promise<StaffRow | null> {
    const h = await sha256(token);
    const row = this.one<any>("SELECT staff_id, expires_at FROM sessions WHERE h=?", h);
    if (!row || row.expires_at < Date.now()) return null;
    const s = this.staff.get(row.staff_id);
    return s && s.active ? s : null;
  }

  private async apiLogout(request: Request): Promise<Response> {
    const m = /^Bearer\s+(.+)$/.exec(request.headers.get("Authorization") ?? "");
    if (m) this.all("DELETE FROM sessions WHERE h=?", await sha256(m[1]));
    return json({ ok: true });
  }

  private async apiPassword(request: Request): Promise<Response> {
    const s = await this.authBearer(request);
    if (!s) return json({ error: "ログインし直してください" }, 401);
    const b = await this.body(request).catch((e) => ({ __err: e.message }));
    if (b.__err) return json({ error: b.__err }, 400);
    if (!(await verifyPassword(String(b.old ?? ""), s.pw))) return json({ error: "現在のパスワードが違います" }, 403);
    const err = checkPassword(b.password);
    if (err) return json({ error: err }, 400);
    const pw = await hashPassword(b.password);
    this.ctx.storage.transactionSync(() => {
      this.all("UPDATE staff SET pw=? WHERE id=?", pw, s.id);
      s.pw = pw;
      this.audit(null, s.name, "パスワード変更", s.name, null, null);
    });
    return json({ ok: true });
  }

  // 参加者：受付番号＋確認コードで閲覧用トークンを発行
  private async apiViewer(request: Request, ip: string): Promise<Response> {
    const b = await this.body(request).catch((e) => ({ __err: e.message }));
    if (b.__err) return json({ error: b.__err }, 400);
    const now = Date.now();
    if (!timingSafeEqual(String(b.key ?? ""), this.viewerKey)) {
      return json({ error: "このQRコードは現在使えません。会場に掲示されている新しいQRコードを読み取ってください。", oldKey: true }, 403);
    }
    const dev = String(b.device ?? "").slice(0, 64) || "none";
    const parsed = parseNumber(b.number);
    const code = String(b.code ?? "").normalize("NFKC").replace(/\s/g, "");
    if (!parsed || !/^\d{4}$/.test(code)) return json({ error: "受付番号（例：A12）と4桁の確認コードを入力してください" }, 400);
    const numKey = `${parsed.booth}${parsed.num}`;
    if (this.lim.vNum.blocked(numKey, now)) {
      return json({ error: "この番号は入力の失敗が続いたため、10分ほど確認できません。スタッフにお声がけください。" }, 429);
    }
    if (this.lim.vIp.blocked(ip, now) || this.lim.vDev.blocked(dev, now)) {
      return json({ error: "入力の失敗が続いたため、しばらくお待ちください。スタッフにお声がけいただくこともできます。" }, 429);
    }
    // 営業中の日を優先し、無ければ他の日を新しい順に探す
    let row: any = null;
    const dayOrder = [this.activeDay, ...this.days.map((d) => d.id).filter((d) => d !== this.activeDay).sort((a, b) => b - a)];
    for (const d of dayOrder) {
      const r = this.one<any>("SELECT id, day, grp, code FROM res WHERE day=? AND booth=? AND num=?", d, parsed.booth, parsed.num);
      if (r && timingSafeEqual(r.code, code)) {
        row = r;
        break;
      }
    }
    if (!row) {
      this.lim.vNum.fail(numKey, now);
      this.lim.vIp.fail(ip, now);
      this.lim.vDev.fail(dev, now);
      await sleep(400);
      return json({ error: "受付番号または確認コードが違います。もう一度ご確認ください。" }, 404);
    }
    const token = randomToken();
    this.all("INSERT INTO viewers (h, grp, day, ep, created_at) VALUES (?, ?, ?, ?, ?)", await sha256(token), row.grp, row.day, this.epoch, now);
    return json({ token });
  }

  private async apiExport(request: Request, url: URL): Promise<Response> {
    const s = await this.authBearer(request);
    if (!s) return json({ error: "ログインし直してください" }, 401);
    const type = url.searchParams.get("type") ?? "queue";
    const showCode = s.role === "admin" || s.canIssue;
    if (type === "full") {
      if (s.role !== "admin") return json({ error: "全体管理者のみ出力できます" }, 403);
      const data = {
        exportedAt: new Date().toISOString(),
        exportedBy: s.name,
        epoch: this.epoch,
        activeDay: this.activeDay,
        days: this.days,
        booths: [...this.booths.values()],
        reservations: this.all("SELECT * FROM res ORDER BY day, booth, num"),
        rounds: this.all("SELECT * FROM rounds ORDER BY id"),
        notices: this.all("SELECT * FROM notices ORDER BY id"),
        chat: this.all("SELECT * FROM chat ORDER BY id"),
        requests: this.all("SELECT * FROM reqs ORDER BY id"),
        audit: this.all("SELECT * FROM audit ORDER BY id"),
      };
      return new Response(JSON.stringify(data, null, 1), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="booth-queue-full-${stamp()}.json"` },
      });
    }
    const day = Number(url.searchParams.get("day") ?? this.activeDay);
    const rows = this.all<any>("SELECT * FROM res WHERE day=? ORDER BY booth, status IN ('done','cancelled'), pos, num", day);
    const head = ["営業日", "ブース", "受付番号", "状態", "待ち順", ...(showCode ? ["確認コード"] : []), "人数", "1人あたり料金", "金額", "受付時刻", "開始時刻", "終了時刻", "メモ"];
    const lines = [head];
    const order: Record<string, number> = {};
    for (const r of rows) {
      const st = r.status as ResStatus;
      let ord = "";
      if (st === "waiting") ord = String((order[r.booth] = (order[r.booth] ?? 0) + 1));
      lines.push([
        this.days.find((d) => d.id === r.day)?.label ?? String(r.day),
        r.booth,
        `${r.booth}${r.num}`,
        STATUS_JA[st],
        ord,
        ...(showCode ? [`'${r.code}`] : []),
        r.people ?? "",
        r.price ?? "",
        r.people != null && r.price != null && st !== "cancelled" ? String(r.people * r.price) : "",
        fmtTime(r.created_at),
        fmtTime(r.started_at),
        fmtTime(r.ended_at),
        r.note ?? "",
      ]);
    }
    const csv = "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n");
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="queue-${stamp()}.csv"` } });
  }

  // ================= WebSocket =================
  private async handleWs(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return json({ error: "WebSocket で接続してください" }, 426);
    const protos = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((s) => s.trim());
    const cred = protos.find((p) => p.startsWith("s.") || p.startsWith("v."));
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const headers = protos.includes("nazo") ? { "Sec-WebSocket-Protocol": "nazo" } : undefined;
    let att: Att | null = null;
    let err = "";
    if (cred?.startsWith("s.")) {
      const s = await this.staffFromToken(cred.slice(2));
      if (s) att = { k: "s", sid: s.id, gen: s.gen, ep: this.epoch, adm: s.role === "admin" };
      else err = "staff-auth";
    } else if (cred?.startsWith("v.")) {
      const v = this.one<any>("SELECT grp, day, ep FROM viewers WHERE h=?", await sha256(cred.slice(2)));
      if (v && v.ep === this.epoch) att = { k: "v", vh: "", grp: v.grp, day: v.day, ep: v.ep };
      else err = "viewer-invalid";
    } else err = "no-cred";
    if (!att) {
      server.accept();
      server.send(JSON.stringify({ t: "auth", ok: false, reason: err }));
      server.close(4001, "auth");
      return new Response(null, { status: 101, webSocket: client, headers });
    }
    this.ctx.acceptWebSocket(server, [att.k]);
    server.serializeAttachment(att);
    if (att.k === "s") {
      server.send(JSON.stringify(this.snapshot(this.staff.get(att.sid)!)));
      this.pushDevices();
    } else this.sendView(server, att, true);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.countReq("wsIn");
    const att = ws.deserializeAttachment() as Att | null;
    if (!att || att.k !== "s") return; // 参加者からの送信は受け付けない
    let msg: any;
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    const reply = (o: object) => {
      try {
        ws.send(JSON.stringify({ t: "r", id: msg.id, ...o }));
      } catch {}
    };
    try {
      this.ensureLoaded();
      const s = this.staff.get(att.sid);
      if (!s || !s.active || s.gen !== att.gen) {
        reply({ ok: false, error: "ログインが無効になりました。もう一度ログインしてください。", auth: true });
        ws.close(4001, "auth");
        return;
      }
      const cmd = String(msg.cmd) as Cmd;
      const opId = typeof msg.id === "string" ? msg.id.slice(0, 64) : "";
      if (cmd === "sync") {
        ws.send(JSON.stringify(this.snapshot(s)));
        return reply({ ok: true });
      }
      // 同じ操作の再送（通信が切れて結果が分からなかった場合など）は、前回の結果を返して二重処理しない
      if (opId && this.opCache.has(opId)) return reply({ ...(this.opCache.get(opId) as object), dup: true });
      if (opId && MUTATING.has(cmd) && this.one("SELECT id FROM audit WHERE op=? LIMIT 1", opId)) {
        return reply({ ok: true, dup: true, msg: "この操作はすでに反映済みです" });
      }
      // リセット後の古い画面からの操作は受け付けない
      if (MUTATING.has(cmd) && Number(msg.ep) !== this.epoch) {
        ws.send(JSON.stringify(this.snapshot(s)));
        return reply({ ok: false, error: "全リセットなどで状態が更新されています。画面を最新にしました。もう一度操作してください。", stale: true });
      }
      const result = await this.run(s, cmd, msg.a ?? {}, opId);
      if (opId && MUTATING.has(cmd)) {
        this.opCache.set(opId, result);
        if (this.opCache.size > 1000) this.opCache.delete(this.opCache.keys().next().value!);
      }
      reply(result);
    } catch (e) {
      if (e instanceof CmdError) return reply({ ok: false, error: e.message, confirm: e.confirm || undefined });
      console.error(e);
      this.loaded = false; // メモリ状態を捨てて保存済みデータから読み直す
      reply({ ok: false, error: "サーバー内部でエラーが発生したため、操作は反映されていません。" });
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {}
    const att = ws.deserializeAttachment() as Att | null;
    if (att?.k === "s") this.pushDevices(ws);
  }

  // 役割名ごとの「今ログイン中（接続中）の端末数」。保存データは読まずに、接続の情報だけで数える
  private deviceCounts(exclude?: WebSocket): Record<number, number> {
    const out: Record<number, number> = {};
    for (const ws of this.ctx.getWebSockets("s")) {
      if (ws === exclude || ws.readyState !== WebSocket.OPEN) continue;
      const att = ws.deserializeAttachment() as Att | null;
      if (att?.k === "s") out[att.sid] = (out[att.sid] ?? 0) + 1;
    }
    return out;
  }
  // 端末数が変わった時に、全体管理者の画面にだけ送る
  private pushDevices(exclude?: WebSocket): void {
    const devices = this.deviceCounts(exclude);
    const msg = JSON.stringify({ t: "d", now: Date.now(), devices });
    for (const ws of this.ctx.getWebSockets("s")) {
      if (ws === exclude) continue;
      const att = ws.deserializeAttachment() as Att | null;
      if (att?.k === "s" && att.adm) {
        try {
          ws.send(msg);
        } catch {}
      }
    }
  }
  async webSocketError(): Promise<void> {}

  // 1 分ごとの生存通知（端末側はこれが途切れたら「接続が不安定」と表示して再接続する）
  async alarm(): Promise<void> {
    this.countReq("alarm");
    const sockets = this.ctx.getWebSockets();
    const hb = JSON.stringify({ t: "hb", now: Date.now() });
    for (const ws of sockets) {
      try {
        ws.send(hb);
      } catch {}
    }
    if (this.loaded) {
      // 表示期限を過ぎたお知らせを画面から外す
      const now = Date.now();
      if (this.notices.some((n) => n.endedAt === null && n.expiresAt !== null && n.expiresAt < now)) {
        this.ctx.storage.transactionSync(() => {
          for (const n of this.notices)
            if (n.endedAt === null && n.expiresAt !== null && n.expiresAt < now) {
              n.endedAt = now;
              this.all("UPDATE notices SET ended_at=? WHERE id=?", now, n.id);
            }
        });
        this.dirty.notices = true;
        this.flush();
      }
      this.persistUsage();
    }
    if (sockets.length > 0) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  // ================= 操作の実行 =================
  private async run(s: StaffRow, cmd: Cmd, a: any, opId: string): Promise<object> {
    // パスワードのハッシュ化は時間がかかるので、保存処理の前に済ませておく
    let pwHash: string | null = null;
    if ((cmd === "staffCreate" || cmd === "staffUpdate") && a.password) {
      const err = checkPassword(a.password);
      if (err) throw new CmdError(err);
      pwHash = await hashPassword(a.password);
    }
    const booth = this.targetBooth(cmd, a);
    if (!can(s, cmd, booth)) throw new CmdError("この操作を行う権限がありません");
    if (cmd === "audit") return { ok: true, data: this.all("SELECT * FROM audit ORDER BY id DESC LIMIT ?", clampInt(a.limit, 1, 500, 200)) };
    if (cmd === "dayHistory") {
      if (s.role !== "admin") throw new CmdError("この操作を行う権限がありません");
      return { ok: true, data: this.all<any>("SELECT * FROM res WHERE day=? ORDER BY booth, num", Number(a.day)).map((r) => this.resOut(rowToRes(r), s)) };
    }
    if (cmd === "diag") {
      // 管理者用の診断：スリープ復帰時と同じ読み込みを行い、読み取り行数を測る（データは変更しない）
      const r0 = this.usage.rr;
      this.loaded = false;
      this.ensureLoaded();
      return { ok: true, reloadRows: this.usage.rr - r0, inMemory: { res: this.res.size, rounds: this.rounds.size, notices: this.notices.length, reqs: this.reqs.length } };
    }
    if (cmd === "stats") {
      // 人数・金額の集計用データ（全営業日。確認コードは含めない）
      const rows = this.all<any>("SELECT day, booth, num, status, people, price, created_at, by_name FROM res ORDER BY day, booth, num");
      return { ok: true, rows: rows.map((r) => ({ day: r.day, booth: r.booth, num: r.num, status: r.status, people: r.people ?? null, price: r.price ?? null, createdAt: r.created_at, by: r.by_name ?? "" })), days: this.days };
    }
    if (cmd === "find") {
      const p = parseNumber(a.number);
      if (!p) throw new CmdError("受付番号は「A12」のように入力してください");
      const r = [...this.res.values()].find((x) => x.booth === p.booth && x.num === p.num) ?? this.loadRes(this.one<any>("SELECT * FROM res WHERE day=? AND booth=? AND num=?", this.activeDay, p.booth, p.num));
      if (!r) return { ok: true, res: null };
      // 見つかった予約をこの端末にも送る（以後の操作のため）
      return { ok: true, res: this.resOut(r, s) };
    }
    if (cmd === "chatMore") {
      const ch = String(a.ch);
      if (!this.canChat(s, ch)) throw new CmdError("このチャンネルは閲覧できません");
      return { ok: true, data: this.all<any>("SELECT * FROM chat WHERE ch=? AND id<? ORDER BY id DESC LIMIT 50", ch, Number(a.before) || 1e15).map(rowToChat).reverse() };
    }
    if (cmd === "resetPrepare") {
      if (s.role !== "admin") throw new CmdError("全体管理者のみ実行できます");
      const t = randomToken();
      this.resetTickets.set(s.id, { t, at: Date.now() });
      return { ok: true, ticket: t };
    }
    let out: object = { ok: true };
    const w0 = this.writes;
    try {
      this.ctx.storage.transactionSync(() => {
        out = this.exec(s, cmd, a, opId, pwHash) ?? { ok: true };
      });
    } catch (e) {
      // 保存は取り消されている。途中まで書き換えたメモリ上の状態も、保存済みデータから読み直す
      // （確認待ちなど、何も書き換えていない場合は読み直さない＝無料枠の節約）
      const touched = this.writes !== w0 || this.dirty.res.size > 0 || this.dirty.rounds.size > 0 || this.reloadDayAfter || this.resetDone;
      this.clearDirty();
      if (touched || !(e instanceof CmdError)) {
        this.loaded = false;
        this.ensureLoaded();
      }
      throw e;
    }
    this.flush();
    return out;
  }

  private targetBooth(cmd: Cmd, a: any): string | null {
    if (typeof a.booth === "string") return a.booth;
    const id = Number(a.id ?? (Array.isArray(a.ids) ? a.ids[0] : a.a));
    const r = this.res.get(id) ?? (Number.isInteger(id) && id > 0 ? this.loadRes(this.one<any>("SELECT * FROM res WHERE id=? AND day=?", id, this.activeDay)) : undefined);
    if (r) return r.booth;
    if (cmd === "unlockNumber") return parseNumber(a.number)?.booth ?? null;
    if (cmd === "noticeEnd") return this.notices.find((n) => n.id === Number(a.id))?.booth ?? null;
    return null;
  }

  private exec(s: StaffRow, cmd: Cmd, a: any, opId: string, pwHash: string | null): object | void {
    const now = Date.now();
    switch (cmd) {
      case "issue":
        return this.cmdIssue(s, a, opId, now);
      case "cancel": {
        const r = this.getRes(a.id);
        this.checkVersion(r, a.v);
        if (!["waiting", "called", "absent"].includes(r.status)) throw new CmdError(`${label(r)} は${STATUS_JA[r.status]}のため取り消せません`);
        const before = snap(r);
        this.leaveRound(r);
        r.status = "cancelled";
        this.saveRes(r);
        this.audit(opId, s.name, "取消", label(r), before, snap(r));
        return { ok: true };
      }
      case "restore": {
        const r = this.getRes(a.id);
        if (r.status !== "cancelled") throw new CmdError(`${label(r)} は取消状態ではありません`);
        this.checkGroupFree(r, !!a.force);
        const before = snap(r);
        r.status = "waiting";
        r.round = null;
        this.saveRes(r);
        this.audit(opId, s.name, "復元", label(r), before, snap(r));
        return { ok: true };
      }
      case "swap": {
        const x = this.getRes(a.id);
        const y = this.getRes(a.other);
        if (x.booth !== y.booth) throw new CmdError("同じブースの組どうしのみ入れ替えられます");
        if (x.status !== "waiting" || y.status !== "waiting") throw new CmdError("待ち列にいる組どうしのみ入れ替えられます（呼び出し中の回の組は、回から外してから操作してください）");
        this.checkVersion(x, a.v);
        this.checkVersion(y, a.ov);
        const bx = snap(x), by = snap(y);
        [x.pos, y.pos] = [y.pos, x.pos];
        this.saveRes(x);
        this.saveRes(y);
        this.audit(opId, s.name, "順番入替", `${label(x)}⇔${label(y)}`, { [label(x)]: bx, [label(y)]: by }, { [label(x)]: snap(x), [label(y)]: snap(y) });
        return { ok: true };
      }
      case "move": {
        const r = this.getRes(a.id);
        if (r.status !== "waiting") throw new CmdError("待ち列にいる組のみ移動できます");
        this.checkVersion(r, a.v);
        const before = snap(r);
        const b = this.booths.get(r.booth)!;
        const q = this.queue(b).waiting.filter((x) => x.id !== r.id);
        if (a.to === "front") r.pos = (q[0]?.pos ?? 1) - 1;
        else if (a.to === "back") r.pos = (q[q.length - 1]?.pos ?? 0) + 1;
        else {
          const i = q.findIndex((x) => x.id === Number(a.before));
          if (i < 0) throw new CmdError("移動先が見つかりません");
          const prev = i > 0 ? q[i - 1].pos : q[i].pos - 2;
          r.pos = (prev + q[i].pos) / 2;
        }
        this.saveRes(r);
        this.audit(opId, s.name, "順番変更", label(r), before, snap(r));
        return { ok: true };
      }
      case "edit": {
        const r = this.getRes(a.id);
        this.checkVersion(r, a.v);
        const before = snap(r);
        if (a.note !== undefined) r.note = cleanText(a.note ?? "", 100);
        if (a.people !== undefined) r.people = parsePeople(a.people);
        this.saveRes(r);
        this.audit(opId, s.name, a.people !== undefined ? "人数・メモ修正" : "メモ修正", label(r), before, snap(r));
        return { ok: true };
      }
      case "reissue": {
        const r = this.getRes(a.id);
        const to = String(a.to);
        if (!this.booths.get(to)?.enabled) throw new CmdError("変更先のブースが見つからないか、使用していません");
        if (to === r.booth) throw new CmdError("同じブースです");
        if (s.role !== "admin" && !s.booths.includes(to)) throw new CmdError("変更先のブースを操作する権限がありません");
        if (!["waiting", "called", "absent"].includes(r.status)) throw new CmdError(`${label(r)} は${STATUS_JA[r.status]}のためブースを変更できません`);
        const before = snap(r);
        this.leaveRound(r);
        r.status = "cancelled";
        this.saveRes(r);
        this.audit(opId, s.name, "ブース変更のため取消", label(r), before, snap(r));
        const nr = this.createRes(to, r.grp, r.note, s, now, r.people);
        this.audit(opId + ":2", s.name, "ブース変更で発行", label(nr), null, snap(nr));
        return { ok: true, res: this.resOut(nr, s), warnings: this.issueWarnings(nr) };
      }
      case "call": {
        const b = this.getBooth(a.booth);
        const q = this.queue(b);
        if (q.calling) throw new CmdError("すでに呼び出し中の回があります");
        if (!q.planned[0]?.length) throw new CmdError("待っている組がありません");
        const rd = this.createRound(b, q.planned[0], now);
        this.audit(opId, s.name, "呼び出し", `ブース${b.id} 第${rd.seq}回`, null, q.planned[0].map(label));
        return { ok: true };
      }
      case "uncall": {
        const b = this.getBooth(a.booth);
        const q = this.queue(b);
        if (!q.calling) throw new CmdError("呼び出し中の回がありません");
        const members = [...this.res.values()].filter((r) => r.round === q.calling!.id);
        if (members.some((r) => r.status === "playing")) throw new CmdError("開始済みの組がいるため取り消せません");
        for (const r of members) {
          r.status = "waiting";
          r.round = null;
          this.saveRes(r);
        }
        this.deleteRound(q.calling);
        this.audit(opId, s.name, "呼び出し取消", `ブース${b.id}`, members.map(label), null);
        return { ok: true };
      }
      case "start":
        return this.cmdStart(s, a, opId, now);
      case "end": {
        const ids: number[] = toIds(a);
        const list = ids.map((id) => this.getRes(id));
        const already = list.filter((r) => r.status === "done");
        const bad = list.filter((r) => r.status !== "playing" && r.status !== "done");
        if (bad.length) throw new CmdError(`${bad.map(label).join("、")} は参加中ではないため終了できません`);
        const target = list.filter((r) => r.status === "playing");
        for (const r of target) {
          const before = snap(r);
          r.status = "done";
          r.endedAt = now;
          this.saveRes(r);
          this.audit(opId + (target.length > 1 ? `:${r.id}` : ""), s.name, "終了", label(r), before, snap(r));
          this.settleRound(r.round, now);
        }
        if (target.length > 1) this.audit(opId, s.name, "一括終了", target.map(label).join(","), null, null);
        return { ok: true, done: target.map(label), already: already.map(label) };
      }
      case "absent": {
        const r = this.getRes(a.id);
        if (r.status !== "called" && r.status !== "waiting") throw new CmdError(`${label(r)} は${STATUS_JA[r.status]}のため不在にできません`);
        const before = snap(r);
        this.leaveRound(r);
        r.status = "absent";
        this.saveRes(r);
        this.audit(opId, s.name, "不在", label(r), before, snap(r));
        return { ok: true };
      }
      case "returnAbsent": {
        const r = this.getRes(a.id);
        if (r.status !== "absent") throw new CmdError(`${label(r)} は不在ではありません`);
        this.checkGroupFree(r, !!a.force);
        const b = this.booths.get(r.booth)!;
        const q = this.queue(b);
        const before = snap(r);
        if (a.mode === "round") {
          if (!q.calling) throw new CmdError("呼び出し中の回がありません。「待ち列の先頭へ」を選んでください");
          const n = [...this.res.values()].filter((x) => x.round === q.calling!.id && (x.status === "called" || x.status === "playing")).length;
          if (n >= b.capacity && !a.force) throw new CmdError(`呼び出し中の回は定員（${b.capacity}組）に達しています。定員を超えて入れますか？`, true);
          r.status = "called";
          r.round = q.calling.id;
        } else {
          r.status = "waiting";
          r.round = null;
          r.pos = a.mode === "back" ? (q.waiting[q.waiting.length - 1]?.pos ?? 0) + 1 : (q.waiting[0]?.pos ?? 1) - 1;
        }
        this.saveRes(r);
        this.audit(opId, s.name, "不在から戻す", label(r), before, snap(r));
        return { ok: true };
      }
      case "undoStart": {
        const r = this.getRes(a.id);
        if (r.status !== "playing") throw new CmdError(`${label(r)} は参加中ではありません`);
        const rd = r.round ? this.rounds.get(r.round) : null;
        const othersPlaying = [...this.res.values()].some((x) => x.round === r.round && x.id !== r.id && x.status === "playing");
        if (rd && !othersPlaying) {
          const q = this.queue(this.booths.get(r.booth)!);
          if (q.calling && q.calling.id !== rd.id) throw new CmdError("別の回が呼び出し中のため、開始を取り消せません。必要なら「不在」や「取消」を使ってください");
        }
        const before = snap(r);
        r.status = "called";
        r.startedAt = null;
        this.saveRes(r);
        if (rd && !othersPlaying) {
          rd.status = "calling";
          rd.startedAt = null;
          this.saveRound(rd);
        }
        this.audit(opId, s.name, "開始を取り消し", label(r), before, snap(r));
        return { ok: true };
      }
      case "undoEnd": {
        const r = this.getRes(a.id);
        if (r.status !== "done") throw new CmdError(`${label(r)} は終了していません`);
        this.checkGroupFree(r, !!a.force);
        const before = snap(r);
        r.status = "playing";
        r.endedAt = null;
        this.saveRes(r);
        const rd = r.round ? this.getRound(r.round) : null;
        if (rd && rd.status === "done") {
          rd.status = "playing";
          rd.endedAt = null;
          this.saveRound(rd);
        }
        this.audit(opId, s.name, "終了を取り消し", label(r), before, snap(r));
        return { ok: true };
      }
      case "pause": {
        const b = this.getBooth(a.booth);
        const before = { paused: b.paused, reason: b.pauseReason };
        b.paused = !!a.paused;
        b.pauseReason = cleanText(a.reason ?? "", 100);
        this.saveBooth(b);
        this.audit(opId, s.name, b.paused ? "一時停止" : "再開", `ブース${b.id}`, before, { paused: b.paused, reason: b.pauseReason });
        return { ok: true };
      }
      case "boothSet": {
        const b = this.getBooth(a.booth, true);
        const before = { ...b };
        if (a.name !== undefined) b.name = cleanText(a.name, 20) || b.id;
        if (a.enabled !== undefined) {
          if (!a.enabled && this.queueHasActive(b.id)) throw new CmdError("待ち・参加中の組がいるブースは停止できません。先に一時停止を使ってください");
          b.enabled = !!a.enabled;
        }
        if (a.capacity !== undefined) b.capacity = clampInt(a.capacity, 1, 10, b.capacity);
        if (a.durMin !== undefined) b.durMin = clampInt(a.durMin, 1, 180, b.durMin);
        if (a.durMax !== undefined) b.durMax = clampInt(a.durMax, 1, 180, b.durMax);
        if (b.durMin > b.durMax) throw new CmdError("所要時間は「短い場合 ≦ 長い場合」にしてください");
        if (a.gather !== undefined) b.gather = cleanText(a.gather, 100);
        if (a.price !== undefined) b.price = clampInt(a.price, 0, 100000, b.price);
        if (![...this.booths.values()].some((x) => x.enabled)) throw new CmdError("少なくとも1つのブースは使用中にしてください");
        this.saveBooth(b);
        this.audit(opId, s.name, "ブース設定変更", `ブース${b.id}`, before, { ...b });
        return { ok: true };
      }
      case "notice":
        return this.cmdNotice(s, a, opId, now);
      case "noticeEnd": {
        const n = this.notices.find((x) => x.id === Number(a.id));
        if (!n) throw new CmdError("お知らせが見つかりません");
        if (n.endedAt) return { ok: true, msg: "すでに表示を終了しています" };
        if (s.role !== "admin" && !(s.canIssue && (!n.booth || s.booths.includes(n.booth)))) throw new CmdError("この操作を行う権限がありません");
        n.endedAt = now;
        this.all("UPDATE notices SET ended_at=? WHERE id=?", now, n.id);
        this.dirty.notices = true;
        this.audit(opId, s.name, "お知らせ表示終了", n.text.slice(0, 30), null, null);
        return { ok: true };
      }
      case "eventSet": {
        const name = cleanText(a.eventName, 40);
        if (!name) throw new CmdError("イベント名を入力してください");
        const before = this.eventName;
        this.eventName = name;
        this.kvSet("eventName", name);
        this.dirty.booths = true;
        this.audit(opId, s.name, "イベント名変更", name, before, name);
        return { ok: true };
      }
      case "viewerKeyRotate": {
        // 参加者用QRコードを新しくする。すでに画面を表示中の参加者はそのまま見られる
        this.viewerKey = newViewerKey();
        this.kvSet("viewerKey", this.viewerKey);
        this.dirty.booths = true;
        this.audit(opId, s.name, "参加者用QRコードを更新", "", null, null);
        return { ok: true };
      }
      case "sponsorEnable": {
        this.sponsors.enabled = !!a.enabled;
        this.saveSponsors();
        this.audit(opId, s.name, a.enabled ? "協賛・お知らせ枠を表示" : "協賛・お知らせ枠を非表示", "", null, null);
        return { ok: true };
      }
      case "sponsorSave": {
        const text = cleanText(a.text, SPONSOR_TEXT_MAX);
        const link = cleanUrl(a.url);
        if (link === null) throw new CmdError("リンク先は https:// または http:// で始まるアドレスにしてください");
        const img = a.img;
        if (img !== undefined && img !== null && !(typeof img === "string" && SPONSOR_IMG_RE.test(img) && img.length <= SPONSOR_IMG_MAX)) {
          throw new CmdError("画像を読み込めませんでした（JPEG・PNG・WebP、大きすぎない画像にしてください）");
        }
        // 確認をすべて済ませてから、メモリ上の一覧を変える（途中で断った時に中途半端な項目を残さない）
        const found = this.sponsors.items.find((x) => x.id === String(a.id ?? ""));
        const willHaveImg = img === undefined ? !!found?.hasImg : img !== null;
        if (!text && !willHaveImg) throw new CmdError("画像か文章のどちらかを入れてください");
        if (!found && this.sponsors.items.length >= SPONSOR_MAX) throw new CmdError(`登録できるのは ${SPONSOR_MAX} 件までです`);
        let it = found;
        if (!it) {
          it = { id: randomToken(6).replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || String(Date.now()), text: "", url: "", hasImg: false };
          this.sponsors.items.push(it);
        }
        it.text = text;
        it.url = link;
        if (typeof img === "string") {
          this.sponsorImgs.set(it.id, img);
          this.kvSet("sponsorImg:" + it.id, img);
          it.hasImg = true;
        } else if (img === null) {
          this.sponsorImgs.delete(it.id);
          this.all("DELETE FROM kv WHERE k=?", "sponsorImg:" + it.id);
          it.hasImg = false;
        }
        this.saveSponsors();
        this.audit(opId, s.name, "協賛・お知らせ枠を保存", text.slice(0, 30), null, { text, url: link, hasImg: it.hasImg });
        return { ok: true, sponsorId: it.id };
      }
      case "sponsorDelete": {
        const i = this.sponsors.items.findIndex((x) => x.id === String(a.id));
        if (i < 0) throw new CmdError("見つかりません");
        const [it] = this.sponsors.items.splice(i, 1);
        this.sponsorImgs.delete(it.id);
        this.all("DELETE FROM kv WHERE k=?", "sponsorImg:" + it.id);
        this.saveSponsors();
        this.audit(opId, s.name, "協賛・お知らせ枠を削除", it.text.slice(0, 30), null, null);
        return { ok: true };
      }
      case "sponsorMove": {
        const list = this.sponsors.items;
        const i = list.findIndex((x) => x.id === String(a.id));
        const j = i + (Number(a.dir) < 0 ? -1 : 1);
        if (i < 0 || j < 0 || j >= list.length) return { ok: true };
        [list[i], list[j]] = [list[j], list[i]];
        this.saveSponsors();
        return { ok: true };
      }
      case "viewTextsSet": {
        // 参加者の画面の文章。空欄の項目は初期の文章を使う
        const src = a.texts && typeof a.texts === "object" ? a.texts : {};
        const out: ViewTexts = {};
        for (const key of Object.keys(VIEW_TEXT_DEFAULTS) as ViewTextKey[]) {
          const h = cleanText(src[key]?.headline, VIEW_TEXT_MAX.headline);
          const dt = cleanText(src[key]?.detail, VIEW_TEXT_MAX.detail);
          if (h || dt) out[key] = { ...(h ? { headline: h } : {}), ...(dt ? { detail: dt } : {}) };
        }
        const before = this.viewTexts;
        this.viewTexts = out;
        this.kvSet("viewTexts", JSON.stringify(out));
        this.dirty.booths = true;
        for (const b of BOOTH_IDS) this.dirty.boothIds.add(b);
        this.audit(opId, s.name, "参加者の画面の文章を変更", "", before, out);
        return { ok: true };
      }
      case "templatesSet": {
        const list = (Array.isArray(a.list) ? a.list : []).map((x: unknown) => cleanText(x, 200)).filter(Boolean).slice(0, 20);
        this.templates = list;
        this.kvSet("templates", JSON.stringify(list));
        this.dirty.booths = true;
        this.audit(opId, s.name, "定型文変更", "", null, list);
        return { ok: true };
      }
      case "chat": {
        const ch = String(a.ch);
        if (!this.canChat(s, ch)) throw new CmdError("このチャンネルには送信できません");
        const text = cleanText(a.text, MAX_TEXT);
        if (!text) throw new CmdError("メッセージを入力してください");
        const r = this.one<any>("INSERT INTO chat (ch, name, role, text, at) VALUES (?, ?, ?, ?, ?) RETURNING *", ch, s.name, s.role, text, now);
        this.dirty.chat.push(rowToChat(r));
        // チャットは操作ログを残さない（重複防止のみメモリで行う）
        return { ok: true };
      }
      case "reqCreate": {
        const text = cleanText(a.text, MAX_TEXT);
        if (!text) throw new CmdError("依頼内容を入力してください");
        const booth = a.booth && this.booths.has(a.booth) ? a.booth : null;
        const r = this.one<any>("INSERT INTO reqs (booth, text, status, by_name, assignee, created_at, updated_at) VALUES (?, ?, 'open', ?, NULL, ?, ?) RETURNING *", booth, text, s.name, now, now);
        this.reqs.push(rowToReq(r));
        this.dirty.reqs = true;
        this.audit(opId, s.name, "対応依頼", text.slice(0, 30), null, null);
        return { ok: true };
      }
      case "reqTake":
      case "reqDone":
      case "reqReopen": {
        const q = this.reqs.find((x) => x.id === Number(a.id));
        if (!q) throw new CmdError("対応依頼が見つかりません");
        if (cmd === "reqTake") {
          if (q.status === "done") throw new CmdError("この依頼はすでに完了しています");
          if (q.status === "doing" && q.assignee === s.name) return { ok: true, msg: "すでに対応中です" };
          if (q.status === "doing" && q.assignee !== s.name && !a.force) throw new CmdError(`${q.assignee} さんが対応中です。引き継ぎますか？`, true);
          q.status = "doing";
          q.assignee = s.name;
        } else if (cmd === "reqDone") {
          if (q.status === "done") return { ok: true, msg: "すでに完了しています" };
          q.status = "done";
          q.assignee = q.assignee ?? s.name;
        } else {
          q.status = "open";
          q.assignee = null;
        }
        q.updatedAt = now;
        this.all("UPDATE reqs SET status=?, assignee=?, updated_at=? WHERE id=?", q.status, q.assignee, now, q.id);
        this.dirty.reqs = true;
        this.audit(opId, s.name, { reqTake: "依頼を引き受け", reqDone: "依頼を完了", reqReopen: "依頼を未対応に戻す" }[cmd], q.text.slice(0, 30), null, null);
        return { ok: true };
      }
      case "staffCreate": {
        const name = cleanName(a.name);
        if (!name) throw new CmdError("役割名を入力してください");
        if ([...this.staff.values()].some((x) => x.name === name)) throw new CmdError("同じ役割名のアカウントがすでにあります");
        if (!pwHash) throw new CmdError("パスワードを入力してください");
        const role = checkRole(a.role);
        const booths = cleanBooths(a.booths);
        const r = this.one<any>(
          "INSERT INTO staff (name, role, booths, can_issue, pw, active, gen, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?) RETURNING *",
          name,
          role,
          JSON.stringify(booths),
          a.canIssue ? 1 : 0,
          pwHash,
          now,
        );
        this.staff.set(r.id, rowToStaff(r));
        this.dirty.staff = true;
        this.audit(opId, s.name, "スタッフ追加", name, null, { role, booths, canIssue: !!a.canIssue });
        return { ok: true };
      }
      case "staffUpdate": {
        const t = this.staff.get(Number(a.id));
        if (!t) throw new CmdError("スタッフが見つかりません");
        const before = publicStaff(t);
        if (a.role !== undefined) t.role = checkRole(a.role);
        if (a.booths !== undefined) t.booths = cleanBooths(a.booths);
        if (a.canIssue !== undefined) t.canIssue = !!a.canIssue;
        if (a.active !== undefined) t.active = !!a.active;
        if (a.name !== undefined) {
          const name = cleanName(a.name);
          if (!name) throw new CmdError("役割名を入力してください");
          if ([...this.staff.values()].some((x) => x.name === name && x.id !== t.id)) throw new CmdError("同じ役割名のアカウントがすでにあります");
          t.name = name;
        }
        if (![...this.staff.values()].some((x) => x.role === "admin" && x.active)) throw new CmdError("有効な全体管理者が1人もいなくなるため変更できません");
        if (pwHash) t.pw = pwHash;
        // 権限・停止・パスワードの変更時は、その人のログインをすべて無効にする
        if (!t.active || pwHash) this.revoke(t);
        else this.resnap.add(t.id); // 権限・担当の変更は、その人の画面に即時反映
        this.all("UPDATE staff SET name=?, role=?, booths=?, can_issue=?, active=?, pw=?, gen=? WHERE id=?", t.name, t.role, JSON.stringify(t.booths), t.canIssue ? 1 : 0, t.active ? 1 : 0, t.pw, t.gen, t.id);
        this.dirty.staff = true;
        this.audit(opId, s.name, "スタッフ変更", t.name, before, { ...publicStaff(t), password: pwHash ? "変更" : undefined });
        return { ok: true };
      }
      case "staffRevoke": {
        const t = this.staff.get(Number(a.id));
        if (!t) throw new CmdError("スタッフが見つかりません");
        this.revoke(t);
        this.all("UPDATE staff SET gen=? WHERE id=?", t.gen, t.id);
        this.audit(opId, s.name, "強制ログアウト", t.name, null, null);
        return { ok: true };
      }
      case "daySwitch": {
        const d = clampInt(a.day, 1, 30, 0);
        if (!d) throw new CmdError("営業日を選んでください");
        if (d === this.activeDay) return { ok: true, msg: "すでにその営業日です" };
        const active = [...this.res.values()].filter((r) => ACTIVE_STATUSES.includes(r.status));
        if (active.length && !a.force)
          throw new CmdError(`現在の営業日に、まだ待ち・参加中・不在の組が ${active.length} 組あります。切り替えると当日の待ち列から外れます（データは消えません）。切り替えますか？`, true);
        this.ensureDay(d);
        const from = this.activeDay;
        this.activeDay = d;
        this.kvSet("activeDay", String(d));
        this.audit(opId, s.name, "営業日切替", `${from}日目→${d}日目`, null, null);
        this.reloadDayAfter = true;
        return { ok: true };
      }
      case "daySet": {
        const d = clampInt(a.day, 1, 30, 0);
        if (!d) throw new CmdError("営業日を選んでください");
        const day = this.ensureDay(d);
        const before = { ...day, starts: { ...day.starts } };
        if (a.label !== undefined) day.label = cleanText(a.label, 20) || `${d}日目`;
        if (a.starts) {
          for (const b of BOOTH_IDS) {
            if (a.starts[b] === undefined) continue;
            const v = clampInt(a.starts[b], 1, 99999, 0);
            if (!v) throw new CmdError("開始番号は1以上の整数にしてください");
            if (v === day.starts[b]) continue;
            if (this.used[`${d}:${b}`]) throw new CmdError(`ブース${b}は${day.label}の番号をすでに発行しているため、開始番号を変更できません（次の番号を進める機能を使ってください）`);
            day.starts[b] = v;
            this.counters.set(`${d}:${b}`, v);
            this.all("UPDATE counters SET next=? WHERE day=? AND booth=?", v, d, b);
          }
        }
        this.all("UPDATE days SET label=?, starts=? WHERE id=?", day.label, JSON.stringify(day.starts), d);
        this.dirty.days = true;
        this.audit(opId, s.name, "営業日設定変更", day.label, before, day);
        return { ok: true, warnings: overlapWarnings(this.days, this.used) };
      }
      case "counterBump": {
        const b = this.getBooth(a.booth, true);
        const key = `${this.activeDay}:${b.id}`;
        const cur = this.counters.get(key) ?? 1;
        const v = clampInt(a.next, 1, 99999, 0);
        if (!v || v <= cur) throw new CmdError(`次の番号は現在の ${b.id}${cur} より大きい値にしてください（番号の再利用を防ぐため、戻すことはできません）`);
        this.counters.set(key, v);
        this.all("UPDATE counters SET next=? WHERE day=? AND booth=?", v, this.activeDay, b.id);
        this.computeUsed();
        this.dirty.days = true;
        this.audit(opId, s.name, "次の番号を変更", `ブース${b.id}`, cur, v);
        return { ok: true };
      }
      case "unlockNumber": {
        const p = parseNumber(a.number);
        if (!p) throw new CmdError("受付番号を入力してください");
        this.lim.vNum.clear(`${p.booth}${p.num}`);
        return { ok: true };
      }
      case "resetExecute":
        return this.cmdReset(s, a, opId, now);
      default:
        throw new CmdError("不明な操作です");
    }
  }
  private reloadDayAfter = false;

  // ---- 予約追加 ----
  private cmdIssue(s: StaffRow, a: any, opId: string, now: number): object {
    const b = this.getBooth(a.booth);
    let grp: number | null = null;
    let replaced: Res | null = null;
    if (a.prev) {
      const p = parseNumber(a.prev);
      if (!p) throw new CmdError("前の番号は「A12」のように入力してください");
      const prev = [...this.res.values()].find((r) => r.booth === p.booth && r.num === p.num) ?? this.loadRes(this.one<any>("SELECT * FROM res WHERE day=? AND booth=? AND num=?", this.activeDay, p.booth, p.num));
      if (!prev) throw new CmdError(`前の番号 ${p.booth}${p.num} は本日（${this.dayLabel()}）の予約に見つかりません`);
      grp = prev.grp;
      const active = [...this.res.values()].filter((r) => r.grp === grp && ACTIVE_STATUSES.includes(r.status));
      if (active.length) {
        const act = active[0];
        if (act.status === "playing") throw new CmdError(`この組は ${label(act)} で参加中です。終了してから次の予約をしてください`);
        if (!a.replace)
          throw new CmdError(`この組はすでに ${label(act)}（${STATUS_JA[act.status]}）の予約があります。1組が同時に予約できるのは1ブースまでです。取り直す場合は「元の予約を取り消して発行」を選んでください。`, true);
        const before = snap(act);
        this.leaveRound(act);
        act.status = "cancelled";
        this.saveRes(act);
        this.audit(opId + ":c", s.name, "取り直しのため取消", label(act), before, snap(act));
        replaced = act;
      }
    }
    if (grp === null) grp = newGroupId();
    const people = a.people === undefined || a.people === null || a.people === "" ? null : parsePeople(a.people);
    const r = this.createRes(b.id, grp, cleanText(a.note ?? "", 100), s, now, people);
    this.audit(opId, s.name, replaced ? "取り直しで発行" : "予約追加", label(r), null, snap(r));
    return { ok: true, res: this.resOut(r, s), replaced: replaced ? label(replaced) : null, warnings: this.issueWarnings(r) };
  }

  private createRes(booth: string, grp: number, note: string, s: StaffRow, now: number, people: number | null = null): Res {
    const b = this.booths.get(booth)!;
    if (!b.enabled) throw new CmdError(`ブース${b.id}は使用していません`);
    const key = `${this.activeDay}:${booth}`;
    const num = this.counters.get(key) ?? this.ensureDay(this.activeDay).starts[booth];
    const lastPos = Math.max(0, ...[...this.res.values()].filter((r) => r.booth === booth).map((r) => r.pos));
    const row = this.one<any>(
      "INSERT INTO res (day, booth, num, code, grp, status, pos, round, created_at, started_at, ended_at, v, note, by_name, people, price) VALUES (?, ?, ?, ?, ?, 'waiting', ?, NULL, ?, NULL, NULL, 1, ?, ?, ?, ?) RETURNING *",
      this.activeDay,
      booth,
      num,
      newCode(),
      grp,
      lastPos + 1,
      now,
      note,
      s.name,
      people,
      b.price,
    );
    this.counters.set(key, num + 1);
    this.all("INSERT INTO counters (day, booth, next) VALUES (?, ?, ?) ON CONFLICT(day, booth) DO UPDATE SET next=excluded.next", this.activeDay, booth, num + 1);
    this.computeUsed();
    const r = rowToRes(row);
    this.res.set(r.id, r);
    this.dirty.res.add(r.id);
    this.dirty.days = true;
    return r;
  }

  private issueWarnings(r: Res): string[] {
    const own = this.ensureDay(this.activeDay).starts[r.booth];
    const w: string[] = [];
    for (const d of this.days) {
      if (d.id === this.activeDay) continue;
      const st = d.starts[r.booth];
      if (st > own && r.num >= st) w.push(`${label(r)} は${d.label}の開始番号（${r.booth}${st}）以上です。番号帯が重なっています（予約は営業日で区別されるため衝突はしません）。`);
      const u = this.used[`${d.id}:${r.booth}`];
      if (u && r.num >= u.min && r.num <= u.max) w.push(`${label(r)} は${d.label}にも同じ番号があります（営業日で区別されます）。`);
    }
    return w;
  }

  // ---- 開始（同じ回の組は必ず同じ回にまとまる） ----
  private cmdStart(s: StaffRow, a: any, opId: string, now: number): object {
    const ids = toIds(a);
    const list = ids.map((id) => this.getRes(id));
    if (new Set(list.map((r) => r.booth)).size > 1) throw new CmdError("異なるブースの組を一度に開始することはできません");
    const b = this.booths.get(list[0].booth)!;
    const bad = list.filter((r) => r.status === "done" || r.status === "cancelled" || r.status === "absent");
    if (bad.length) throw new CmdError(`${bad.map((r) => `${label(r)}（${STATUS_JA[r.status]}）`).join("、")} は開始できません${bad.some((r) => r.status === "absent") ? "。不在の組は先に「戻す」を行ってください" : ""}`);
    const already = list.filter((r) => r.status === "playing");
    const targets = list.filter((r) => r.status === "called" || r.status === "waiting");
    if (!targets.length) return { ok: true, started: [], already: already.map(label), msg: "すでに開始済みです" };
    let q = this.queue(b);
    const roundIds = new Set(targets.filter((r) => r.status === "called").map((r) => r.round));
    const waiting = targets.filter((r) => r.status === "waiting");
    if (roundIds.size > 1) throw new CmdError("異なる回の組を一度に開始することはできません");
    let rd: Round | null = roundIds.size ? this.rounds.get([...roundIds][0]!)! : null;
    if (waiting.length) {
      if (rd || q.calling) throw new CmdError(`${waiting.map(label).join("、")} は呼び出し中の回に入っていません。呼び出し中の回の組を先に開始・不在にするか、呼び出しを取り消してください`);
      const first = q.planned[0] ?? [];
      const notFirst = waiting.filter((r) => !first.some((x) => x.id === r.id));
      if (notFirst.length) throw new CmdError(`${notFirst.map(label).join("、")} はまだ次の回ではありません（次の回：${first.map(label).join("、")}）`);
      // 次の回をまとめて呼び出してから開始（後から同じ回の別の組を開始しても同じ回に入る）
      rd = this.createRound(b, first, now);
      this.audit(opId + ":call", s.name, "呼び出し（開始時）", `ブース${b.id} 第${rd.seq}回`, null, first.map(label));
      q = this.queue(b);
    }
    if (!rd) throw new CmdError("開始する回が見つかりません");
    if (rd.status === "calling" && !a.force) {
      const other = q.playing.filter((x) => x.id !== rd!.id);
      if (other.length) {
        const names = [...this.res.values()].filter((r) => r.status === "playing" && other.some((o) => o.id === r.round)).map(label);
        throw new CmdError(`前の回（${names.join("、")}）がまだ参加中です。それでも開始しますか？`, true);
      }
      if (b.paused) throw new CmdError(`ブース${b.id}は一時停止中です。開始しますか？`, true);
    }
    for (const r of targets) {
      const before = snap(r);
      r.status = "playing";
      r.startedAt = now;
      this.saveRes(r);
      this.audit(opId + (targets.length > 1 ? `:${r.id}` : ""), s.name, "開始", label(r), before, snap(r));
    }
    if (targets.length > 1) this.audit(opId, s.name, "一括開始", targets.map(label).join(","), null, null);
    if (rd.status !== "playing") {
      rd.status = "playing";
      rd.startedAt = now;
      this.saveRound(rd);
    }
    return { ok: true, started: targets.map(label), already: already.map(label) };
  }

  // ---- お知らせ ----
  private cmdNotice(s: StaffRow, a: any, opId: string, now: number): object {
    const text = cleanText(a.text, MAX_TEXT);
    if (!text) throw new CmdError("お知らせの内容を入力してください");
    const scope = String(a.scope) as Notice["scope"];
    let booth: string | null = null;
    let targets: number[] | null = null;
    if (scope === "all") {
      if (s.role !== "admin" && !s.canIssue) throw new CmdError("全体へのお知らせは全体管理者と受付のみ送信できます");
    } else if (scope === "booth" || scope === "calling" || scope === "next") {
      const b = this.getBooth(a.booth);
      booth = b.id;
      const q = this.queue(b);
      if (scope === "calling") {
        if (!q.calling) throw new CmdError("呼び出し中の回がありません");
        targets = [...this.res.values()].filter((r) => r.round === q.calling!.id && r.status === "called").map((r) => r.id);
      } else if (scope === "next") {
        const next = q.planned[0];
        if (!next?.length) throw new CmdError("次の回の組がいません");
        targets = next.map((r) => r.id);
      }
      if (targets && !targets.length) throw new CmdError("対象の組がいません");
    } else if (scope === "res") {
      const r = this.getRes(a.id);
      booth = r.booth;
      targets = [r.id];
    } else throw new CmdError("お知らせの対象を選んでください");
    const exp = a.expiresMin ? now + clampInt(a.expiresMin, 1, 600, 60) * MIN : null;
    const row = this.one<any>(
      "INSERT INTO notices (day, scope, booth, targets, text, at, by_name, ended_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?) RETURNING *",
      this.activeDay,
      scope,
      booth,
      targets ? JSON.stringify(targets) : null,
      text,
      now,
      s.name,
      exp,
    );
    this.notices.push(rowToNotice(row));
    this.dirty.notices = true;
    this.audit(opId, s.name, "お知らせ送信", `${SCOPE_JA[scope]}${booth ? ` ${booth}` : ""}`, null, { text, targets: targets?.map((id) => this.resLabel(id)) });
    return { ok: true, count: targets?.length ?? null };
  }

  // ---- 全リセット ----
  private cmdReset(s: StaffRow, a: any, opId: string, now: number): object {
    if (s.role !== "admin") throw new CmdError("全体管理者のみ実行できます");
    const t = this.resetTickets.get(s.id);
    this.resetTickets.delete(s.id);
    if (!t || !a.ticket || !timingSafeEqual(String(a.ticket), t.t)) throw new CmdError("確認の手順が正しく完了していません。最初からやり直してください");
    if (now - t.at < 2500) throw new CmdError("確認が速すぎます。内容を確認してから、最初からやり直してください");
    if (now - t.at > 10 * MIN) throw new CmdError("確認から時間が経ちすぎました。最初からやり直してください");
    if (a.phrase !== "すべてリセットする") throw new CmdError("確認の手順が正しく完了していません");
    for (const tb of ["res", "rounds", "viewers", "notices", "chat", "reqs", "audit"]) this.all(`DELETE FROM ${tb}`);
    this.all("DELETE FROM sqlite_sequence WHERE name IN ('res','rounds','notices','chat','reqs','audit')");
    for (const d of this.days) for (const b of BOOTH_IDS) this.all("UPDATE counters SET next=? WHERE day=? AND booth=?", d.starts[b] ?? defaultStart(d.id), d.id, b);
    this.all("UPDATE booths SET paused=0, pause_reason=''");
    this.epoch += 1;
    this.kvSet("epoch", String(this.epoch));
    this.kvSet("activeDay", "1");
    this.activeDay = 1;
    this.audit(opId, s.name, "全リセット", `第${this.epoch}版の運営データを開始`, null, null);
    this.resetDone = true;
    this.opCache.clear();
    return { ok: true, epoch: this.epoch };
  }
  private resetDone = false;

  // ================= 状態操作の補助 =================
  private queue(b: Booth) {
    return boothQueue(b, [...this.res.values()], [...this.rounds.values()]);
  }
  private queueHasActive(booth: string): boolean {
    return [...this.res.values()].some((r) => r.booth === booth && ACTIVE_STATUSES.includes(r.status));
  }
  private loadRes(row: any): Res | undefined {
    if (!row) return undefined;
    const r = this.res.get(row.id) ?? rowToRes(row);
    this.res.set(r.id, r);
    return r;
  }
  private getRes(id: unknown): Res {
    const r = this.res.get(Number(id)) ?? this.loadRes(this.one<any>("SELECT * FROM res WHERE id=? AND day=?", Number(id), this.activeDay));
    if (!r) throw new CmdError("予約が見つかりません（別の営業日の予約か、画面が古い可能性があります）");
    return r;
  }
  private getBooth(id: unknown, allowDisabled = false): Booth {
    const b = this.booths.get(String(id));
    if (!b || (!allowDisabled && !b.enabled)) throw new CmdError("ブースが見つからないか、使用していません");
    return b;
  }
  private checkVersion(r: Res, v: unknown): void {
    if (v !== undefined && v !== null && Number(v) !== r.v)
      throw new CmdError(`${label(r)} は他のスタッフによって更新されています。最新の画面を確認してから、もう一度操作してください`);
  }
  // 同じ組の別の有効な予約があれば確認する（二重予約の防止）
  private checkGroupFree(r: Res, force: boolean): void {
    const other = [...this.res.values()].find((x) => x.grp === r.grp && x.id !== r.id && ACTIVE_STATUSES.includes(x.status));
    if (other && !force) throw new CmdError(`この組は ${label(other)}（${STATUS_JA[other.status]}）の予約があります。戻すと二重予約になります。それでも戻しますか？`, true);
  }
  private createRound(b: Booth, members: Res[], now: number): Round {
    if (!this.seqMax.has(b.id)) this.seqMax.set(b.id, Number(this.one<any>("SELECT COALESCE(MAX(seq), 0) AS m FROM rounds WHERE day=? AND booth=?", this.activeDay, b.id)?.m ?? 0));
    const seq = this.seqMax.get(b.id)! + 1;
    this.seqMax.set(b.id, seq);
    const row = this.one<any>("INSERT INTO rounds (day, booth, seq, status, called_at, started_at, ended_at) VALUES (?, ?, ?, 'calling', ?, NULL, NULL) RETURNING *", this.activeDay, b.id, seq, now);
    const rd = rowToRound(row);
    this.rounds.set(rd.id, rd);
    this.dirty.rounds.add(rd.id);
    for (const r of members) {
      r.status = "called";
      r.round = rd.id;
      this.saveRes(r);
    }
    return rd;
  }
  private getRound(id: number): Round | null {
    let rd = this.rounds.get(id);
    if (!rd) {
      const row = this.one<any>("SELECT * FROM rounds WHERE id=?", id);
      if (row) {
        rd = rowToRound(row);
        this.rounds.set(rd.id, rd);
      }
    }
    return rd ?? null;
  }
  private saveRound(rd: Round): void {
    this.all("UPDATE rounds SET status=?, started_at=?, ended_at=? WHERE id=?", rd.status, rd.startedAt, rd.endedAt, rd.id);
    this.dirty.rounds.add(rd.id);
  }
  private deleteRound(rd: Round): void {
    this.all("DELETE FROM rounds WHERE id=?", rd.id);
    this.rounds.delete(rd.id);
    this.dirty.deletedRounds.add(rd.id);
    this.dirty.boothIds.add(rd.booth);
  }
  // 回から外れる（不在・取消など）。呼び出し中の回が空になれば回を消し、進行中の回なら終了判定する。
  private leaveRound(r: Res): void {
    const id = r.round;
    r.round = null;
    if (id === null) return;
    const rd = this.rounds.get(id);
    if (!rd) return;
    const rest = [...this.res.values()].filter((x) => x.round === id && x.id !== r.id);
    if (rd.status === "calling" && !rest.some((x) => x.status === "called")) this.deleteRound(rd);
    else this.settleRound(id, Date.now(), r.id);
  }
  private settleRound(id: number | null, now: number, excluding?: number): void {
    if (id === null) return;
    const rd = this.rounds.get(id);
    if (!rd || rd.status !== "playing") return;
    const live = [...this.res.values()].some((x) => x.round === id && x.id !== excluding && (x.status === "called" || x.status === "playing"));
    if (!live) {
      rd.status = "done";
      rd.endedAt = now;
      this.saveRound(rd);
    }
  }
  private saveRes(r: Res): void {
    r.v += 1;
    this.all("UPDATE res SET status=?, pos=?, round=?, started_at=?, ended_at=?, v=?, note=?, people=? WHERE id=?", r.status, r.pos, r.round, r.startedAt, r.endedAt, r.v, r.note, r.people, r.id);
    this.dirty.res.add(r.id);
  }
  private saveSponsors(): void {
    this.kvSet("sponsors", JSON.stringify(this.sponsors));
    this.dirty.booths = true; // 管理者の画面に一覧を送る
  }
  private sponsorsOut(): { id: string; text: string; url: string; img: string | null }[] {
    if (!this.sponsors.enabled) return [];
    return this.sponsors.items.map((x) => ({ id: x.id, text: x.text, url: x.url, img: this.sponsorImgs.get(x.id) ?? null }));
  }

  private saveBooth(b: Booth): void {
    this.all("UPDATE booths SET name=?, enabled=?, capacity=?, dur_min=?, dur_max=?, paused=?, pause_reason=?, gather=?, price=? WHERE id=?", b.name, b.enabled ? 1 : 0, b.capacity, b.durMin, b.durMax, b.paused ? 1 : 0, b.pauseReason, b.gather, b.price, b.id);
    this.dirty.booths = true;
  }
  private revoke(t: StaffRow): void {
    t.gen += 1;
    this.all("DELETE FROM sessions WHERE staff_id=?", t.id);
    this.revokeSockets.add(t.id);
  }
  private revokeSockets = new Set<number>();
  private resnap = new Set<number>();
  private audit(op: string | null, staff: string, action: string, target: string, before: unknown, after: unknown): void {
    this.all(
      "INSERT INTO audit (op, at, staff, action, target, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)",
      op || null,
      Date.now(),
      staff,
      action,
      target,
      before === null || before === undefined ? null : JSON.stringify(before),
      after === null || after === undefined ? null : JSON.stringify(after),
    );
  }
  private canChat(s: Staff, ch: string): boolean {
    if (ch === "all") return true;
    if (!BOOTH_IDS.includes(ch)) return false;
    return s.role !== "sub" || s.booths.includes(ch);
  }
  private dayLabel(): string {
    return this.days.find((d) => d.id === this.activeDay)?.label ?? `${this.activeDay}日目`;
  }
  private resLabel(id: number): string {
    const r = this.res.get(id);
    return r ? label(r) : String(id);
  }
  private resOut(r: Res, s: Staff): object {
    const showCode = s.role === "admin" || s.canIssue;
    return { ...r, code: showCode ? r.code : undefined };
  }

  // ================= 送信 =================
  private clearDirty(): void {
    this.dirty = { res: new Set(), rounds: new Set(), booths: false, notices: false, reqs: false, staff: false, days: false, chat: [], deletedRounds: new Set(), boothIds: new Set() };
    this.revokeSockets.clear();
    this.resnap.clear();
    this.reloadDayAfter = false;
    this.resetDone = false;
  }

  private snapshot(s: StaffRow): object {
    const isAdmin = s.role === "admin";
    const chs = ["all", ...BOOTH_IDS].filter((c) => this.canChat(s, c));
    const chat: Chat[] = [];
    for (const ch of chs) chat.push(...this.all<any>("SELECT * FROM chat WHERE ch=? ORDER BY id DESC LIMIT 50", ch).map(rowToChat).reverse());
    return {
      t: "snap",
      now: Date.now(),
      me: publicStaff(s),
      env: this.env.ENV_LABEL ?? "",
      epoch: this.epoch,
      activeDay: this.activeDay,
      eventName: this.eventName,
      viewerKey: isAdmin ? this.viewerKey : undefined,
      viewTexts: isAdmin ? this.viewTexts : undefined,
      viewTextDefaults: isAdmin ? VIEW_TEXT_DEFAULTS : undefined,
      sponsors: isAdmin ? this.sponsors : undefined,
      devices: isAdmin ? this.deviceCounts() : undefined,
      ...this.dayPayload(),
      booths: [...this.booths.values()],
      templates: this.templates,
      res: [...this.res.values()].map((r) => this.resOut(r, s)),
      rounds: [...this.rounds.values()],
      notices: this.notices.map((n) => ({ ...n, targets: n.targets?.map((id) => this.resLabel(id)) ?? null })),
      reqs: this.reqs,
      chat,
      staff: [...this.staff.values()].map((x) => (isAdmin ? publicStaff(x) : { id: x.id, name: x.name, role: x.role, booths: x.booths })),
      usage: isAdmin ? this.usageOut() : undefined,
    };
  }
  private dayPayload(): object {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters) counters[k] = v;
    return { days: this.days, counters, warnings: overlapWarnings(this.days, this.used) };
  }
  private usageOut(): object {
    return { ...this.usage, sockets: this.ctx.getWebSockets().length };
  }

  // 変更を関係する端末に送る（差分のみ）
  private flush(): void {
    const d = this.dirty;
    const revoked = new Set(this.revokeSockets);
    const resnap = new Set(this.resnap);
    const fullReload = this.reloadDayAfter || this.resetDone;
    const wasReset = this.resetDone;
    this.clearDirty();
    if (fullReload) {
      this.loaded = false;
      this.ensureLoaded();
    }
    const staffSockets = this.ctx.getWebSockets("s");
    const viewerSockets = this.ctx.getWebSockets("v");
    for (const ws of staffSockets) {
      const att = ws.deserializeAttachment() as Att;
      if (att.k !== "s") continue;
      const s = this.staff.get(att.sid);
      if (!s || revoked.has(att.sid) || !s.active || s.gen !== att.gen) {
        try {
          ws.send(JSON.stringify({ t: "auth", ok: false, reason: "revoked" }));
          ws.close(4001, "auth");
        } catch {}
        continue;
      }
      try {
        if (fullReload || resnap.has(s.id)) {
          if (wasReset) ws.send(JSON.stringify({ t: "reset" }));
          ws.send(JSON.stringify(this.snapshot(s)));
          continue;
        }
        const msg: any = { t: "d", now: Date.now() };
        if (d.res.size) msg.res = [...d.res].map((id) => this.res.get(id)).filter(Boolean).map((r) => this.resOut(r!, s));
        if (d.rounds.size) msg.rounds = [...d.rounds].map((id) => this.rounds.get(id)).filter(Boolean);
        if (d.deletedRounds.size) msg.delRounds = [...d.deletedRounds];
        if (d.booths) {
          msg.booths = [...this.booths.values()];
          msg.templates = this.templates;
          msg.eventName = this.eventName;
          if (s.role === "admin") {
            msg.viewerKey = this.viewerKey;
            msg.viewTexts = this.viewTexts;
            msg.sponsors = this.sponsors;
          }
        }
        if (d.days || d.res.size) Object.assign(msg, this.dayPayload());
        if (d.notices) msg.notices = this.notices.map((n) => ({ ...n, targets: n.targets?.map((id) => this.resLabel(id)) ?? null }));
        if (d.reqs) msg.reqs = this.reqs;
        if (d.staff) msg.staff = [...this.staff.values()].map((x) => (s.role === "admin" ? publicStaff(x) : { id: x.id, name: x.name, role: x.role, booths: x.booths }));
        const chat = d.chat.filter((c) => this.canChat(s, c.ch));
        if (chat.length) msg.chat = chat;
        if (s.role === "admin") msg.usage = this.usageOut();
        if (Object.keys(msg).length > 2) ws.send(JSON.stringify(msg));
      } catch {}
    }
    // 参加者：変化があった組・ブースの端末だけ再計算し、内容が変わった端末にだけ送る
    // （終了済みの組など、影響のない端末は計算しない＝無料枠の節約）
    if (!(fullReload || d.res.size || d.rounds.size || d.deletedRounds.size || d.booths || d.notices)) return;
    const dirtyGroups = new Set<number>();
    const dirtyBooths = new Set<string>(d.boothIds);
    for (const id of d.res) {
      const r = this.res.get(id);
      if (!r) continue;
      dirtyGroups.add(r.grp);
      dirtyBooths.add(r.booth);
      const cached = this.grpCache.get(r.grp);
      if (cached) {
        const i = cached.findIndex((x) => x.id === r.id);
        if (i >= 0) cached[i] = r;
        else cached.push(r);
      }
    }
    for (const id of d.rounds) {
      const rd = this.rounds.get(id);
      if (rd) dirtyBooths.add(rd.booth);
    }
    const activeByGrp = new Map<number, Res>();
    for (const r of this.res.values()) if (ACTIVE_STATUSES.includes(r.status)) activeByGrp.set(r.grp, r);
    for (const ws of viewerSockets) {
      const att = ws.deserializeAttachment() as Att;
      if (att.k !== "v") continue;
      if (att.ep !== this.epoch) {
        try {
          ws.send(JSON.stringify({ t: "invalid" }));
          ws.close(4002, "reset");
        } catch {}
        continue;
      }
      // 別の営業日の予約を見ている端末は、営業日切替・リセット時以外は内容が変わらない
      if (!fullReload && att.day !== this.activeDay) continue;
      const act = activeByGrp.get(att.grp);
      const need = fullReload || d.booths || d.notices || dirtyGroups.has(att.grp) || (act !== undefined && dirtyBooths.has(act.booth));
      if (need) this.sendView(ws, att, false);
    }
  }

  // 組の予約一覧（当日分）。メモリに無い終了済みの予約は 1 回だけ読み込んで覚えておく
  private groupRes(grp: number): Res[] {
    let list = this.grpCache.get(grp);
    if (!list) {
      list = this.all<any>("SELECT * FROM res WHERE grp=?", grp)
        .filter((r) => r.day === this.activeDay)
        .map((r) => this.res.get(r.id) ?? rowToRes(r));
      this.grpCache.set(grp, list);
    }
    return list;
  }

  private sendView(ws: WebSocket, att: Extract<Att, { k: "v" }>, force: boolean): void {
    const now = Date.now();
    let list: Res[];
    if (att.day === this.activeDay) list = this.groupRes(att.grp);
    else list = this.all<any>("SELECT * FROM res WHERE grp=?", att.grp).filter((r) => r.day === att.day).map(rowToRes);
    // 有効な予約を優先し、無ければ最新の予約
    const cur = list.filter((r) => ACTIVE_STATUSES.includes(r.status)).sort((a, b) => b.id - a.id)[0] ?? list.sort((a, b) => b.id - a.id)[0];
    let payload: object;
    if (!cur) payload = { t: "view", none: true };
    else {
      const b = this.booths.get(cur.booth)!;
      const q = this.queue(b);
      const v = viewerView(b, q, cur, now, att.day === this.activeDay, this.viewTexts);
      const notices = this.notices
        .filter((n) => n.endedAt === null && (n.expiresAt === null || n.expiresAt > now) && n.day === att.day)
        .filter((n) => {
          if (n.scope === "all") return true;
          if (n.scope === "booth") return n.booth === cur.booth && ACTIVE_STATUSES.includes(cur.status);
          return !!n.targets?.includes(cur.id) && ACTIVE_STATUSES.includes(cur.status);
        })
        .map((n) => ({ id: n.id, text: n.text.replaceAll("{booth}", b.name), at: n.at }));
      const history = list
        .filter((r) => r.id !== cur.id && r.status === "done")
        .map((r) => label(r));
      payload = { t: "view", view: v, notices, paused: b.paused, pauseReason: b.pauseReason, done: history, dayLabel: this.days.find((d) => d.id === att.day)?.label ?? "" };
    }
    const str = JSON.stringify(payload);
    const key = str;
    if (!force && this.viewCache.get(ws) === key) return;
    this.viewCache.set(ws, key);
    try {
      ws.send(JSON.stringify({ ...payload, now }));
    } catch {}
  }
}

// ================= 補助関数 =================
const MUTATING = new Set<Cmd>([
  "issue", "cancel", "restore", "swap", "move", "edit", "reissue", "call", "uncall", "start", "end", "absent", "returnAbsent", "undoStart", "undoEnd",
  "pause", "boothSet", "notice", "noticeEnd", "templatesSet", "eventSet", "viewerKeyRotate", "viewTextsSet", "sponsorEnable", "sponsorSave", "sponsorDelete", "sponsorMove", "chat", "reqCreate", "reqTake", "reqDone", "reqReopen", "staffCreate", "staffUpdate",
  "staffRevoke", "daySwitch", "daySet", "counterBump", "unlockNumber", "resetExecute",
]);
const STATUS_JA: Record<ResStatus, string> = { waiting: "順番待ち", called: "呼び出し中", playing: "参加中", done: "終了", absent: "不在", cancelled: "取消" };
const SCOPE_JA: Record<string, string> = { all: "全体", booth: "ブース全体", calling: "呼び出し中の回", next: "次の回", res: "特定の組" };

function json(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
function withCors(r: Response): Response {
  r.headers.set("Access-Control-Allow-Origin", "*");
  return r;
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function snap(r: Res) {
  return { status: r.status, pos: r.pos, round: r.round, startedAt: r.startedAt, endedAt: r.endedAt, note: r.note, grp: r.grp, people: r.people };
}
function parsePeople(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new CmdError("人数は1〜50の整数で入力してください");
  return n;
}
function toIds(a: any): number[] {
  const ids = (Array.isArray(a.ids) ? a.ids : [a.id]).map(Number).filter((n: number) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw new CmdError("対象の組を選んでください");
  return [...new Set<number>(ids)];
}
function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
function cleanText(v: unknown, max: number): string {
  return String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, max);
}
// リンク先：空欄か http(s) のアドレスだけ許可（それ以外は null）
function cleanUrl(v: unknown): string | null {
  const s = cleanText(v, 300);
  if (!s) return "";
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
function cleanName(v: unknown): string {
  return cleanText(v, 30).normalize("NFKC");
}
function checkPassword(p: unknown): string | null {
  if (typeof p !== "string" || p.length < 6) return "パスワードは6文字以上にしてください";
  if (p.length > 100) return "パスワードが長すぎます";
  return null;
}
function checkRole(r: unknown): Role {
  if (r === "admin" || r === "sub" || r === "support") return r;
  throw new CmdError("役割を選んでください");
}
function cleanBooths(v: unknown): string[] {
  return (Array.isArray(v) ? v : []).map(String).filter((b) => BOOTH_IDS.includes(b));
}
function publicStaff(s: StaffRow) {
  return { id: s.id, name: s.name, role: s.role, booths: s.booths, canIssue: s.canIssue, active: s.active };
}
function rowToRes(r: any): Res {
  return { id: r.id, day: r.day, booth: r.booth, num: r.num, code: r.code, grp: r.grp, status: r.status, pos: r.pos, round: r.round ?? null, createdAt: r.created_at, startedAt: r.started_at ?? null, endedAt: r.ended_at ?? null, v: r.v, note: r.note ?? "", by: r.by_name ?? "", people: r.people ?? null, price: r.price ?? null };
}
function rowToRound(r: any): Round {
  return { id: r.id, day: r.day, booth: r.booth, seq: r.seq, status: r.status, calledAt: r.called_at, startedAt: r.started_at ?? null, endedAt: r.ended_at ?? null };
}
function rowToStaff(s: any): StaffRow {
  return { id: s.id, name: s.name, role: s.role, booths: JSON.parse(s.booths || "[]"), canIssue: !!s.can_issue, active: !!s.active, pw: s.pw, gen: s.gen };
}
function rowToNotice(n: any): Notice {
  return { id: n.id, day: n.day, scope: n.scope, booth: n.booth ?? null, targets: n.targets ? JSON.parse(n.targets) : null, text: n.text, at: n.at, by: n.by_name, endedAt: n.ended_at ?? null, expiresAt: n.expires_at ?? null };
}
function rowToReq(r: any): Req {
  return { id: r.id, booth: r.booth ?? null, text: r.text, status: r.status, by: r.by_name, assignee: r.assignee ?? null, createdAt: r.created_at, updatedAt: r.updated_at };
}
function rowToChat(c: any): Chat {
  return { id: c.id, ch: c.ch, name: c.name, role: c.role, text: c.text, at: c.at };
}
function fmtTime(ms: number | null): string {
  if (!ms) return "";
  return new Date(ms + 9 * 60 * MIN).toISOString().slice(11, 19); // 日本時間
}
function stamp(): string {
  return new Date(Date.now() + 9 * 60 * MIN).toISOString().slice(0, 16).replace(/[-:T]/g, "");
}
function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// 組 ID（参加者には見せない内部番号）。乱数で作るので、採番のために予約表を読む必要がない
function newGroupId(): number {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return (a[0] & 0x1fffff) * 0x100000000 + a[1] + 1;
}

// 参加者用QRコードの合言葉（読み間違えにくい英小文字・数字 10 文字）
function newViewerKey(): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  return [...crypto.getRandomValues(new Uint8Array(10))].map((x) => chars[x % chars.length]).join("");
}
