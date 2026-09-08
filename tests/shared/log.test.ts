/**
 * 日誌的檔案輸出。
 *
 * **這一份存在的理由是「沒有主控台」**：一鍵啟動之後 server 跑在背景，
 * stdout 沒有人看得到，所以「它自己死掉了」這件事只剩這個檔案說得出來。
 * 而一個寫不出東西、或是寫出來會讓程式當掉的日誌，比沒有日誌更糟。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logger } from '../../src/shared/log.js';

let sandbox = '';
let savedLevel: string | undefined;
let savedFile: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-log-'));
  savedLevel = process.env['CYCLOSA_LOG_LEVEL'];
  savedFile = process.env['CYCLOSA_LOG_FILE'];
  // 全域設定是 silent（見 vitest.config.ts）——這一份要真的寫出東西才測得到。
  process.env['CYCLOSA_LOG_LEVEL'] = 'info';
  // stdout 照樣會被寫，而那會塞滿測試輸出。
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedLevel === undefined) delete process.env['CYCLOSA_LOG_LEVEL'];
  else process.env['CYCLOSA_LOG_LEVEL'] = savedLevel;
  if (savedFile === undefined) delete process.env['CYCLOSA_LOG_FILE'];
  else process.env['CYCLOSA_LOG_FILE'] = savedFile;
  await rm(sandbox, { recursive: true, force: true });
});

describe('CYCLOSA_LOG_FILE', () => {
  it('沒設定的時候什麼檔都不寫', () => {
    delete process.env['CYCLOSA_LOG_FILE'];
    expect(() => logger.info('沒有檔案')).not.toThrow();
  });

  it('設定了就一行一個 JSON 附加進去', async () => {
    const path = join(sandbox, 'server.log');
    process.env['CYCLOSA_LOG_FILE'] = path;

    logger.info('第一行', { correlationId: 'cid-1' });
    logger.info('第二行', { correlationId: 'cid-2' });

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(first['msg']).toBe('第一行');
    expect(first['correlationId']).toBe('cid-1');
    expect(typeof first['ts']).toBe('string');
  });

  it('**檔案不是另一條規則比較鬆的路** —— 內容欄位一樣要被遮掉', async () => {
    const path = join(sandbox, 'server.log');
    process.env['CYCLOSA_LOG_FILE'] = path;

    logger.info('抓到了', { quote: '這一句不該進日誌', title: '也不該' });

    const written = await readFile(path, 'utf8');
    expect(written).not.toContain('這一句不該進日誌');
    const row = JSON.parse(written.trim()) as Record<string, unknown>;
    expect(row['quote']).toBe('[redacted]');
    expect(row['title']).toBe('[redacted]');
  });

  it('寫不出去的時候不丟例外 —— 日誌寫不了不該讓程式停下來', () => {
    // 資料夾不存在 → appendFileSync 會丟 ENOENT
    process.env['CYCLOSA_LOG_FILE'] = join(sandbox, 'no-such-dir', 'server.log');
    expect(() => logger.info('照樣要活著')).not.toThrow();
  });
});
