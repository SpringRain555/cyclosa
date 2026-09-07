/**
 * 匯入管線的端對端測試。
 *
 * **對一台起在 `127.0.0.1` 的伺服器抓**，不碰外面的網路 ——
 * 一個會連外的測試遲早會因為別人的網站改版而變紅，而那時沒有人分得出
 * 「我們壞了」與「他們改了」。
 *
 * 這一份要證明的是四件會被違反的事：
 *
 * 1. **部分失敗是一等公民**：40 個 URL 有 3 個失敗，其餘照常寫入。
 * 2. **同網域間隔 ≥ 3 秒，而且量得到**（伺服器端的時間戳序列）。
 * 3. **robots 不准的不抓，而且記下原因**（不是靜默跳過）。
 * 4. **同一份內容不建第二個節點**（靠 SHA-256，不是靠 URL）。
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCase } from '../../src/application/case-service.js';
import { isActive, startUrlImport } from '../../src/application/ingest-service.js';
import { getRun } from '../../src/application/run-service.js';
import { getItemContent, listItems } from '../../src/application/item-service.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';

const ARTICLE = `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
<title>測試用的一篇文章</title></head><body>
<nav><a href="/a">首頁</a><a href="/b">關於</a></nav>
<article>
<h1>測試用的一篇文章</h1>
<p>這是一段夠長的中文正文，用來確認抽取器真的抽得出東西，而不是只回傳一個空字串。
語言偵測需要足夠的樣本才會給出答案，所以這一段刻意寫得長一點。</p>
<p>第二段繼續講同一件事。關聯圖、擷取管線、快照不可變、部分失敗是一等公民，
這些詞出現在這裡是為了讓中文的 bigram 索引有東西可以切。</p>
<p>第三段。台積電、疫情、關聯，這些兩個字的詞是中文檢索最常見的長度，
而那正是 FTS5 的 trigram 完全命中不到的長度。</p>
<p>第四段。這一份測試資料刻意寫到超過兩百五十個字元，因為抽取信心的門檻之一
就是正文長度。短於那條線的東西在量測裡一致被人工判讀為「不是正文」，
所以如果這篇假文章寫得太短，它會被正確地標成低信心 —— 那樣測到的就不是
我們想測的東西了。</p>
<p>第五段。快照存的是原始位元組而且不可變，衍生物可以整批刪掉重算，
點註錨在快照上所以抽取換版之後不會漂掉。這幾句話同時也讓這篇文章的長度
超過門檻，讓上面那個斷言測的是抽取管線而不是門檻本身。</p>
</article>
<footer>頁尾</footer></body></html>`;

let server: Server;
let base = '';
let dataRoot = '';
let slug = '';
const hits: { readonly path: string; readonly at: number }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    hits.push({ path, at: Date.now() });

    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /blocked\n');
      return;
    }
    if (path === '/article' || path === '/same') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ARTICLE);
      return;
    }
    if (path === '/blocked') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>不該被抓到</body></html>');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${port}`;

  dataRoot = await mkdtemp(join(tmpdir(), 'cyclosa-ingest-'));
  const created = await createCase(dataRoot, { name: '匯入測試' });
  expect(created.ok).toBe(true);
  if (created.ok) slug = created.data.slug;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dataRoot.length > 0) await rm(dataRoot, { recursive: true, force: true });
});

async function waitForRun(runId: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (!isActive(runId)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('作業沒有在時限內結束');
}

describe('匯入一批 URL', () => {
  it('四個輸入、四種結果，而且整批不會因為其中兩個失敗就消失', async () => {
    const started = await startUrlImport(dataRoot, slug, [
      `${base}/article`,
      `${base}/missing`,
      `${base}/blocked`,
      `${base}/same`,
    ]);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForRun(started.data.runId);

    const detail = await getRun(dataRoot, slug, started.data.runId);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;

    // **`部分失敗` 不是「失敗」的一種。**
    expect(detail.data.run.status).toBe('partial');
    expect(detail.data.run.succeeded).toBe(2); // 抓到的 ＋ 重複的
    expect(detail.data.run.failed).toBe(2); // 404 ＋ robots

    const byRequest = new Map(detail.data.items.map((i) => [i.requested, i]));
    expect(byRequest.get(`${base}/article`)?.outcome).toBe('ok');
    expect(byRequest.get(`${base}/missing`)?.outcome).toBe('failed');
    expect(byRequest.get(`${base}/missing`)?.code).toBe('FETCH_HTTP_4XX');

    // **記錄原因，不是靜默跳過。**
    expect(byRequest.get(`${base}/blocked`)?.outcome).toBe('failed');
    expect(byRequest.get(`${base}/blocked`)?.code).toBe('FETCH_ROBOTS_DISALLOWED');

    // **同一份內容不建第二個節點**（`/same` 的位元組與 `/article` 相同）。
    expect(byRequest.get(`${base}/same`)?.outcome).toBe('duplicate');
    expect(byRequest.get(`${base}/same`)?.code).toBe('FETCH_DUPLICATE');
    expect(byRequest.get(`${base}/same`)?.itemId).toBe(byRequest.get(`${base}/article`)?.itemId);
  }, 120_000);

  it('**robots 不准的那一個，伺服器完全沒有收到請求**', () => {
    expect(hits.some((h) => h.path === '/blocked')).toBe(false);
    expect(hits.some((h) => h.path === '/robots.txt')).toBe(true);
  });

  it('**同網域的請求間隔 ≥ 3 秒，而且是從伺服器端量的**', () => {
    // 2900 而不是 3000：計時器的解析度與 `Date.now()` 的粒度會差幾毫秒。
    // 精確的界線由 `waitMs` 的單元測試守著；這裡要證明的是「節流真的存在」——
    // 沒有節流的話這些間隔會是個位數毫秒。
    for (let i = 1; i < hits.length; i++) {
      const gap = (hits[i]?.at ?? 0) - (hits[i - 1]?.at ?? 0);
      expect(gap).toBeGreaterThanOrEqual(2_900);
    }
    expect(hits.length).toBeGreaterThanOrEqual(4);
  });

  it('抓到的那一份：快照、衍生物、索引、節點都在', async () => {
    const page = await listItems(dataRoot, slug, { sort: 'recent' });
    expect(page.ok).toBe(true);
    if (!page.ok) return;

    // 404 與 robots 那兩個也各自留下一個「失敗」的節點 —— 它們可以重試。
    expect(page.data.items).toHaveLength(3);

    const good = page.data.items.find((i) => i.status === 'included');
    expect(good).toBeDefined();
    if (good === undefined) return;

    expect(good.title).toBe('測試用的一篇文章');
    expect(good.lang).toBe('cmn');
    expect(good.lowConfidence).toBe(false);
    expect(good.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(good.mime).toBe('text/html');

    const failed = page.data.items.filter((i) => i.status === 'failed');
    expect(failed).toHaveLength(2);
    expect(failed.map((f) => f.errorCode).sort()).toEqual([
      'FETCH_HTTP_4XX',
      'FETCH_ROBOTS_DISALLOWED',
    ]);

    // 快照存在，而且大小對得上
    const folder = join(dataRoot, 'cases', slug);
    const snapshot = await stat(join(folder, 'sources', `${good.sha256}.html`));
    expect(snapshot.size).toBe(good.byteSize);

    // 衍生物讀得回來
    const content = await getItemContent(dataRoot, slug, good.id);
    expect(content.ok).toBe(true);
    if (content.ok) {
      expect(content.data.derived?.text).toContain('部分失敗是一等公民');
      expect(content.data.derived?.kind).toBe('web');
    }

    // **索引在匯入時就寫了**，不是等 Stage 12
    const opened = await openCaseDatabase(join(folder, 'case.sqlite'));
    expect(opened.kind).toBe('ok');
    if (opened.kind !== 'ok') return;
    try {
      const grams = opened.db
        .prepare('SELECT COUNT(*) AS n FROM bigram WHERE owner_id = ?')
        .get(good.id) as { n?: unknown };
      expect(Number(grams?.n ?? 0)).toBeGreaterThan(20);

      // 中文走 bigram，**不進 FTS5**
      const fts = opened.db
        .prepare('SELECT COUNT(*) AS n FROM fts_text WHERE owner_id = ?')
        .get(good.id) as { n?: unknown };
      expect(Number(fts?.n ?? 0)).toBe(0);

      // 查得到兩個字的詞 —— 這是 trigram 命中 0 列那個實測反例的驗收
      const hit = opened.db.prepare("SELECT owner_id FROM bigram WHERE gram = '台積'").all() as {
        owner_id?: unknown;
      }[];
      expect(hit.map((h) => String(h['owner_id']))).toContain(good.id);

      const rank = opened.db
        .prepare('SELECT title_rank AS r FROM item WHERE id = ?')
        .get(good.id) as {
        r?: unknown;
      };
      expect(String(rank?.r ?? '')).toMatch(/^\d{8}$/);
    } finally {
      opened.db.close();
    }

    // **每次擷取寫一列 manifest**（含被判為重複的那一次）
    const manifest = await readFile(join(folder, 'manifest.jsonl'), 'utf8');
    const lines = manifest
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(4);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.filter((p) => p['status'] === 'failed')).toHaveLength(2);
    expect(parsed.some((p) => p['code'] === 'FETCH_DUPLICATE')).toBe(true);
  });
});
