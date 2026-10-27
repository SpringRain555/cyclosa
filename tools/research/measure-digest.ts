/**
 * 初讀（digest）建議值實測（issue #11）：同一份語料、固定主題，比幾個本機模型的
 * schema 有效率、「有沒有關」對 gold 的正確率、unsure 率、秒數。判準與結果在
 * `docs/research/digest-measurement.md`，計分在 `score-digest.ts`。
 *
 * ```powershell
 * npx tsx tools/research/measure-digest.ts --data-root <資料根> --items-file <items.json> --topic-file <topic.json> --gold <gold.jsonl> --models granite4.2:8b,gemma4:12b --rounds 2 [--ollama-url <位址>] [--out <報告資料夾>]
 * ```
 *
 * `items.json`：`[{ "id", "slug", "title", "group": "main" | "control" }]`（主語料與對照組可以在不同專題）。
 * `topic.json`：`{ "topic", "relation", "directions": [] }`。`gold.jsonl`：每行 `{ "itemId", "relevance" }`。
 *
 * ⚠️ 開發工具。**只讀 `derived/`，不開資料庫、不寫專題**；走共用的 `callDigest`（同一份提示詞、
 * 同一個截斷），報告寫在 repo 與資料根之外。gold 不進 repo。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { callDigest } from '../../src/application/digest-call.js';
import { isUsableSlug } from '../../src/domain/case/slug.js';
import { isRelevance, type Relevance } from '../../src/domain/provider/digest.js';
import { readDerived } from '../../src/infrastructure/fs/case-files.js';
import { casesDir } from '../../src/infrastructure/fs/paths.js';
import { createOllamaChat } from '../../src/infrastructure/providers/chat-ollama.js';
import { OLLAMA_DEFAULT_URL } from '../../src/infrastructure/providers/config.js';
import {
  agreement,
  goldUnsureRate,
  hasCjk,
  majorityBaseline,
  scoreRound,
  sentenceCount,
  type DigestRow,
  type Group,
  type RoundScore,
} from './score-digest.js';

interface ItemSpec {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly group: Group;
}

interface TopicSpec {
  readonly topic: string;
  readonly relation: string;
  readonly directions: readonly string[];
}

interface ItemBody extends ItemSpec {
  readonly text: string;
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function isGroup(value: unknown): value is Group {
  return value === 'main' || value === 'control';
}

async function readItems(path: string): Promise<ItemSpec[] | null> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!Array.isArray(raw)) return null;
  const out: ItemSpec[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const row = entry as Record<string, unknown>;
    const { id, slug, title, group } = row;
    if (
      typeof id !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(id) ||
      typeof slug !== 'string' ||
      !isUsableSlug(slug) ||
      typeof title !== 'string' ||
      !isGroup(group)
    ) {
      return null;
    }
    out.push({ id, slug, title, group });
  }
  return out;
}

async function readTopic(path: string): Promise<TopicSpec | null> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const { topic, relation, directions } = raw;
  if (typeof topic !== 'string' || topic.trim().length === 0) return null;
  if (!Array.isArray(directions) || !directions.every((d): d is string => typeof d === 'string')) {
    return null;
  }
  return { topic, relation: typeof relation === 'string' ? relation : '', directions };
}

async function readGold(path: string): Promise<Map<string, Relevance> | null> {
  const gold = new Map<string, Relevance>();
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    const { itemId, relevance } = row;
    if (typeof itemId !== 'string' || !isRelevance(relevance)) return null;
    gold.set(itemId, relevance);
  }
  return gold;
}

function cell(value: string | number | boolean | null): string {
  if (value === null) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value).replace(/[|\r\n]/g, ' ');
}

function percent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(0)}%`;
}

function markdown(report: {
  readonly createdAt: string;
  readonly topic: TopicSpec;
  readonly models: readonly string[];
  readonly rounds: number;
  readonly items: readonly ItemSpec[];
  readonly gold: ReadonlyMap<string, Relevance>;
  readonly rows: readonly DigestRow[];
  readonly scores: readonly RoundScore[];
}): string {
  const baseline = majorityBaseline(report.gold);
  const lines = [
    '# 初讀對照量測',
    '',
    `- 日期：${report.createdAt}`,
    `- 主題：${cell(report.topic.topic)}；方向 ${String(report.topic.directions.length)} 條`,
    `- 份數：${String(report.items.length)}（主語料 ${String(report.items.filter((i) => i.group === 'main').length)}、對照組 ${String(report.items.filter((i) => i.group === 'control').length)}）；gold ${String(report.gold.size)} 份，unsure 占 ${percent(goldUnsureRate(report.gold))}`,
    `- 多數類基準線：${baseline === null ? '—' : `全判 ${baseline.label} → ${percent(baseline.accuracy)}`}`,
    '- 不設通過門檻；中位數秒數不含每輪第一份（冷啟動另列）。',
    '',
    '| 模型 | 輪 | 份數 | Schema 有效 | 正確率 | 反轉 | unsure 率 | 對照組全 no | 中位數秒 | 冷啟動秒 | 繁中標題 | 摘要 ≤3 句 |',
    '|---|:-:|---:|---:|---:|---:|---:|:-:|---:|---:|---:|---:|',
  ];
  for (const s of report.scores) {
    lines.push(
      `| ${cell(s.model)} | ${String(s.round)} | ${String(s.n)} | ${String(s.schemaValid)} | ${percent(s.accuracy)}（${String(s.exact)}／${String(s.scored)}）| ${String(s.inversions)} | ${percent(s.unsureRate)} | ${cell(s.controlAllNo)}（${String(s.controlNo)}／${String(s.controlN)}）| ${cell(s.medianSeconds)} | ${cell(s.coldSeconds)} | ${String(s.titleZhOk)} | ${String(s.summaryLe3)} |`,
    );
  }
  lines.push('', '## 兩輪一致率', '');
  for (const model of report.models) {
    const byRound = (round: number): DigestRow[] =>
      report.rows.filter((r) => r.model === model && r.round === round);
    for (let round = 2; round <= report.rounds; round += 1) {
      const a = agreement(byRound(round - 1), byRound(round));
      lines.push(
        `- ${cell(model)}：第 ${String(round - 1)}／${String(round)} 輪相同 ${String(a.same)}／${String(a.of)}`,
      );
    }
  }
  const header = ['| 份 | 組 | gold |'];
  const divider = ['|---|---|:-:|'];
  for (const model of report.models) {
    for (let round = 1; round <= report.rounds; round += 1) {
      header.push(` ${cell(model)} #${String(round)} |`);
      divider.push(':-:|');
    }
  }
  lines.push('', '## 逐份', '', header.join(''), divider.join(''));
  for (const item of report.items) {
    const cells = [
      `| ${cell(item.title)} | ${item.group} | ${cell(report.gold.get(item.id) ?? null)} |`,
    ];
    for (const model of report.models) {
      for (let round = 1; round <= report.rounds; round += 1) {
        const row = report.rows.find(
          (r) => r.itemId === item.id && r.model === model && r.round === round,
        );
        cells.push(` ${row === undefined ? '—' : cell(row.relevance ?? row.code)} |`);
      }
    }
    lines.push(cells.join(''));
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<number> {
  const dataRootArg = arg('data-root');
  const itemsPath = arg('items-file');
  const topicPath = arg('topic-file');
  const goldPath = arg('gold');
  const modelsArg = arg('models');
  const roundsArg = arg('rounds') ?? '2';
  if (
    dataRootArg === null ||
    itemsPath === null ||
    topicPath === null ||
    goldPath === null ||
    modelsArg === null
  ) {
    console.error(
      '用法：npx tsx tools/research/measure-digest.ts --data-root <資料根> --items-file <items.json> --topic-file <topic.json> --gold <gold.jsonl> --models <a,b> [--rounds 2] [--ollama-url <位址>] [--out <報告資料夾>]',
    );
    return 2;
  }
  const models = modelsArg
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  const rounds = Number(roundsArg);
  if (models.length === 0 || !Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
    console.error('--models 至少一個；--rounds 是 1 到 5 的整數。');
    return 2;
  }

  const dataRoot = resolve(dataRootArg);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const outputArg = arg('out');
  const outputDir =
    outputArg === null ? join(tmpdir(), `cyclosa-digest-measure-${stamp()}`) : resolve(outputArg);
  if (inside(repoRoot, outputDir) || inside(dataRoot, outputDir)) {
    console.error('--out 必須在 repo 與資料根之外。');
    return 2;
  }

  const [items, topic, gold] = await Promise.all([
    readItems(itemsPath),
    readTopic(topicPath),
    readGold(goldPath),
  ]);
  if (items === null || items.length === 0) {
    console.error('items.json 的每一列都要有 id、slug、title 與 group（main／control）。');
    return 2;
  }
  if (topic === null) {
    console.error('topic.json 要有 topic 與 directions。');
    return 2;
  }
  if (gold === null) {
    console.error('gold.jsonl 的每一行都要有 itemId 與 relevance（yes／no／unsure）。');
    return 2;
  }

  const bodies: ItemBody[] = [];
  for (const item of items) {
    const derived = await readDerived(join(casesDir(dataRoot), item.slug), item.id);
    if (derived === null || typeof derived.text !== 'string' || derived.text.trim().length === 0) {
      console.error(`找不到 ${item.slug} 裡項目 ${item.id} 的衍生正文。`);
      return 1;
    }
    bodies.push({ ...item, text: derived.text });
  }

  // 量測的格式紀錄不要寫進使用者的設定。
  const scratch = await mkdtemp(join(tmpdir(), 'cyclosa-digest-measure-checks-'));
  const env: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: scratch };
  const ollamaUrl = arg('ollama-url') ?? OLLAMA_DEFAULT_URL;
  const rows: DigestRow[] = [];
  try {
    for (const model of models) {
      const chat = createOllamaChat(ollamaUrl, model, null, env);
      for (let round = 1; round <= rounds; round += 1) {
        for (const [index, body] of bodies.entries()) {
          const { call, digest } = await callDigest(
            chat,
            {
              topic: topic.topic,
              relation: topic.relation,
              directions: topic.directions,
              title: body.title,
              url: '',
              excerpt: body.text,
            },
            new AbortController(),
          );
          const ok = call.kind === 'ok' && digest !== null;
          rows.push({
            itemId: body.id,
            group: body.group,
            model,
            round,
            cold: index === 0,
            schemaValid: ok,
            relevance: digest?.relevance ?? null,
            titleZhOk: digest === null ? null : digest.titleZh.length > 0 && hasCjk(digest.titleZh),
            summaryLe3: digest === null ? null : sentenceCount(digest.summaryZh) <= 3,
            seconds: call.cost.elapsedMs / 1000,
            code: call.kind === 'error' ? call.code : ok ? null : 'DIGEST_NOT_NORMALIZED',
          });
          const last = rows[rows.length - 1]!;
          console.log(
            `${model} #${String(round)} ${String(index + 1)}/${String(bodies.length)} ${cell(body.title).slice(0, 40)} → ${last.relevance ?? last.code ?? '?'} ${cell(last.seconds)}s`,
          );
        }
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const scores: RoundScore[] = [];
  for (const model of models) {
    for (let round = 1; round <= rounds; round += 1) {
      scores.push(
        scoreRound(
          rows.filter((r) => r.model === model && r.round === round),
          gold,
        ),
      );
    }
  }
  const report = {
    createdAt: new Date().toISOString(),
    topic,
    models,
    rounds,
    items,
    gold,
    rows,
    scores,
  };
  await mkdir(outputDir, { recursive: true });
  const baseName = `digest-measurement-${stamp()}`;
  const jsonPath = join(outputDir, `${baseName}.json`);
  const markdownPath = join(outputDir, `${baseName}.md`);
  await writeFile(
    jsonPath,
    `${JSON.stringify({ ...report, gold: Object.fromEntries(gold) }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(markdownPath, markdown(report), 'utf8');
  console.log(`JSON 報告：${jsonPath}`);
  console.log(`Markdown 報告：${markdownPath}`);
  return 0;
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
