/**
 * `claude -p --output-format stream-json` 當 `agent`。
 *
 * ## 這一支只做一件事：讓子程序有能力上網找 URL，而且只有那個能力
 *
 * ADR-0006 第 5 條：**agent 找到的東西不能自己抓**，一律交回主程式走
 * 唯一的擷取管線 —— 節流、robots、雜湊、manifest 只存在於那一層。
 *
 * 實作這條規則的地方**不是事後檢查沙箱，而是 `--tools WebSearch`**：
 * 工具清單裡沒有 `WebFetch`、沒有 `Write`、沒有 `Bash`，
 * 所以它**做不到**把一份網頁存進沙箱，而不是「約定好不要這麼做」。
 *
 * `WebFetch` 特別要點名：它會真的去把頁面抓下來，而那正好繞過我們那一層。
 * **搜尋是「找到 URL」，抓取是我們的事。**
 *
 * 事後掃一次沙箱那條檢查仍然留著（`sandboxViolations`）——
 * 兩層擋同一件事，是因為第一層是我們傳給別人程式的參數，
 * 而**參數會被改版、被忽略、被拼錯**。
 *
 * ## 三個為了隱私與可重現而加的旗標
 *
 * | 旗標 | 為什麼 |
 * |---|---|
 * | `--no-session-persistence` | 專題的主題與內容**不留在使用者的對話歷史裡**。這是一個處理私人資料的工具 |
 * | `--system-prompt` | 換掉預設的系統提示。我們要的是一個固定形狀的任務，不是一個通用助理 |
 * | `--disable-slash-commands` | 沙箱裡的檔案不該能改變這次呼叫在做什麼 |
 *
 * **刻意沒有用 `--bare`**：它把認證限制成 `ANTHROPIC_API_KEY`，
 * 而用 OAuth 登入的使用者會當場壞掉。
 *
 * ## 上限交給它自己擋
 *
 * `--max-budget-usd` 是 provider 端強制的，比我們事後加總準
 * （ADR-0006：**設一個查不到實際值的上限等於沒設**；反過來，
 * 一個對方自己會擋的上限比我們自己數的可靠）。
 * 我們仍然把 `total_cost_usd` 加起來，因為那是要顯示的實際花費。
 */

import { cwdTooLong, spawnPiped, WINDOWS_CWD_LIMIT } from './spawn-piped.js';
import type { AgentProvider, CallOutcome, ProbeResult } from './types.js';
import { logger } from '../../shared/log.js';

/** `claude -p` 宣告的能力。**這一份是人工填的，所以它列在同一個地方好對照。** */
const CLAUDE_CAPABILITIES = {
  /** `--tools WebSearch` —— 這是我們給它的，也是它唯一需要的 */
  browse: true,
  tools: true,
  /** `--json-schema` 是 CLI 自己的旗標 */
  json_schema: true,
  vision: true,
  /** 保守值。**寧可宣告得小** —— `missingFor` 對 0 放行，對太小的擋下 */
  context_tokens: 200_000,
} as const;

/**
 * **`.cmd`／`.bat` 不支援 —— 子程序一律不經過 `cmd.exe`**（2026-10-02）。
 *
 * Node 從 20.12 起不再直接 spawn `.cmd`／`.bat`（那是一個命令注入的修補），要起它們只能 `shell: true`；
 * 而 `shell: true` 時 Node 把命令與參數**原樣接成一個字串**交給 `cmd.exe`（DEP0190）。
 * 這一支的參數裡有 `-p <提示詞>`，提示詞裡有專題文件的段落（可能來自抓回來的網頁），
 * 那裡面的 `&`、`|`、`"` 會被 `cmd.exe` 當成指令 —— **那是命令注入**。
 * 2026-10-02 之前的寫法是「`.cmd`／`.bat` 才走 shell」，只擋掉了 `.exe` 那一半。
 *
 * npm 裝的 Claude Code 在 Windows 上就是一個 `.cmd` 包裝；**原生安裝的是 `claude.exe`，不需要 shell**。
 * 所以這兩種副檔名直接說不支援、說要怎麼改，不起子程序。
 * （把 npm 包裝解析成 `node <script>`、提示詞改走 stdin 是模型服務改版的事。）
 */
export function isShellWrapper(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command.trim());
}

const SHELL_WRAPPER_DETAIL =
  '不支援 .cmd／.bat 的包裝（npm 安裝的版本會經過 cmd.exe）—— 請改用 Claude Code 的原生安裝（claude.exe）';

