/**
 * 「金鑰的環境變數名稱」那一格，**前後端用的是同一條規則**。
 *
 * 伺服器不收的名字會被 `apiKeyEnvOf` 丟成 `null` —— 存檔仍然成功，
 * 而畫面重新載入之後那一格是空的。**症狀是「我打的字不見了」**，
 * 沒有任何錯誤訊息。2026-09-18 真的踩到（一個結尾小寫的變數名）。
 *
 * 前端因此自己也驗一次，好在按下儲存之前就說。**兩份拷貝會漂**，
 * 所以這一條逼它們逐字一致。
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/** 從一份原始碼裡抓出那一條 regex 字面量。**抓不到就是壞了**，不是「跳過」。 */
function patternIn(source: string, label: string): string {
  const found = /\/\^\[A-Z\]\[A-Z0-9_\]\{1,63\}\$\//.exec(source);
  if (found === null) throw new Error(`${label} 裡找不到那條 regex —— 兩邊的形狀變了就要一起改`);
  return found[0];
}

describe('金鑰環境變數名稱的規則', () => {
  it('伺服器與畫面用的是同一條 regex', async () => {
    const server = await readFile('src/infrastructure/providers/config.ts', 'utf8');
    const web = await readFile('web/src/views/SettingsView.vue', 'utf8');
    expect(patternIn(web, 'SettingsView.vue')).toBe(patternIn(server, 'providers/config.ts'));
  });

  it('那條規則本身：擋得住貼進來的金鑰，收得下正常的變數名', () => {
    const rule = /^[A-Z][A-Z0-9_]{1,63}$/;
    expect(rule.test('OPENAI_API_KEY')).toBe(true);
    expect(rule.test('OPENAI_API_KEY_V1')).toBe(true);
    // 真的金鑰：有小寫、有減號、而且很長。
    expect(rule.test('sk-proj-abcdef0123456789')).toBe(false);
    expect(rule.test('OPENAI_API_KEY_v1')).toBe(false);
    expect(rule.test('1KEY')).toBe(false);
    expect(rule.test('A')).toBe(false);
  });
});
