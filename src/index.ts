// 入口の Worker。静的ファイル以外（/api/*, /ws）をイベント用 Durable Object に転送するだけの薄い層。
// Workers 無料プランの CPU 上限（10ms）に収まるよう、ここでは重い処理をしない。
export { EventDO } from "./event";

export interface Env {
  EVENT: DurableObjectNamespace;
  ASSETS: Fetcher;
  SETUP_TOKEN?: string;
  ENV_LABEL?: string;
}

// イベント全体を 1 個の Durable Object で管理する（全操作を直列化して番号重複・二重開始を防ぐ）
const EVENT_OBJECT_NAME = "event-main";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws" || url.pathname.startsWith("/api/")) {
      const stub = env.EVENT.get(env.EVENT.idFromName(EVENT_OBJECT_NAME));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