interface ResultEvent {
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly result?: unknown;
  readonly structured_output?: unknown;
  readonly total_cost_usd?: unknown;
  readonly is_error?: unknown;
}

/**
 * 一次呼叫的解析結果。
 *
 * **`rateLimit` 要單獨帶出來**：撞到對方的用量限制時，畫面要說得出
 * 「是對方的用量限制，某某時間重置」，而不是一個泛泛的失敗
 * （ADR-0006 的補記，2026-09-06 實測看到 `rate_limit_event`）。
 */
interface StreamSummary {
  text: string | null;
  structured: unknown;
  costUsd: number | null;
  isError: boolean;
  rateLimit: string | null;
}

export function parseStreamJson(lines: readonly string[]): StreamSummary {
  const out: StreamSummary = {
    text: null,
    structured: undefined,
    costUsd: null,
    isError: false,
    rateLimit: null,
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: ResultEvent;
    try {
      event = JSON.parse(trimmed) as ResultEvent;
    } catch {
      // **一行壞掉不代表整批壞掉。** stream-json 是逐行的，
      // 而我們只在乎最後那個 `result` 事件。
      continue;
    }
    if (event.type === 'rate_limit_event') {
      const raw = event as unknown as { rateLimitType?: unknown; resetsAt?: unknown };
      out.rateLimit = `${String(raw.rateLimitType ?? '?')} / ${String(raw.resetsAt ?? '?')}`;
      continue;
    }
    if (event.type !== 'result') continue;
    if (typeof event.result === 'string') out.text = event.result;
    if (event.structured_output !== undefined) out.structured = event.structured_output;
    if (typeof event.total_cost_usd === 'number') out.costUsd = event.total_cost_usd;
    if (event.is_error === true || event.subtype === 'error_max_turns') out.isError = true;
  }
  return out;
}

export interface ClaudeAgentOptions {
  readonly command: string;
  /** 接在 `command` 之後、我們的旗標之前。見 `config.ts` 的 `AgentConfig.args` */
  readonly args: readonly string[];
  /**
   * 交給 CLI 的 `--model`。**空字串 ＝ 不帶這個旗標**，讓 CLI 用它自己的預設。
   *
   * 「不帶」與「帶一個空的」是兩件事：後者會讓 CLI 拿一個空字串去解析模型名。
   * 這是這個 repo 2026-09-09 記過的同一種錯（`lessons.md`
   * 「沒有帶的參數也是一個決定」）—— 所以這裡明確地不帶。
   */
  readonly model: string;
  /** JSON Schema，直接交給 `--json-schema` */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly systemPrompt: string;
  readonly maxCostUsd: number | null;
}

