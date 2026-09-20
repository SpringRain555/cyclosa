/**
 * 把一個對話 provider 包成 agent 的形狀 —— **只給規劃對話用**（ADR-0033 D5）。
 *
 * ## 為什麼需要這一層
 *
 * 規劃對話是第一個「三個服務都可以、而且能力不同」的任務：Claude Code 是子程序、
 * OpenAI 相容 API 是帶搜尋工具的 HTTP 請求，這兩種都已經是 `AgentProvider`；
 * 本機 Ollama 是 `ChatProvider`。
 *
 * 上一層（`research-service`）要的東西只有一個：**送一段字、拿一份符合 schema 的 JSON 回來**。
 * 為了第三條路在那一層寫一個 `if`，等於把「走哪個服務」這件事從設定裡漏到用例裡 ——
 * 而那正是 ADR-0032 把主鍵換成任務要消滅的東西。
 *
 * ## 這不是「三個角色統一成一個介面」
 *
 * `types.ts` 明寫三種形狀刻意不統一（取消的方式都不一樣）。這裡包的**只有一個方法**，
 * 而且方向是單向的：對話 → agent 的形狀。agent 那邊的沙箱、逾時、取消一概沒有被假裝出來：
 *
 * - `cwd`（沙箱）**用不到**：一次 HTTP 請求寫不了檔。呼叫端照樣掃它，不為它開例外
 *   （跟 `agent-openai.ts` 同一句話）。
 * - `timeoutMs` **交給 `signal`**：對話那一支的逾時住在它自己裡面。
 */
import type { AgentProvider, CallOutcome, ChatProvider, ProbeResult } from './types.js';

export interface ChatAgentOptions {
  readonly chat: ChatProvider;
  readonly systemPrompt: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

export function createChatAgent(options: ChatAgentOptions): AgentProvider {
  return {
    name: options.chat.name,

    probe(signal?: AbortSignal): Promise<ProbeResult> {
      return options.chat.probe(signal);
    },

    async run(input, signal): Promise<CallOutcome<string>> {
      const call = await options.chat.json(
        { system: options.systemPrompt, user: input.prompt, schema: options.schema },
        signal,
      );
      if (call.kind === 'error') return call;
      // **交出去的是字串**，跟另外兩支一樣 —— 解析與正規化在同一個地方做一次。
      return { kind: 'ok', value: JSON.stringify(call.value), cost: call.cost };
    },
  };
}
