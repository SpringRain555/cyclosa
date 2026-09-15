/**
 * 本機 Ollama 當 `chat`。
 *
 * ## 能力宣告盡量去問它自己
 *
 * `GET /api/tags` 每個模型帶一個 `capabilities` 陣列
 * （`["completion","tools","thinking"]`、`["completion","vision"]`…）
 * 與 `details.context_length`。**那是 provider 自己說的，比我們填的準。**
 *
 * ADR-0006 的代價那一節寫著「能力宣告要人工維護，而**不準的宣告比沒有宣告更糟**」——
 * 這一支就是把「人工維護」的份量壓到最小的做法。
 *
 * 只有一欄是我們填的：`json_schema`。
 * 它是**伺服器的功能不是模型的功能** —— Ollama 的 `format` 參數收一份 JSON schema
 * 並用受限解碼保證輸出符合它，所以只要連得上就是 `true`。
 * 而 `browse` 一律 `false`：一個對話端點沒有那種東西。
 *
 * ## 為什麼用 `/api/chat` 而不是 `/v1/chat/completions`
 *
 * **這一段 2026-09-11 改寫過，原本的理由被量測推翻了。**
 *
 * 原本寫的是「OpenAI 相容那條路的 `response_format` 只到 `json_object`」。
 * 重量一次（Ollama 0.33.2）：`/v1` **支援 `json_schema` 而且真的套用** ——
 * 一份模型不可能自己猜到的 schema、一句往反方向拉的提示詞，6/6 符合，
 * 而不帶 `response_format` 的對照組 0/6 是 JSON。
 * **一句沒有日期的量測結果，會在對方升版之後變成假話。**
 *
 * 留在原生這條的理由換成兩個量得到的東西：
 *
 * 1. **`/v1` 送不了 `think: false`。** 同一題 `qwen3.5:4b`：
 *    `/v1` 4.1 秒、2,935 字的思考 —— 跟原生 `think: true` 一模一樣；
 *    原生 `think: false` **0.45 秒、0 字**。見下面 `think` 那一段為什麼這一欄重要
 * 2. **`num_ctx` 只有原生這條送得出去。** 少了它，正文會在小 context 的機器上被安靜截斷
 *
 * 線上的 OpenAI 相容端點走 `chat-openai.ts`。
 * 完整量測在 `docs/research/openai-compat-json-schema.md`。
 */
import { REQUIRED_CONTEXT_TOKENS, type ProviderCapabilities } from '../../domain/provider/index.js';
import { CHAT_TIMEOUT_MS, PROBE_TIMEOUT_MS, authHeader, withTimeout } from './http.js';
import type { CallOutcome, ChatProvider, ProbeResult } from './types.js';

/** 搬到 `http.ts` 了；留一個轉匯出，因為 `tools/research/score-chat.ts` 從這裡拿。 */
export { CHAT_TIMEOUT_MS };

interface TagsModel {
  readonly name?: unknown;
  readonly capabilities?: unknown;
  readonly details?: {
    readonly context_length?: unknown;
    readonly parameter_size?: unknown;
    readonly quantization_level?: unknown;
  };
}

export function capabilitiesOf(model: TagsModel): ProviderCapabilities {
  const caps = Array.isArray(model.capabilities) ? (model.capabilities as unknown[]) : [];
  const has = (name: string): boolean => caps.includes(name);
  const ctx = model.details?.context_length;
  return {
    // 對話端點自己上不了網。**這一欄永遠是 false，而那不是缺陷** ——
    // 上網那一步是 agent 的工作，而 agent 找到 URL 之後也不自己抓。
    browse: false,
    tools: has('tools'),
    // 伺服器功能：`format` 收整份 schema 並用受限解碼保證它。
    json_schema: true,
    vision: has('vision'),
    // **0 代表不知道，不代表 0。** `/api/tags` 對某些模型不帶這一欄，
    // 而 `missingFor` 對 0 是放行的（理由寫在那一支）。
    context_tokens: typeof ctx === 'number' && ctx > 0 ? ctx : 0,
  };
}

/**
 * 這個模型的「版本」。
 *
 * 本機模型沒有版本號，**而它有兩個真的會改變輸出的事實**：
 * 參數量與量化格式。`qwen3:8b` 的 Q4 與 Q8 是同一個名字、不同的東西，
 * 而**兩者抽出來的關聯不一樣** —— 所以那兩個字串就是這裡的版本。
 *
 * 兩個都問不到就回 `null`。**不要編一個看起來像版本號的東西。**
 */
