/**
 * 入口。**這個檔案除了啟動什麼都不做** —— 所有可測試的東西都在 `server.ts`
 * 與 `interface/http/shutdown.ts`。
 *
 * 拆成兩個檔是為了避開「這個模組是不是被當成入口執行」的自我偵測：
 * 那種偵測在 Windows 上特別脆（`file://` URL vs 絕對路徑、大小寫、正反斜線），
 * 而它壞掉的方式是「測試 import 它時默默起了一個真的 server」。
 */
import { probeHealthz } from '@local-app/lifecycle/healthz';
import { buildServer, HOST, PORT, VERSION } from './server.js';
import { shutdownSequence, targetOf } from './interface/http/shutdown.js';
import { installCrashTrace } from './shared/crash-trace.js';
import { logger } from './shared/log.js';

// **最先做。** 自己死掉的時候要留得下一行 —— 見 `shared/crash-trace.ts` 的檔頭。
installCrashTrace();

/**
 * 7433 上的那個是不是我們自己。
 *
 * **只看「有沒有回 200」會把別人跑在 7433 的服務誤認成自己**（ADR-0020），
 * 所以看的是 `app` 欄位。`Launch.ps1` 對同一件事做同一個判斷 ——
 * 那一份不能拿掉，它要在**啟動之前**就決定要不要開瀏覽器。
 */
async function whoHasThePort(): Promise<'cyclosa' | 'other'> {
  const result = await probeHealthz({
    url: `http://${HOST}:${PORT}/healthz`,
    identityKey: 'app',
    identityValue: 'cyclosa',
    timeoutMs: 2_000,
  });
  return result.owner === 'ours' ? 'cyclosa' : 'other';
}

const { app } = await buildServer();

try {
  await app.listen({ host: HOST, port: PORT });
} catch (e) {
  /**
   * **單一實例的判斷要在 app 裡，不能只在啟動器裡。**
   *
   * 到 2026-09-10 為止它只存在於 `Launch.ps1`，於是五條啟動路徑裡只有兩條
   * 擋得住第二個實例 —— `npm start` 撞到埠得到的是一段 `EADDRINUSE` 堆疊，
   * 而使用者想做的事（把 Cyclosa 打開）完全合理。
   *
   * `tagcor-ledger` 對同一件事的做法是把守門放在 `main.py` 裡而不是啟動器裡，
   * 那份設計不管你怎麼啟動都成立 —— **位置比機制重要。**
   */
  const code = (e as { code?: string } | null)?.code;
  if (code !== 'EADDRINUSE') throw e;

  const owner = await whoHasThePort();
  if (owner === 'cyclosa') {
    logger.info('Cyclosa 已經在執行中，不起第二個', { url: `http://${HOST}:${PORT}/` });
    process.exit(0);
  }
  logger.error('連接埠被別的程式佔用', {
    port: PORT,
    hint: '那個程式不是 Cyclosa（/healthz 沒有回 app=cyclosa）。先關掉它再試一次。',
  });
  process.exit(1);
}

logger.info('Cyclosa 已啟動', { url: `http://${HOST}:${PORT}/`, version: VERSION });

/**
 * 訊號觸發的關閉走**同一條序列**（`-Foreground` 的 Ctrl+C 就是這一條）。
 *
 * 沒有回應要送出去，所以 `flushMs` 是 0；其餘一樣：先叫作業停、
 * 有上限地等、收掉連線、`close()` 也有上限。
 */
const shutdown = (signal: string): void => {
  logger.info('收到結束訊號', { signal });
  void shutdownSequence(targetOf(app), { flushMs: 0, graceMs: 1_500, closeMs: 2_000 }).then(
    (outcome) => {
      logger.info('關閉序列完成', { ...outcome });
      process.exit(0);
    },
  );
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
