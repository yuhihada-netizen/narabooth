// 予約・回・待ち時間の計算など、保存処理を含まない純粋なロジック。
// （テストしやすいように Durable Object 本体から分離している）

export type Role = "admin" | "sub" | "support";
// waiting: 待ち列 / called: 呼び出し中の回に入っている（未開始） / playing: 参加中
// done: 終了 / absent: 不在（保留） / cancelled: 取消
export type ResStatus = "waiting" | "called" | "playing" | "done" | "absent" | "cancelled";
export const ACTIVE_STATUSES: ResStatus[] = ["waiting", "called", "playing", "absent"];

export interface Res {
  id: number;
  day: number;
  booth: string;
  num: number;
  code: string;
  grp: number;
  status: ResStatus;
  pos: number;
  round: number | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  v: number;
  note: string;
  people: number | null; // 人数（未入力は null）
  price: number | null; // 発行時点の1人あたり料金（円）
  by: string;
}

// calling: 呼び出し中（まだ誰も開始していない） / playing: 1 組以上が開始済み / done: 終了
export interface Round {
  id: number;
  day: number;
  booth: string;
  seq: number;
  status: "calling" | "playing" | "done";
  calledAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface Booth {
  id: string;
  name: string;
  enabled: boolean;
  capacity: number;
  durMin: number;
  durMax: number;
  paused: boolean;
  pauseReason: string;
  gather: string;
  price: number; // 1人あたりの料金（円）
}

export interface Staff {
  id: number;
  name: string;
  role: Role;
  booths: string[];
  canIssue: boolean;
  active: boolean;
}

// ブースは最大 10 個（A〜J）。使わないブースは「使用しない」にしておく。
export const BOOTH_IDS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
export const MIN = 60_000;

export function label(r: { booth: string; num: number }): string {
  return `${r.booth}${r.num}`;
}

export interface BoothQueue {
  playing: Round[];
  calling: Round | null;
  callingMembers: Res[]; // 呼び出し中の回のうち未開始の組
  waiting: Res[]; // 呼び出し前の待ち列（並び順）
  planned: Res[][]; // 待ち列を定員ごとに区切った「予定の回」
  absent: Res[];
}

export function boothQueue(booth: Booth, resList: Res[], rounds: Round[]): BoothQueue {
  const mine = resList.filter((r) => r.booth === booth.id);
  const waiting = mine.filter((r) => r.status === "waiting").sort((a, b) => a.pos - b.pos || a.id - b.id);
  const planned: Res[][] = [];
  const cap = Math.max(1, booth.capacity);
  for (let i = 0; i < waiting.length; i += cap) planned.push(waiting.slice(i, i + cap));
  const rs = rounds.filter((r) => r.booth === booth.id);
  const calling = rs.find((r) => r.status === "calling") ?? null;
  return {
    playing: rs.filter((r) => r.status === "playing").sort((a, b) => a.seq - b.seq),
    calling,
    callingMembers: calling ? mine.filter((r) => r.round === calling.id && r.status === "called") : [],
    waiting,
    planned,
    absent: mine.filter((r) => r.status === "absent").sort((a, b) => a.pos - b.pos),
  };
}

export interface Estimate {
  groupsAhead: number; // 自分より前に待っている組数
  roundsAhead: number; // 自分の回より前にある回数（進行中・呼び出し中を含む）
  from: number | null; // 開始見込み（早い場合）の時刻 ms
  to: number | null; // 開始見込み（遅い場合）の時刻 ms
  overrun: boolean; // 進行中の回が設定時間を超えている
  unknown: string | null; // 目安を出せない理由
}

// 待ち時間の目安。確定値ではなく [from, to] の幅で返す。
export function estimate(booth: Booth, q: BoothQueue, res: Res, now: number): Estimate {
  const dMin = booth.durMin * MIN;
  const dMax = booth.durMax * MIN;
  const idx = q.waiting.findIndex((r) => r.id === res.id);
  const k = idx < 0 ? 0 : Math.floor(idx / Math.max(1, booth.capacity));
  const callingCount = q.callingMembers.length;
  const groupsAhead = (idx < 0 ? 0 : idx) + callingCount;
  const roundsAhead = k + (q.calling ? 1 : 0) + (q.playing.length ? 1 : 0);
  const out: Estimate = { groupsAhead, roundsAhead, from: null, to: null, overrun: false, unknown: null };
  if (booth.paused) {
    out.unknown = "ブースが一時停止中のため、待ち時間の目安を表示できません";
    return out;
  }
  // 進行中の回の残り時間（最後に始まった回が終わるまで）。超過してもマイナスにしない。
  let remMin = 0;
  let remMax = 0;
  const last = q.playing[q.playing.length - 1];
  if (last && last.startedAt) {
    const elapsed = now - last.startedAt;
    remMin = Math.max(0, dMin - elapsed);
    remMax = Math.max(0, dMax - elapsed);
    if (elapsed > dMax) out.overrun = true;
  }
  const callingD = q.calling ? 1 : 0;
  out.from = now + remMin + (callingD + k) * dMin;
  out.to = now + remMax + (callingD + k) * dMax;
  return out;
}

export type Phase = "waiting" | "next" | "called" | "playing" | "done" | "cancelled" | "absent";

export interface ViewerView {
  number: string;
  booth: string;
  boothName: string;
  phase: Phase;
  headline: string;
  detail: string;
  gather: string;
  groupsAhead: number | null;
  roundsAhead: number | null;
  from: number | null;
  to: number | null;
  overrun: boolean;
  unknown: string | null;
  otherDay: boolean;
}

// 参加者の画面に出す文章（管理者が書き換えられる）。{ブース} はブースの表示名、{番号} は受付番号に置き換わる
export type ViewTextKey = "waiting" | "next" | "called" | "playing" | "done" | "cancelled" | "absent" | "otherDay";
export type ViewTexts = Partial<Record<ViewTextKey, { headline?: string; detail?: string }>>;
export const VIEW_TEXT_DEFAULTS: Record<ViewTextKey, { label: string; headline: string; detail: string }> = {
  waiting: { label: "順番待ち", headline: "順番待ち：ほかの場所を回っていただけます", detail: "順番が近づくとこの画面の表示が変わります。ときどき画面をご確認ください。" },
  next: { label: "次の回（もうすぐ）", headline: "次の回です。{ブース}の待機場所へお戻りください", detail: "まもなく呼び出します。待機場所でお待ちください。" },
  called: { label: "呼び出し中", headline: "あなたの番です。スタッフに画面をお見せください", detail: "{ブース}へお越しください。" },
  playing: { label: "参加中", headline: "参加中です", detail: "お楽しみください。" },
  done: { label: "終了", headline: "ご参加ありがとうございました", detail: "" },
  cancelled: { label: "取消", headline: "この予約は取り消されました", detail: "ご不明な点はスタッフにお声がけください。" },
  absent: { label: "不在（呼び出しの時にいなかった）", headline: "{ブース}のスタッフにお声がけください", detail: "呼び出しの時にいらっしゃらなかったため、順番を保留しています。お声がけいただければ、空いている回へご案内します。" },
  otherDay: { label: "別の営業日の予約", headline: "この予約は別の営業日のものです", detail: "スタッフにお声がけください。" },
};
export const VIEW_TEXT_MAX = { headline: 60, detail: 200 };

// ブースの呼び名（表示名を付けていなければ「ブースA」）
export function boothLabel(b: { id: string; name: string }): string {
  return b.name && b.name !== b.id ? b.name : `ブース${b.id}`;
}

function viewText(key: ViewTextKey, part: "headline" | "detail", texts: ViewTexts | undefined, booth: Booth, res: Res): string {
  const custom = texts?.[key]?.[part];
  const t = custom !== undefined && custom !== "" ? custom : VIEW_TEXT_DEFAULTS[key][part];
  return t.replaceAll("{ブース}", boothLabel(booth)).replaceAll("{番号}", label(res));
}

export function viewerView(
  booth: Booth,
  q: BoothQueue,
  res: Res,
  now: number,
  isActiveDay: boolean,
  texts?: ViewTexts,
): ViewerView {
  const T = (key: ViewTextKey) => ({ headline: viewText(key, "headline", texts, booth, res), detail: viewText(key, "detail", texts, booth, res) });
  const base: ViewerView = {
    number: label(res),
    booth: res.booth,
    boothName: booth.name,
    phase: "waiting",
    headline: "",
    detail: "",
    gather: booth.gather,
    groupsAhead: null,
    roundsAhead: null,
    from: null,
    to: null,
    overrun: false,
    unknown: null,
    otherDay: !isActiveDay,
  };
  switch (res.status) {
    case "playing":
      return { ...base, phase: "playing", ...T("playing") };
    case "done":
      return { ...base, phase: "done", ...T("done") };
    case "cancelled":
      return { ...base, phase: "cancelled", ...T("cancelled") };
    case "absent":
      return { ...base, phase: "absent", ...T("absent") };
    case "called":
      return { ...base, phase: "called", ...T("called") };
    case "waiting": {
      if (!isActiveDay) return { ...base, ...T("otherDay") };
      const e = estimate(booth, q, res, now);
      // 「次の回」= 予定の回の先頭で、前にある回（進行中・呼び出し中）が 1 つ以下
      const firstPlanned = q.planned[0]?.some((r) => r.id === res.id) ?? false;
      const next = firstPlanned && e.roundsAhead <= 1 && !booth.paused;
      return { ...base, ...e, phase: next ? "next" : "waiting", ...T(next ? "next" : "waiting") };
    }
  }
}

// ---- 権限 ----
export type Cmd =
  | "issue"
  | "cancel"
  | "restore"
  | "swap"
  | "move"
  | "edit"
  | "reissue"
  | "call"
  | "uncall"
  | "start"
  | "end"
  | "absent"
  | "returnAbsent"
  | "undoStart"
  | "undoEnd"
  | "pause"
  | "boothSet"
  | "notice"
  | "noticeEnd"
  | "templatesSet"
  | "eventSet"
  | "viewerKeyRotate"
  | "viewTextsSet"
  | "sponsorEnable"
  | "sponsorSave"
  | "sponsorDelete"
  | "sponsorMove"
  | "chat"
  | "reqCreate"
  | "reqTake"
  | "reqDone"
  | "reqReopen"
  | "staffCreate"
  | "staffUpdate"
  | "staffRevoke"
  | "daySwitch"
  | "daySet"
  | "counterBump"
  | "unlockNumber"
  | "resetPrepare"
  | "resetExecute"
  | "audit"
  | "dayHistory"
  | "chatMore"
  | "find"
  | "stats"
  | "diag"
  | "sync";

const BOOTH_OPS: Cmd[] = ["call", "uncall", "start", "end", "absent", "returnAbsent", "undoStart", "undoEnd", "pause", "unlockNumber"];
// 受付権限（「受付もできる」）で許可する操作：予約の追加・取消、待ち列の並び替え・メモ修正・ブース変更・復元、お知らせ
const ISSUE_OPS: Cmd[] = ["issue", "cancel", "restore", "swap", "move", "edit", "reissue", "notice", "noticeEnd"];
const ALL_STAFF: Cmd[] = ["chat", "reqCreate", "reqTake", "reqDone", "reqReopen", "sync", "chatMore", "find"];

// サーバー側の権限判定。booth はその操作が対象とするブース（無ければ null）。
export function can(staff: Staff, cmd: Cmd, booth: string | null): boolean {
  if (!staff.active) return false;
  if (ALL_STAFF.includes(cmd)) return true;
  if (staff.role === "admin") return true;
  const own = booth !== null && staff.booths.includes(booth);
  // 人数・金額の集計は受付も見られる
  if (cmd === "stats") return staff.canIssue;
  // 受付権限：担当ブースの受付操作。全体宛てのお知らせ（ブース指定なし）も可
  if (staff.canIssue && ISSUE_OPS.includes(cmd)) return booth === null ? cmd === "notice" || cmd === "noticeEnd" : own;
  // サブ管理者：担当ブースの呼び出し・開始・終了など（お知らせは受付権限がなければ不可）
  if (staff.role === "sub" && BOOTH_OPS.includes(cmd)) return own;
  // それ以外（設定・スタッフ管理・営業日・出力・履歴・全リセット）は全体管理者のみ
  return false;
}

// 確認コード（4 桁、先頭 0 あり）
export function newCode(): string {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 10000).padStart(4, "0");
}