export function versionOf(model: TagsModel): string | null {
  const parts = [model.details?.parameter_size, model.details?.quantization_level]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((v) => v.trim());
  return parts.length === 0 ? null : parts.join(' · ');
}

/** 偵測到的模型清單。**設定頁要用它** —— 不然使用者只能猜模型名怎麼拼。 */
export async function listOllamaModels(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<readonly string[] | null> {
  const t = withTimeout(PROBE_TIMEOUT_MS, signal);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { signal: t.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: unknown };
    const models = Array.isArray(body.models) ? (body.models as TagsModel[]) : [];
    return models.map((m) => String(m.name ?? '')).filter((n) => n.length > 0);
  } catch {
    return null;
  } finally {
    t.done();
  }
}

export function createOllamaChat(
  baseUrl: string,
  model: string,
  apiKeyEnv: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): ChatProvider {
  const root = baseUrl.replace(/\/$/, '');
  const auth = (): Readonly<Record<string, string>> => authHeader(apiKeyEnv, env);

  async function findModel(signal?: AbortSignal): Promise<TagsModel | null | 'unreachable'> {
    const t = withTimeout(PROBE_TIMEOUT_MS, signal);
    try {
      const res = await fetch(`${root}/api/tags`, { signal: t.signal, headers: auth() });
      if (!res.ok) return 'unreachable';
      const body = (await res.json()) as { models?: unknown };
      const models = Array.isArray(body.models) ? (body.models as TagsModel[]) : [];
      return models.find((m) => String(m.name ?? '') === model) ?? null;
    } catch {
      return 'unreachable';
    } finally {
      t.done();
    }
  }

  return {
    name: `ollama:${model}`,

    // **原生 `format` 永遠是受限解碼** —— 那是這條協定的定義，不需要量。
    jsonMode: () =>
      Promise.resolve({ mode: 'schema', checkedAt: null, detail: 'ollama-native-format' }),

    async probe(signal?: AbortSignal): Promise<ProbeResult> {
      if (model.length === 0) return { kind: 'not-configured' };
      const found = await findModel(signal);
      if (found === 'unreachable') return { kind: 'unreachable', detail: root };
      // **設定了一個沒有拉下來的模型 ＝ 沒設定。**
      // 設定頁會把偵測到的清單列出來，所以「為什麼」看得見。
      if (found === null) return { kind: 'not-configured' };
      return {
        kind: 'ready',
        model,
        version: versionOf(found),
        capabilities: capabilitiesOf(found),
      };
    },

    async json(input, signal): Promise<CallOutcome<unknown>> {
      const started = Date.now();
      // **本機模型沒有金額成本，而那是事實不是「不知道」** —— 所以是 0 不是 null。
      const cost = { costUsd: 0, elapsedMs: 0 };
      const t = withTimeout(CHAT_TIMEOUT_MS, signal);
      try {
        const res = await fetch(`${root}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth() },
          body: JSON.stringify({
            model,
            stream: false,
            /**
             * **明確關掉思考。**
             *
             * 不帶這一欄就是吃模型自己的預設，而新一代的模型多半預設是開的 ——
             * 包括**沒有在 `/api/tags` 宣告 `thinking` 的那些**。
             * 2026-09-09 同一份 12,000 字的正文、同一份 schema，開與關各跑一遍：
             *
             * | 模型 | 宣告 thinking | 開 | 關 |
             * |---|---|---|---|
             * | `granite4.2:8b` | **沒有** | 22,545 tok／157 秒 | **3,256 tok／27.7 秒** |
             * | `qwen3.5:4b` | 有 | 4/6 成功／63 秒 | **6/6 成功／約 6 秒** |
             * | `translategemma:12b`（對照）| 沒有 | 1,627 tok／14 秒 | 1,627 tok／13.4 秒 |
             *
             * 對照那一列是這個決定的依據之一：**對真的不思考的模型，
             * 這一欄一個 token 都沒改變** —— 送它不會有副作用。
             *
             * ## 代價是實體分類會變差，而那是知道的
             *
             * `granite4.2:8b` 關掉之後有兩輪出現「20 個實體、**1 種型別**」——
             * 那正是 2026-09-08 那個「五個實體全部被標成 `person`」的失敗模式。
             * 思考買到的是分類，代價是七倍的 token 與六倍的時間。
             *
             * **在 180 秒的預算下這個取捨沒有懸念**：一個分類漂亮但交不出東西的
             * 抽取，使用者拿到的是逾時。而分類錯了還有人工裁決那一關，
             * 逾時則是什麼都沒有。
             *
             * ## 反例：`olmo-3:32b-think` 關掉之後完全不動
             *
             * 同一次量測裡，`olmo-3:32b-think` 送 `think: false` 之後
             * **三輪角度全部回 0 個字元**（9.7–24.4 秒）。思考對它不是加分項，
             * 是它的運作方式。所以這一行**不是普遍安全的**。
             *
             * 這裡仍然寫死，理由是代價量得出來：那個模型開著思考本來就是
             * 角度 2/3、抽取 **0/6**（183–247 秒，全部超過 180）——
             * 它從「不能用」變成「不能用」。
             *
             * **而且沒有加「空回應就拿掉這一欄重試一次」那種退路。**
             * 那會讓使用者拿到的結果來自一組跟畫面上顯示的不同的設定，
             * 正是 ADR-0006 第 3 條說的靜默降級。
             * 空回應會走到 `PROVIDER_OUTPUT_UNPARSEABLE`，而那一行現在
             * 會把 provider 自己說的 `done_reason` 帶出去 —— **看得見比較好**。
             */
            think: false,
            format: input.schema,
            options: {
              // 溫度壓到 0：這不是創作，是**從既有內容歸納**。
              temperature: 0,
              /**
               * **明確帶 context 大小，不吃 Ollama 的預設。**
               *
               * `/api/tags` 回的 `context_length` 是模型支援的上限，
               * 而實際載入時用的是 `OLLAMA_CONTEXT_LENGTH`（使用者沒設就是內建值）。
               * 2026-09-09 實測 `nemotron-cascade-2:30b`：前者 262144、後者 32768。
               * **而 `gemma4:31b` 與 `translategemma:12b` 連那一欄都沒有** ——
               * 宣告是 0、閘門當「不知道」放行，於是這一層是唯一擋得住的地方。
               *
               * 不帶這一欄的話，一份 12,000 字的正文會在一台設了小 context
               * 的機器上被安靜截掉，而抽出來的關聯照樣帶引文、照樣進待查證。
               */
              num_ctx: REQUIRED_CONTEXT_TOKENS,
            },
            messages: [
              { role: 'system', content: input.system },
              { role: 'user', content: input.user },
            ],
          }),
          signal: t.signal,
        });
        const elapsedMs = Date.now() - started;
        if (!res.ok) {
          return {
            kind: 'error',
            code: 'PROVIDER_UNREACHABLE',
            detail: `HTTP ${res.status}`,
            cost: { ...cost, elapsedMs },
          };
        }
        const body = (await res.json()) as {
          message?: { content?: unknown };
          done_reason?: unknown;
        };
        const content = typeof body.message?.content === 'string' ? body.message.content : '';
        try {
          return { kind: 'ok', value: JSON.parse(content), cost: { ...cost, elapsedMs } };
        } catch {
          // 宣告了 `json_schema` 卻回了不是 JSON 的東西 —— **那是 provider 沒守約定**，
          // 不是我們解析錯了。把它報成 `PROVIDER_OUTPUT_UNPARSEABLE` 而不是靜默略過。
          //
          // **但「0 個字元」這句話會把兩件事講成同一件。** 2026-09-09 實測到
          // 受限解碼撞到視窗上緣時，Ollama 回的是**空字串加 `done_reason: "length"`**，
          // 而那不是「模型壞了」，是「我們送進去的東西加上它要吐的東西塞不下」——
          // 兩者的下一步完全不同（換模型 ／ 縮輸入或開大視窗）。
          // 所以把 provider 自己說的那個理由帶出去，不要只報長度。
          const why =
            body.done_reason === 'length'
              ? `回應是空的，而 provider 說 done_reason=length —— **輸出在 context 用完時被截斷**`
              : `${content.length} 個字元`;
          return {
            kind: 'error',
            code: 'PROVIDER_OUTPUT_UNPARSEABLE',
            detail: why,
            cost: { ...cost, elapsedMs },
          };
        }
      } catch (e) {
        const elapsedMs = Date.now() - started;
        // **逾時與取消不是同一件事，連不上又是第三件。**
        // 取消時這個碼不會被顯示（呼叫端先看到 run 已取消就停了），
        // 但把它寫成 `PROVIDER_TIMEOUT` 會在診斷檔裡留下一句假話。
        return {
          kind: 'error',
          code: t.timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE',
          detail: String((e as Error).message),
          cost: { ...cost, elapsedMs },
        };
      } finally {
        t.done();
      }
    },
  };
}
