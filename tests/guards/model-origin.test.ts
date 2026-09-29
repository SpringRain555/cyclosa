/**
 * 守門：**建議值只從非中國來源的模型挑，底座或蒸餾來源是中國模型的也算**（ADR-0035，永久規則）。
 *
 * ## 為什麼是守門測試，而不是一句規則
 *
 * 建議值散在兩份程式碼（`config.ts` 與 `SettingsView.vue`，`recommended-models` 守著兩份一致）、
 * 設定頁的推薦理由（`zh-TW.ts`）與 `README.md`。2026-09-29 之前三處全部是 `qwen` —— 而那時候沒有人覺得它錯，
 * 因為那時候它不是錯的。**規則變了之後，最容易漏的是「下一次有人照量測結果改建議值」**：
 * 量出來最好的那一個剛好是中國來源的，而改的人不知道有這條規則。
 *
 * ## 兩道
 *
 * 1. **allowlist**：每一個建議值都要命中下面那張來源表上的一個家族 —— 認不得的家族一律紅。
 *    用 allowlist 不用 denylist，是因為 denylist 只擋得到「已經想到的」；新出一個中國模型，denylist 不會知道
 * 2. **畫面與 README 的文字**不得提到常見的中國來源家族（這一道是 denylist，只擋推薦文字 ——
 *    歷史文件、量測紀錄、changelog 豁免，那些是紀錄不是推薦）
 *
 * **來源表是查證過的事實，不是印象**：每一列寫出處與查證日（HF model API 的授權欄、model card 的 base model）。
 * 加一列之前先查那兩樣 —— `snowflake-arctic-embed2` 是美國公司發的，card 寫 builds on `BAAI/bge-m3-retromae`，
 * 發布者那一欄過得了，底座那一欄過不了。
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { embedFamilyName } from '../../src/domain/search/embed-prefix.js';
import {
  RECOMMENDED_CHAT_MODEL,
  RECOMMENDED_EMBED_MODEL,
  RECOMMENDED_TASK_MODELS,
} from '../../src/infrastructure/providers/config.js';

interface Origin {
  /** 正規化之後的模型名（`embedFamilyName`）以它開頭就算這一族。 */
  readonly family: string;
  readonly publisher: string;
  readonly country: string;
  /** 底座（card 的 `base_model` 或正文寫的）。 */
  readonly base: string;
  readonly license: string;
  readonly checked: string;
}

/** 2026-09-29 查證（`docs/research/sources/manifest.jsonl` 那一天的 `huggingface.co/api/models/…` 各列）。 */
const ALLOWED: readonly Origin[] = [
  {
    family: 'granite',
    publisher: 'IBM',
    country: '美國',
    base: 'granite-4.1-*-base（IBM 自己的）；嵌入模型沒有宣告外部底座',
    license: 'Apache-2.0',
    checked: '2026-09-29',
  },
  {
    family: 'gemma4',
    publisher: 'Google',
    country: '美國',
    base: 'gemma-4-*（Google 自己的）',
    license: 'Apache-2.0（Gemma 4 起；translategemma、embeddinggemma 仍是 gemma 條款）',
    checked: '2026-09-29',
  },
  {
    family: 'ministral-3',
    publisher: 'Mistral AI',
    country: '法國',
    base: 'Ministral-3-*-Base-2512（Mistral 自己的）',
    license: 'Apache-2.0',
    checked: '2026-09-29',
  },
  {
    family: 'mistral-small',
    publisher: 'Mistral AI',
    country: '法國',
    base: 'Mistral-Small-3.1-24B-Base-2503（Mistral 自己的）',
    license: 'Apache-2.0',
    checked: '2026-09-29',
  },
  {
    family: 'phi4',
    publisher: 'Microsoft',
    country: '美國',
    base: 'card 沒有宣告外部底座（微軟自己訓練）',
    license: 'MIT',
    checked: '2026-09-29',
  },
  {
    family: 'olmo-3',
    publisher: 'Allen Institute for AI',
    country: '美國',
    base: 'Olmo-3-7B-Instruct-DPO（AI2 自己的）',
    license: 'Apache-2.0',
    checked: '2026-09-29',
  },
  {
    family: 'multilingual-e5',
    publisher: 'Microsoft',
    country: '美國',
    base: 'XLM-RoBERTa large（Meta）',
    license: 'MIT',
    checked: '2026-09-29',
  },
  {
    family: 'paraphrase-multilingual',
    publisher: 'sentence-transformers（UKP Lab）',
    country: '德國',
    base: 'XLM-RoBERTa（Meta），由 paraphrase-mpnet-base-v2 蒸餾',
    license: 'Apache-2.0',
    checked: '2026-09-29',
  },
  {
    family: 'nomic-embed-text-v2',
    publisher: 'Nomic AI',
    country: '美國',
    base: 'nomic-embed-text-v2-moe-unsupervised（Nomic 自己的）',
    license: 'Apache-2.0',
    checked: '2026-09-29',
  },
];

/**
 * 推薦文字裡不該出現的家族名。**不是完整清單**（完整的擋法是上面的 allowlist）——
 * 它擋的是「畫面上寫著建議你用某某」這一種漂移。字邊界寫進去，免得 `constellation` 這種字誤中。
 */
const DENIED_IN_TEXT: readonly RegExp[] = [
  /\bqwen/i,
  /\bbge-m3\b/i,
  /\bdeepseek/i,
  /\bchatglm|\bglm-\d/i,
  /\binternlm/i,
  /\bminicpm/i,
  /\bbaichuan/i,
  /\bhunyuan/i,
  /\bdoubao/i,
  /\bgte-(?:multilingual|base|large|qwen)/i,
  /\bsnowflake-arctic-embed/i,
];

function originOf(model: string): Origin | undefined {
  const family = embedFamilyName(model);
  return ALLOWED.find((o) => family.startsWith(o.family));
}

const recommended: readonly [string, string][] = [
  ['RECOMMENDED_CHAT_MODEL', RECOMMENDED_CHAT_MODEL],
  ['RECOMMENDED_EMBED_MODEL', RECOMMENDED_EMBED_MODEL],
  ...Object.entries(RECOMMENDED_TASK_MODELS).map(
    ([task, model]) => [`RECOMMENDED_TASK_MODELS.${task}`, model] as [string, string],
  ),
];

describe('建議值只從非中國來源的模型挑（ADR-0035）', () => {
  it.each(recommended)('%s（%s）在來源表上', (_name, model) => {
    expect(model.length).toBeGreaterThan(0);
    expect(originOf(model), `${model} 不在來源表上 —— 先查授權與底座，再加一列`).toBeDefined();
  });

  it('來源表每一列都寫了出處欄位', () => {
    for (const o of ALLOWED) {
      expect(
        o.publisher.length * o.country.length * o.base.length * o.license.length,
      ).toBeGreaterThan(0);
      expect(o.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('畫面與 README 不推薦中國來源的模型', () => {
  it.each([
    ['web/src/i18n/zh-TW.ts', '../../web/src/i18n/zh-TW.ts'],
    ['README.md', '../../README.md'],
  ])('%s', async (_label, path) => {
    const text = await readFile(new URL(path, import.meta.url), 'utf8');
    for (const pattern of DENIED_IN_TEXT) {
      expect(text, `${_label} 出現了 ${pattern.source}`).not.toMatch(pattern);
    }
  });
});
