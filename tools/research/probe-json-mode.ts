/**
 * 量一個 OpenAI 相容端點對 `response_format` 的支援程度 —— **用出貨的那一支量**。
 *
 * v0.18.0 的第一條收尾條件是「動手前先量目標端點」。2026-09-11 第一輪是一支
 * 草稿腳本量的；這一支換成直接呼叫 `chat-openai.ts` 的 `checkJson`，
 * 所以**量到的結果就是出貨的程式在那個端點上會得到的結果** ——
 * 不是另一份「應該一樣」的實作。
 *
 * **不寫進使用者的 `provider-checks.json`**：量測用一個臨時的 `LOCALAPPDATA`，
 * 跑完就刪。要讓程式記住結果，到設定頁按「實際打一次」。
 *
 * ## 金鑰
 *
 * 跟出貨的程式一樣**只收環境變數的名字**（`--key-env`），值不經過命令列 ——
 * 命令列會留在 shell 的歷史紀錄裡。
 *
 * ## 會花錢
 *
 * 每個模型一到兩次很小的請求（量測），`--runs N` 就是 N 倍。線上端點會計費。
 *
 * 用法：
 *   npx tsx tools/research/probe-json-mode.ts --base-url <含 /v1> --model <名稱> [--model ...]
 *       [--key-env <環境變數名>] [--runs 3]
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOpenAiChat } from '../../src/infrastructure/providers/chat-openai.js';

function args(name: string): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined) out.push(argv[i + 1] as string);
  }
  return out;
}

async function main(): Promise<number> {
  const baseUrl = args('base-url')[0];
  const models = args('model');
  const keyEnv = args('key-env')[0] ?? null;
  const runs = Number(args('runs')[0] ?? '3');
  if (baseUrl === undefined || models.length === 0) {
    console.error(
      '用法：--base-url <含 /v1> --model <名稱> [--model ...] [--key-env NAME] [--runs 3]',
    );
    return 2;
  }

  const sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-probe-json-'));
  try {
    for (const model of models) {
      const tally = new Map<string, number>();
      for (let i = 0; i < runs; i++) {
        // 每一輪一個新的 LOCALAPPDATA —— 否則第二輪會讀到第一輪記下的結果而不量。
        const env = {
          ...process.env,
          LOCALAPPDATA: join(sandbox, `${model.replace(/\W/g, '_')}-${i}`),
        };
        const chat = createOpenAiChat(baseUrl, model, keyEnv, env);
        const r = await chat.checkJson!();
        const label = r.kind === 'ok' ? r.value.mode : `錯誤 ${r.code}`;
        tally.set(label, (tally.get(label) ?? 0) + 1);
        const detail = r.kind === 'ok' ? r.value.detail : r.detail;
        console.log(
          JSON.stringify({ model, run: i + 1, result: label, ms: r.cost.elapsedMs, detail }),
        );
      }
      const summary = [...tally].map(([k, n]) => `${k} ${n}/${runs}`).join(' · ');
      console.log(`${model}: ${summary}`);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
  return 0;
}

process.exit(await main());