// 受付番号の入力（"a12", "Ａ１２", "A 12" など）を解釈
export function parseNumber(input: string): { booth: string; num: number } | null {
  const s = String(input ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s\-ー－]/g, "");
  const m = /^([A-Z])(\d{1,5})$/.exec(s);
  if (!m) return null;
  return { booth: m[1], num: Number(m[2]) };
}

// 営業日の番号帯の重なりチェック
export interface DayInfo {
  id: number;
  label: string;
  starts: Record<string, number>;
}
export function overlapWarnings(days: DayInfo[], used: Record<string, { min: number; max: number }>): string[] {
  // used: key `${day}:${booth}` -> 実際に発行済みの最小・最大番号
  const out: string[] = [];
  for (const b of BOOTH_IDS) {
    const ranges = days.filter((d) => d.starts[b] !== undefined).map((d) => {
      const u = used[`${d.id}:${b}`];
      return { d, lo: d.starts[b] ?? 1, hi: u ? u.max : (d.starts[b] ?? 1) - 1 };
    });
    for (const r of ranges) {
      for (const o of ranges) {
        if (o.d.id === r.d.id) continue;
        // r の発行済み番号が o の開始番号以上に達した（o の番号帯に入った）
        if (o.lo > r.lo && r.hi >= o.lo) {
          out.push(`ブース${b}: ${r.d.label}の番号が ${b}${r.hi} まで進み、${o.d.label}の開始番号 ${b}${o.lo} 以上になっています。番号が重なる可能性があります（予約は営業日ごとに区別されるため衝突はしません）。`);
        }
        if (o.d.id > r.d.id && o.lo === r.lo) {
          out.push(`ブース${b}: ${r.d.label}と${o.d.label}の開始番号が同じ（${b}${o.lo}）です。`);
        }
      }
    }
  }
  return [...new Set(out)];
}

export function defaultStart(dayId: number): number {
  // 1 日目は 1、2 日目は 201、3 日目以降は 401, 601 ...
  return dayId <= 1 ? 1 : (dayId - 1) * 200 + 1;
}
