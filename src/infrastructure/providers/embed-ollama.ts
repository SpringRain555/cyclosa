/**
 * 本機 Ollama 當 `embed`。
 *
 * ## 前綴是模型自己要求的，而 Ollama 不會替你加
 *
 * 2026-09-09 實測確認：`/api/embed` **不會**自動套用 model card 上的前綴
 * （`research/embedding-choice.md`「三件事決定這份量測算不算數」第 2 條）。
 * `qwen3-embedding` 的 model card 要求查詢那一側加 `Instruct: …\nQuery: `，
 * 而文件那一側**不加**。
 *
 * **少加前綴不會報錯，只會讓命中率安靜地變低** —— 那是這一層最像
 * 「設定錯了但看起來正常」的一件事，所以它寫死在這裡而不是設定項。
 *
 * ## 為什麼查詢與文件走不同的路徑
 *
 * 因為它們**不對稱**：查詢是一句問句，文件是一段陳述。
 * 非對稱模型（`qwen3-embedding`、`arctic-embed`、`nomic-v2`）就是為這件事訓練的。
 * 用同一支函式送兩者，等於把那個訓練丟掉一半。
 *
 * ## 沒有金鑰
 *
 * `EmbedConfig` 沒有 `apiKeyEnv`，而那是刻意的（見 `config.ts`）：
 * 向量會被長期保存，換模型要全部重算，而一個雲端端點隨時可能換掉背後的權重 ——
 * **那不會報錯，只會讓比對安靜地變爛**（ADR-0009）。
 */
import { normalized } from '../../domain/search/similarity.js';
import type { CallCost, CallOutcome, ProbeResult } from './types.js';

/** 一次嵌入等多久。**批次的，所以比 probe 長很多。** */
export const EMBED_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 5_000;

/**
 * 一次送幾段。
 *
 * `/api/embed` 收 `input` 陣列，而一次送太多有兩個代價：
 * 逾時的時候**整批都要重來**，而且回應要一次全部進記憶體
 * （32 段 × 2560 維 × 4 byte 只有 328 KB，所以瓶頸是前者）。
 */
export const EMBED_BATCH = 32;

/**
 * `qwen3-embedding` 系列的查詢前綴。
 *
 * **這是模型 card 上寫的字串，不是我們的措辭** —— 改它等於換一個模型。
 * 其餘家族的前綴不同（`arctic-embed` 是 `query: `、
 * `nomic-v2` 是 `search_query: `／`search_document: `），
 * 而**我們只出貨 `qwen3-embedding`**，所以這裡只有一組。
 * 換家族的時候這一段要跟著換 —— `prefixFor` 認不得的模型不加前綴，
 * 那是「不知道就不動手」，不是「預設就是不用加」。
 */
const QWEN_QUERY_PREFIX =
  'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ';

export function queryPrefixFor(model: string): string {
  return model.toLowerCase().startsWith('qwen3-embedding') ? QWEN_QUERY_PREFIX : '';
}

export interface EmbedProvider {
  readonly name: string;
  readonly model: string;
  probe(signal?: AbortSignal): Promise<ProbeResult>;
  /** 文件那一側。**不加前綴。** */
  embedDocuments(texts: readonly string[], signal?: AbortSignal): Promise<CallOutcome<EmbedBatch>>;
  /** 查詢那一側。**加前綴。** */
  embedQuery(text: string, signal?: AbortSignal): Promise<CallOutcome<Float32Array>>;
}

export interface EmbedBatch {
  /** 跟輸入同樣長度、同樣順序。**單位向量。** */
  readonly vectors: readonly Float32Array[];
  readonly dim: number;
}

interface Timed {
  readonly signal: AbortSignal;
  done(): void;
}

