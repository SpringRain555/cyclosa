/**
 * 每一個嵌入模型要在查詢與文件前面各加什麼。
 *
 * ## 為什麼是一張表，而且量測與出貨共用它
 *
 * 好幾個嵌入模型要求查詢與文件各自加一段前綴（model card 上寫的），而 Ollama 的 `/api/embed`
 * **不會**替你加（2026-09-09 實測，`research/embedding-choice.md`）。**少加前綴不會報錯，
 * 只會讓命中率安靜地變低** —— 所以前綴不是設定項，是這張表。
 *
 * 這張表以前有兩份：出貨的那一份在 `embed-ollama.ts`（只認 `qwen3-embedding`），量測的那一份在
 * `tools/research/eval-embeddings.ts`。**兩份已經分岔過一次**：`qwen3-embedding` 的查詢前綴，
 * 量測照 card 寫成 `Query:`（後面沒有空白），出貨寫成 `Query: ` —— 量出來的分數對出貨的東西不完全成立。
 * 2026-09-29 換嵌入模型時收成這一份，兩邊都從這裡讀。
 *
 * ## 認不得的模型
 *
 * 回 `verified: false` 與兩個空字串。**那是「不知道就不動手」，不是「這個模型不用加」** ——
 * 呼叫端要說出來的話，看的是 `verified`。
 *
 * 純函式、零 I/O（`domain/` 的規矩）。
 */

export interface EmbedPrefixes {
  /** 查詢那一側（一句問句）。 */
  readonly query: string;
  /** 文件那一側（一段陳述）。 */
  readonly document: string;
  /** 這一組是從哪一份 model card 讀來的。**沒有出處的前綴等於猜的。** */
  readonly source: string;
  /** 這個模型的前綴有沒有查證過。 */
  readonly verified: boolean;
}

/** 非對稱模型的指令句用同一句（`qwen3-embedding` 與 `multilingual-e5-*-instruct` 的 card 都用這個任務描述）。 */
const RETRIEVAL_TASK = 'Given a web search query, retrieve relevant passages that answer the query';

interface Family {
  /** 正規化之後的模型名以它開頭就算這一族。 */
  readonly prefix: string;
  /** 正規化之後的模型名還要包含這個字（同一個家族裡有前綴不同的變體時用）。 */
  readonly includes?: string;
  readonly prefixes: Omit<EmbedPrefixes, 'verified'>;
}

/**
 * **照抄 model card，一個字都不改**：這一段是模型訓練時看到的形狀。
 * 順序有意義 —— 先比對的先贏（`multilingual-e5` 的 instruct 版與一般版前綴不同）。
 */
const FAMILIES: readonly Family[] = [
  {
    prefix: 'qwen3-embedding',
    prefixes: {
      // card 的 `get_detailed_instruct()` 寫的是 `\nQuery:{query}`：`Query:` 後面**沒有**空白。
      query: `Instruct: ${RETRIEVAL_TASK}\nQuery:`,
      document: '',
      source: 'Qwen/Qwen3-Embedding-0.6B README get_detailed_instruct()',
    },
  },
  {
    prefix: 'multilingual-e5-',
    includes: 'instruct',
    prefixes: {
      // 這一家的 card 寫的是 `\nQuery: {query}`：**有**空白。兩家長得像，字不一樣。
      query: `Instruct: ${RETRIEVAL_TASK}\nQuery: `,
      document: '',
      source:
        'intfloat/multilingual-e5-large-instruct README get_detailed_instruct()：文件那一側不加',
    },
  },
  {
    prefix: 'granite-embedding',
    prefixes: {
      query: '',
      document: '',
      source:
        'ibm-granite/granite-embedding-278m-multilingual 與 granite-embedding-311m-multilingual-r2 README：沒有前綴',
    },
  },
  {
    prefix: 'paraphrase-multilingual',
    prefixes: {
      query: '',
      document: '',
      source: 'sentence-transformers/paraphrase-multilingual-mpnet-base-v2 README：沒有前綴',
    },
  },
  {
    prefix: 'nomic-embed-text-v2',
    prefixes: {
      query: 'search_query: ',
      document: 'search_document: ',
      source:
        'nomic-ai/nomic-embed-text-v2-moe README：「The text prompt *must* include a task instruction prefix」',
    },
  },
  {
    prefix: 'snowflake-arctic-embed',
    prefixes: {
      query: 'query: ',
      document: '',
      source: 'Snowflake/snowflake-arctic-embed-l-v2.0 README：query_prefix，只加在查詢上',
    },
  },
  {
    prefix: 'bge-m3',
    prefixes: { query: '', document: '', source: 'BAAI/bge-m3 README：沒有前綴' },
  },
];

/**
 * Ollama 的模型名 → 比對用的家族名。
 *
 * 三種寫法都要認得：`granite-embedding:278m`（library）、
 * `hf.co/mykor/granite-embedding-311m-multilingual-r2-GGUF:BF16`（直接拉 Hugging Face 的 GGUF）、
 * `registry.ollama.ai/library/qwen3-embedding:4b`（完整路徑）。取最後一段、去掉 tag 與 `-gguf`。
 */
export function embedFamilyName(model: string): string {
  const lastSegment = model.trim().toLowerCase().split('/').pop() ?? '';
  const withoutTag = lastSegment.split(':')[0] ?? '';
  return withoutTag.endsWith('-gguf') ? withoutTag.slice(0, -'-gguf'.length) : withoutTag;
}

export function embedPrefixesFor(model: string): EmbedPrefixes {
  const family = embedFamilyName(model);
  for (const f of FAMILIES) {
    if (!family.startsWith(f.prefix)) continue;
    if (f.includes !== undefined && !family.includes(f.includes)) continue;
    return { ...f.prefixes, verified: true };
  }
  return { query: '', document: '', source: '（沒有查證過這個模型的前綴）', verified: false };
}
