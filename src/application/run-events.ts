/**
 * 一次作業的進度事件。SSE 從這裡拿東西送出去。
 *
 * **這是應用層的東西，不是介面層的。** 「現在在做什麼」是用例的一部分 ——
 * 作業紀錄那一頁存在的理由就是「擴展不是黑箱」（ui-workflows）。
 */

export type RunEvent =
  | { readonly type: 'started'; readonly runId: string; readonly total: number }
  /** 為了節流在等。**這一列一直在畫面上**，因為它是對外的行為承諾。 */
  | { readonly type: 'throttled'; readonly host: string; readonly waitedMs: number }
  | {
      readonly type: 'item';
      readonly runItemId: string;
      readonly requested: string;
      readonly host: string | null;
      readonly outcome: string;
      readonly code: string | null;
      readonly itemId: string | null;
    }
  /**
   * 一條切入角度做完了。
   *
   * **跟 `item` 是兩個層級**：一條角度會產生好幾個 `item` 事件。
   * 併成一種的話，作業紀錄那一頁就分不出「這幾個網址是哪一條角度找來的」——
   * 而那正是「擴展不是黑箱」要說的事。
   */
  | {
      readonly type: 'angle';
      readonly angleId: string;
      readonly question: string;
      readonly foundUrls: number;
      readonly newNodes: number;
      readonly newEdges: number;
      readonly code: string | null;
    }
  /**
   * 研究的一條方向搜完了（Stage 20）。**跟 `angle` 分開**：那一種是舊的擴展，
   * 一條角度會「找 → 抓 → 抽」一路做完；方向只搜，抓是全部搜完之後的另一段。
   */
  | {
      readonly type: 'direction';
      readonly directionId: string;
      readonly title: string;
      /** 這一次搜到幾個（**含別的方向也找到的**）*/
      readonly found: number;
      readonly code: string | null;
    }
  /**
   * 研究的一份候選初讀完了（Stage 21）。`relevance` 是 `null` 而 `code` 有值 ＝ 讀失敗
   * （原因已經寫在候選那一列上，「繼續蒐集」會再讀 —— 沒有正文可讀的除外）。
   */
  | {
      readonly type: 'digest';
      readonly candidateId: string;
      readonly itemId: string | null;
      readonly relevance: string | null;
      readonly code: string | null;
    }
  | { readonly type: 'progress'; readonly done: number; readonly total: number }
  | {
      readonly type: 'settled';
      readonly status: string;
      readonly succeeded: number;
      readonly failed: number;
    };

type Listener = (event: RunEvent) => void;

/**
 * 每個 run 一個。**訂閱者可以是 0 個** ——
 * 使用者關掉作業紀錄那一頁不會讓作業停下來。
 */
export class RunChannel {
  private readonly listeners = new Set<Listener>();
  private readonly history: RunEvent[] = [];

  subscribe(listener: Listener): () => void {
    // **先把已經發生的補送給它。** 使用者是在作業開始之後才打開那一頁的，
    // 而少了前面幾列的清單看起來像「什麼都沒發生」。
    for (const event of this.history) listener(event);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RunEvent): void {
    this.history.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 一個壞掉的訂閱者不該讓作業停下來
      }
    }
  }

  get replay(): readonly RunEvent[] {
    return this.history;
  }
}
