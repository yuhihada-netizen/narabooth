// スタッフ画面を、通信できない時でも開き直せるようにする仕組み（サービスワーカー）。
// ・画面のファイル（HTML・JS・CSS）を端末に保存しておき、通信できない時だけ保存した物を使う。
// ・通信できる時は毎回サーバーから最新を取る（修正版は再読み込みで反映される）。
// ・予約データ（/api/・/ws）は扱わない。データは今まで通りリアルタイム接続で同期する。
// ・画面のファイルの配信は Cloudflare の無料・無制限の部分なので、無料枠（1日10万リクエスト等）は使わない。
const CACHE = "nazo-staff-v1";
const CORE = ["/staff/", "/staff/staff.js", "/staff/staff.css", "/style.css", "/conn.js"];
const NET_WAIT = 4000; // これ以上応答が無ければ保存した物を表示する（電波が弱い時に待たせない）

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(CACHE);
      await Promise.all(CORE.map(async (u) => {
        try {
          const r = await fetch(u, { cache: "no-cache" });
          if (r.ok && !r.redirected) await c.put(u, r);
        } catch {}
      }));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname === "/ws") return;
  if (req.cache === "no-store") return; // 版の確認など、必ずサーバーに問い合わせるもの
  e.respondWith(networkFirst(e, req, url));
});

async function networkFirst(e, req, url) {
  const c = await caches.open(CACHE);
  const key = req.mode === "navigate" ? url.pathname : url.pathname + url.search;
  const net = fetch(req).then((r) => {
    if (r.ok && !r.redirected && r.type === "basic") e.waitUntil(c.put(key, r.clone()).catch(() => {}));
    return r;
  });
  const cached = async () => (await c.match(key)) ?? (req.mode === "navigate" ? await c.match("/staff/") : undefined);
  try {
    return await Promise.race([net, new Promise((_, ng) => setTimeout(() => ng(new Error("slow")), NET_WAIT))]);
  } catch {
    const hit = await cached();
    if (hit) return hit;
    return net; // 保存も無い場合は、通信の結果をそのまま待つ
  }
}