export function createClaudeAgent(options: ClaudeAgentOptions): AgentProvider {
  return {
    name: options.model.length > 0 ? `claude:${options.model}` : `claude:${options.command}`,

    /**
     * **只確認 CLI 在不在，不打一次 API。**
     *
     * 設定頁上那個「儲存並測試」按鈕才會花錢，而它是使用者按的。
     * 開設定頁本身不該產生費用 —— 那是一個沒有人會預期的收費。
     */
    async probe(): Promise<ProbeResult> {
      if (isShellWrapper(options.command))
        return { kind: 'unreachable', detail: SHELL_WRAPPER_DETAIL };
      return await new Promise<ProbeResult>((resolve) => {
        // **管線的錯誤一律接住**（`spawn-piped.ts` 的檔頭：子程序起不來不該把伺服器帶走）。
        const child = spawnPiped(options.command, [...options.args, '--version']);
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.on('error', () => resolve({ kind: 'not-configured' }));
        child.on('close', (code) => {
          if (code !== 0) {
            resolve({ kind: 'unreachable', detail: `結束碼 ${String(code)}` });
            return;
          }
          resolve({
            kind: 'ready',
            model: options.command,
            version: stdout.trim().split('\n')[0] ?? null,
            capabilities: { ...CLAUDE_CAPABILITIES },
          });
        });
      });
    },

    async run(input, signal): Promise<CallOutcome<string>> {
      const started = Date.now();
      /**
       * **已經取消了就不要 spawn。** 對一個已經 aborted 的 signal 掛 `abort` 監聽**不會觸發**，
       * 所以「取消落在 spawn 之前那一刻」的話，子程序會照樣跑滿逾時 —— 2026-09-23 蒐集的
       * 端對端測試撞到的（一次搜尋在取消之後又跑了一分鐘）。
       */
      if (signal?.aborted === true) {
        return {
          kind: 'error',
          code: 'PROVIDER_TIMEOUT',
          detail: '已取消',
          cost: { costUsd: null, elapsedMs: 0 },
        };
      }
      /**
       * **工作目錄太長就不要 spawn，而且說實話。** Windows 在那個長度上回的是 `ENOENT` ——
       * 照原本的處理會變成 `PROVIDER_NOT_CONFIGURED`（「沒設定」），叫人去改一個沒有壞的設定。
       * 要改的是資料根的位置（`spawn-piped.ts` 的檔頭）。
       */
      if (cwdTooLong(input.cwd)) {
        return {
          kind: 'error',
          code: 'IO_PATH_TOO_LONG',
          detail: `工作目錄 ${String(input.cwd.length)} 字元，上限 ${String(WINDOWS_CWD_LIMIT)}`,
          cost: { costUsd: null, elapsedMs: 0 },
        };
      }
      if (isShellWrapper(options.command)) {
        return {
          kind: 'error',
          code: 'PROVIDER_NOT_CONFIGURED',
          detail: SHELL_WRAPPER_DETAIL,
          cost: { costUsd: null, elapsedMs: 0 },
        };
      }
      const args = [
        ...options.args,
        '-p',
        input.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--system-prompt',
        options.systemPrompt,
        // **工具清單就是沙箱。** 見這個檔案開頭。
        '--tools',
        'WebSearch',
        '--allowedTools',
        'WebSearch',
        '--json-schema',
        JSON.stringify(options.schema),
        '--no-session-persistence',
        '--disable-slash-commands',
      ];
      // 空字串 ＝ 不帶，讓 CLI 用自己的預設。
      if (options.model.length > 0) args.push('--model', options.model);
      if (options.maxCostUsd !== null) {
        args.push('--max-budget-usd', String(options.maxCostUsd));
      }

      return await new Promise<CallOutcome<string>>((resolve) => {
        const child = spawnPiped(options.command, args, {
          // **這就是沙箱**（ADR-0006 第 4 條）。
          cwd: input.cwd,
        });

        const lines: string[] = [];
        let buffer = '';
        let stderr = '';
        let killedBy: 'timeout' | 'cancel' | null = null;

        const kill = (why: 'timeout' | 'cancel'): void => {
          killedBy = why;
          // **取消 ＝ 殺子程序**（ADR-0006 第 6 條）。已寫入的由呼叫端保留。
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
          }, 2000).unref();
        };

        const timer = setTimeout(() => kill('timeout'), input.timeoutMs);
        const onAbort = (): void => kill('cancel');
        signal?.addEventListener('abort', onAbort, { once: true });

        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const parts = buffer.split('\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) lines.push(part);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < 4000) stderr += chunk.toString('utf8');
        });

        const settle = (outcome: CallOutcome<string>): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(outcome);
        };

        child.on('error', (e) => {
          settle({
            kind: 'error',
            code: 'PROVIDER_NOT_CONFIGURED',
            detail: String(e.message),
            cost: { costUsd: null, elapsedMs: Date.now() - started },
          });
        });

        child.on('close', () => {
          if (buffer.trim().length > 0) lines.push(buffer);
          const summary = parseStreamJson(lines);
          const cost = { costUsd: summary.costUsd, elapsedMs: Date.now() - started };

          if (summary.rateLimit !== null) {
            // **那是對方的限制，不是我們設的上限** —— 所以它進日誌也進 detail，
            // 而不是被當成我們自己的預算用完了。
            logger.info('agent 撞到 provider 自己的用量限制', { rateLimit: summary.rateLimit });
          }

          if (killedBy === 'timeout') {
            settle({ kind: 'error', code: 'PROVIDER_TIMEOUT', detail: '子程序逾時', cost });
            return;
          }
          if (killedBy === 'cancel') {
            settle({ kind: 'error', code: 'PROVIDER_TIMEOUT', detail: '已取消', cost });
            return;
          }
          if (summary.isError) {
            settle({
              kind: 'error',
              code: 'PROVIDER_BUDGET_EXCEEDED',
              detail: summary.rateLimit ?? stderr.slice(0, 200),
              cost,
            });
            return;
          }

          const value =
            summary.structured !== undefined
              ? JSON.stringify(summary.structured)
              : (summary.text ?? '');
          if (value.length === 0) {
            settle({
              kind: 'error',
              code: 'PROVIDER_OUTPUT_UNPARSEABLE',
              detail: stderr.slice(0, 200),
              cost,
            });
            return;
          }
          settle({ kind: 'ok', value, cost });
        });
      });
    },
  };
}
