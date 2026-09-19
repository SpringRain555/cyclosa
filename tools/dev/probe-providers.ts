/**
 * **每一件事實際會跑哪一個模型** —— 不開瀏覽器就看得到設定頁那張表的內容。
 *
 * ```
 * npx tsx tools/dev/probe-providers.ts
 * ```
 *
 * 它打的是產品那一支 `listProviders`，所以印出來的就是
 * `GET /api/providers` 會回的東西：四列任務、各自的模型與狀態、
 * 以及三個角色的金鑰偵測結果（`none`／`env-set`／`env-missing`）。
 *
 * ## 為什麼值得留一支
 *
 * 「覆寫設了沒有生效」這種問題**在畫面上完全看不出來** ——
 * 它會安靜地用預設模型跑。而要確認的是一句話：
 * **「這個任務現在會跑哪一個」**，那一句在這裡是一行。
 *
 * 換一份設定看就換 `LOCALAPPDATA`，不必動使用者自己那一份：
 * ```
 * LOCALAPPDATA=<臨時目錄> npx tsx tools/dev/probe-providers.ts
 * ```
 *
 * ⚠️ 開發工具。**產品程式碼不 import 它。**
 */
import { listProviders } from '../../src/application/provider-service.js';

const r = await listProviders();
if (!r.ok) {
  console.log('ERR ' + r.code);
} else {
  console.log('tasks:');
  for (const row of r.data.tasks) {
    console.log(
      '  ' +
        row.task.padEnd(14) +
        row.via.padEnd(8) +
        ('model=' + (row.model || '(empty)')).padEnd(28) +
        'state=' +
        row.state.padEnd(16) +
        'ok=' +
        row.ok +
        (row.missing.length > 0 ? '  missing:' + row.missing.join(',') : ''),
    );
  }
  console.log('connections:');
  for (const c of r.data.connections) {
    console.log(
      '  ' +
        c.kind.padEnd(8) +
        c.state.padEnd(16) +
        'auth=' +
        c.auth.padEnd(12) +
        'models=' +
        (c.models === null ? 'null' : String(c.models.length)) +
        (c.version ? '  version=' + c.version : ''),
    );
  }
}
process.exit(0);