function withTimeout(ms: number, outer?: AbortSignal): Timed {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  const onAbort = (): void => controller.abort(outer?.reason);
  if (outer !== undefined) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

/** 本機模型沒有金額成本，**而那是事實不是「不知道」** —— 所以是 0 不是 null。 */
function costOf(started: number): CallCost {
  return { costUsd: 0, elapsedMs: Date.now() - started };
}

export function createOllamaEmbed(baseUrl: string, model: string): EmbedProvider {
  const root = baseUrl.replace(/\/$/, '');

  async function call(
    input: readonly string[],
    signal: AbortSignal | undefined,
    started: number,
  ): Promise<CallOutcome<EmbedBatch>> {
    const t = withTimeout(EMBED_TIMEOUT_MS, signal);
    try {
      const res = await fetch(`${root}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input }),
        signal: t.signal,
      });
      if (!res.ok) {
        return {
          kind: 'error',
          code: 'PROVIDER_UNREACHABLE',
          detail: `${root} 回 HTTP ${res.status}`,
          cost: costOf(started),
        };
      }
      const body = (await res.json()) as { embeddings?: unknown };
      const rows = Array.isArray(body.embeddings) ? (body.embeddings as unknown[]) : [];
      // **少回幾筆是不能容忍的** —— 對不起來的話，第 3 段的向量會被存成第 4 段的。
      if (rows.length !== input.length) {
        return {
          kind: 'error',
          code: 'PROVIDER_OUTPUT_UNPARSEABLE',
          detail: `送了 ${input.length} 段、回了 ${rows.length} 條向量`,
          cost: costOf(started),
        };
      }
      const vectors: Float32Array[] = [];
      let dim = 0;
      for (const row of rows) {
        if (!Array.isArray(row) || row.length === 0) {
          return {
            kind: 'error',
            code: 'PROVIDER_OUTPUT_UNPARSEABLE',
            detail: '回來的其中一條不是向量',
            cost: costOf(started),
          };
        }
        const v = Float32Array.from(row as number[], (n) => Number(n));
        // **維度不一致代表回來的東西混了兩個模型的結果。**
        if (dim === 0) dim = v.length;
        else if (v.length !== dim) {
          return {
            kind: 'error',
            code: 'PROVIDER_OUTPUT_UNPARSEABLE',
            detail: `同一批裡出現兩種維度：${dim} 與 ${v.length}`,
            cost: costOf(started),
          };
        }
        vectors.push(normalized(v));
      }
      return { kind: 'ok', value: { vectors, dim }, cost: costOf(started) };
    } catch (e) {
      const detail = t.signal.aborted ? `超過 ${EMBED_TIMEOUT_MS / 1000} 秒` : String(e);
      return { kind: 'error', code: 'PROVIDER_UNREACHABLE', detail, cost: costOf(started) };
    } finally {
      t.done();
    }
  }

  return {
    name: `ollama:${model}`,
    model,

    async probe(signal?: AbortSignal): Promise<ProbeResult> {
      if (model.length === 0) return { kind: 'not-configured' };
      const t = withTimeout(PROBE_TIMEOUT_MS, signal);
      try {
        const res = await fetch(`${root}/api/tags`, { signal: t.signal });
        if (!res.ok) return { kind: 'unreachable', detail: root };
        const body = (await res.json()) as { models?: unknown };
        const models = Array.isArray(body.models) ? (body.models as { name?: unknown }[]) : [];
        const found = models.find((m) => String(m.name ?? '') === model);
        // **設定了一個沒有拉下來的模型 ＝ 沒設定。**（跟 chat 那一支同一個判斷）
        if (found === undefined) return { kind: 'not-configured' };
        return {
          kind: 'ready',
          model,
          version: null,
          // `browse`／`tools`／`json_schema`／`vision` 對嵌入模型一個都不適用，
          // **而假裝它有比誠實說沒有更糟**（`registry.embedProbe` 的同一句話）。
          capabilities: {
            browse: false,
            tools: false,
            json_schema: false,
            vision: false,
            context_tokens: 0,
          },
        };
      } catch {
        return { kind: 'unreachable', detail: root };
      } finally {
        t.done();
      }
    },

    async embedDocuments(texts, signal): Promise<CallOutcome<EmbedBatch>> {
      const started = Date.now();
      if (texts.length === 0) {
        return { kind: 'ok', value: { vectors: [], dim: 0 }, cost: costOf(started) };
      }
      const vectors: Float32Array[] = [];
      let dim = 0;
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const slice = texts.slice(i, i + EMBED_BATCH);
        const out = await call(slice, signal, started);
        if (out.kind === 'error') return out;
        vectors.push(...out.value.vectors);
        dim = out.value.dim;
      }
      return { kind: 'ok', value: { vectors, dim }, cost: costOf(started) };
    },

    async embedQuery(text, signal): Promise<CallOutcome<Float32Array>> {
      const started = Date.now();
      const out = await call([`${queryPrefixFor(model)}${text}`], signal, started);
      if (out.kind === 'error') return out;
      const first = out.value.vectors[0];
      if (first === undefined) {
        return {
          kind: 'error',
          code: 'PROVIDER_OUTPUT_UNPARSEABLE',
          detail: '查詢的向量是空的',
          cost: costOf(started),
        };
      }
      return { kind: 'ok', value: first, cost: out.cost };
    },
  };
}
