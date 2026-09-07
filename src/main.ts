/**
 * 入口。**這個檔案除了啟動什麼都不做** —— 所有可測試的東西都在 `server.ts`。
 *
 * 拆成兩個檔是為了避開「這個模組是不是被當成入口執行」的自我偵測：
 * 那種偵測在 Windows 上特別脆（`file://` URL vs 絕對路徑、大小寫、正反斜線），
 * 而它壞掉的方式是「測試 import 它時默默起了一個真的 server」。
 */
import { buildServer, HOST, PORT, VERSION } from './server.js';
import { logger } from './shared/log.js';

const { app } = await buildServer();
await app.listen({ host: HOST, port: PORT });
logger.info('Cyclosa 已啟動', { url: `http://${HOST}:${PORT}/`, version: VERSION });

const shutdown = (signal: string): void => {
  logger.info('收到結束訊號', { signal });
  void app.close().then(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
