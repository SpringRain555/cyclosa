/**
 * Compare extraction on three selected item bodies without applying any extraction to the case.
 *
 * ```powershell
 * npx tsx tools/dev/measure-extract.ts --data-root <data-root> --slug <case-slug> --items <id1>,<id2>,<id3> --endpoint "<AMD endpoint>" --model gpt-oss-120b
 * ```
 *
 * ⚠️ Developer tool. It reads derived files only, sends their text to the selected providers,
 * and writes JSON/Markdown reports outside the repository and data root.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { callExtract } from '../../src/application/extraction-call.js';
import { locateQuote } from '../../src/domain/provider/quote.js';
import { createOllamaChat } from '../../src/infrastructure/providers/chat-ollama.js';
import { createOpenAiChat } from '../../src/infrastructure/providers/chat-openai.js';
import type { OpenAiProtocol } from '../../src/infrastructure/providers/json-checks.js';
import type { ChatProvider } from '../../src/infrastructure/providers/types.js';
import { isUsableSlug } from '../../src/domain/case/slug.js';
import { casesDir } from '../../src/infrastructure/fs/paths.js';
import { readDerived } from '../../src/infrastructure/fs/case-files.js';
import { OLLAMA_DEFAULT_URL } from '../../src/infrastructure/providers/config.js';

interface ItemBody {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

interface Row {
  readonly itemId: string;
  readonly provider: 'openai-compatible' | 'ollama';
  readonly model: string;
  readonly protocol: OpenAiProtocol | 'ollama-native' | null;
  readonly schemaValid: boolean | null;
  readonly relationCount: number | null;
  readonly quoteHits: number | null;
  readonly quoteTotal: number | null;
  readonly seconds: number | null;
  readonly code: string | null;
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

function schemaValidity(code: string | null): boolean | null {
  if (code === null) return true;
  if (code === 'PROVIDER_OUTPUT_UNPARSEABLE' || code === 'PROVIDER_OUTPUT_SCHEMA_MISMATCH') {
    return false;
  }
  return null;
}

async function rowFor(
  item: ItemBody,
  provider: ChatProvider,
  name: Row['provider'],
  model: string,
  protocol: Row['protocol'],
): Promise<Row> {
  const outcome = await callExtract(provider, item, new AbortController());
  if (outcome.kind === 'error') {
    return {
      itemId: item.id,
      provider: name,
      model,
      protocol,
      schemaValid: schemaValidity(outcome.code),
      relationCount: null,
      quoteHits: null,
      quoteTotal: null,
      seconds: outcome.elapsedMs / 1000,
      code: outcome.code,
    };
  }
  const relations = outcome.extraction.relations;
  return {
    itemId: item.id,
    provider: name,
    model,
    protocol,
    schemaValid: true,
    relationCount: relations.length,
    quoteHits: relations.filter(
      (relation) => locateQuote(item.text, relation.quote).kind === 'found',
    ).length,
    quoteTotal: relations.length,
    seconds: outcome.elapsedMs / 1000,
    code: null,
  };
}

function cell(value: string | number | boolean | null): string {
  if (value === null) return '—';
  return String(value).replace(/[|\r\n]/g, ' ');
}

function markdown(report: {
  readonly createdAt: string;
  readonly caseSlug: string;
  readonly itemIds: readonly string[];
  readonly rows: readonly Row[];
}): string {
  const lines = [
    '# 抽取對照量測',
    '',
    `- 日期：${report.createdAt}`,
    `- 專題代號：${report.caseSlug}`,
    `- 項目數：${report.itemIds.length}`,
    '- 預檢時間不計入抽取秒數；不設通過門檻。',
    '',
    '| 項目 ID | 服務 | 模型 | 協定 | Schema 有效 | 關聯數 | 引文命中／總數 | 秒數 | 錯誤碼 |',
    '|---|---|---|---|---|---:|---:|---:|---|',
  ];
  for (const row of report.rows) {
    lines.push(
      `| ${cell(row.itemId)} | ${cell(row.provider)} | ${cell(row.model)} | ${cell(row.protocol)} | ${cell(row.schemaValid)} | ${cell(row.relationCount)} | ${cell(row.quoteHits)} / ${cell(row.quoteTotal)} | ${cell(row.seconds)} | ${cell(row.code)} |`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}`;
}

async function main(): Promise<number> {
  const dataRootArg = arg('data-root');
  const slug = arg('slug');
  const itemArg = arg('items');
  const endpointArg = arg('endpoint');
  const model = arg('model');
  if (
    dataRootArg === null ||
    slug === null ||
    itemArg === null ||
    endpointArg === null ||
    model === null
  ) {
    console.error(
      '用法：npx tsx tools/dev/measure-extract.ts --data-root <資料根> --slug <專題> --items <id1>,<id2>,<id3> --endpoint "<AMD 端點>" --model gpt-oss-120b [--ollama-url <Ollama 位址>] [--out <報告資料夾>]',
    );
    return 2;
  }

  const itemIds = itemArg.split(',').map((id) => id.trim());
  if (
    !isUsableSlug(slug) ||
    itemIds.length !== 3 ||
    new Set(itemIds).size !== 3 ||
    itemIds.some((id) => !/^[A-Za-z0-9_-]+$/.test(id))
  ) {
    console.error('slug 必須是安全的專題代號；--items 需要三個不同的項目 ID。');
    return 2;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(endpointArg);
  } catch {
    console.error('--endpoint 必須是完整的 HTTP 或 HTTPS URL。');
    return 2;
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    console.error('--endpoint 必須是 HTTP 或 HTTPS URL。');
    return 2;
  }

  const dataRoot = resolve(dataRootArg);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const caseFolder = join(casesDir(dataRoot), slug);
  const outputArg = arg('out');
  const outputDir =
    outputArg === null ? join(tmpdir(), `cyclosa-extract-measure-${stamp()}`) : resolve(outputArg);
  if (inside(repoRoot, outputDir) || inside(dataRoot, outputDir)) {
    console.error('--out 必須在 repo 與資料根之外。');
    return 2;
  }

  const items: ItemBody[] = [];
  for (const id of itemIds) {
    const derived = await readDerived(caseFolder, id);
    if (derived === null || typeof derived.title !== 'string' || typeof derived.text !== 'string') {
      console.error(`找不到項目 ${id} 的衍生正文。`);
      return 1;
    }
    items.push({ id, title: derived.title, text: derived.text });
  }

  // Keep provider-format measurements isolated from the user's application settings.
  const scratch = await mkdtemp(join(tmpdir(), 'cyclosa-extract-measure-checks-'));
  const env: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: scratch };
  const openai = createOpenAiChat(endpoint.toString().replace(/\/$/, ''), model, null, env);
  const ollamaUrl = arg('ollama-url') ?? OLLAMA_DEFAULT_URL;
  const ollama = createOllamaChat(ollamaUrl, 'gemma4:12b', null, env);
  const rows: Row[] = [];
  let protocol: OpenAiProtocol | null = null;
  let preflightCode: string | null = null;
  try {
    const checked = await openai.checkJson!();
    if (checked.kind === 'error') preflightCode = checked.code;
    else protocol = checked.value.protocol;

    for (const item of items) {
      if (preflightCode === null) {
        rows.push(await rowFor(item, openai, 'openai-compatible', model, protocol));
      } else {
        rows.push({
          itemId: item.id,
          provider: 'openai-compatible',
          model,
          protocol: null,
          schemaValid: null,
          relationCount: null,
          quoteHits: null,
          quoteTotal: null,
          seconds: null,
          code: preflightCode,
        });
      }
      rows.push(await rowFor(item, ollama, 'ollama', 'gemma4:12b', 'ollama-native'));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const report = {
    createdAt: new Date().toISOString(),
    caseSlug: slug,
    itemIds,
    openAiProtocol: protocol,
    openAiPreflightError: preflightCode,
    rows,
  };
  await mkdir(outputDir, { recursive: true });
  const baseName = `extract-measurement-${stamp()}`;
  const jsonPath = join(outputDir, `${baseName}.json`);
  const markdownPath = join(outputDir, `${baseName}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
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
