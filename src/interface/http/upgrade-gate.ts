/**
 * **第一次碰到一個專題時，先把它的舊資料升到新格式，再處理請求**（ADR-0039 第五節）。
 *
 * 帶 `:slug` 的每一個請求進路由之前問一次 `ensureCaseUpgraded` —— 同一個程序裡每個專題只真的做一次，
 * 同時進來的請求等同一次升級。這樣「`readDerived` 只讀現行版」才成立：任何一條讀正文的路，
 * 都在這一道門後面。
 *
 * **不在啟動時把全部專題升完**：那會拖慢啟動，而啟動器等 healthz 是有時限的；沒打開的專題晚一點升，看起來沒有差別。
 * 掛在 `preHandler`：路徑參數那一道（`param-guard.ts`，`preValidation`）已經擋掉不合法的 slug。
 */
import type { FastifyInstance } from 'fastify';

import { ensureCaseUpgraded } from '../../application/case-upgrade.js';
import { isUsableSlug } from '../../domain/case/slug.js';
import type { AppContext } from './routes.js';

export function registerUpgradeGate(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('preHandler', async (req) => {
    if (req.routeOptions.url === undefined) return;
    const slug = (req.params as Readonly<Record<string, unknown>> | undefined)?.['slug'];
    if (typeof slug !== 'string' || !isUsableSlug(slug)) return;
    // 還沒選資料位置：路由自己會說（`requireDataRoot`），這裡沒有東西可以升。
    if (ctx.dataRoot === null) return;
    await ensureCaseUpgraded(ctx.dataRoot, slug);
  });
}
