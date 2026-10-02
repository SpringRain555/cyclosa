/**
 * `domain/provider` —— 能力宣告與任務需求的配對規則（ADR-0006）。
 *
 * **這一層沒有任何 I/O，也不知道 provider 怎麼接。**
 * 它管的是四件會出錯而且值得用純函式測的事：
 *
 * 1. **配不上的時候缺哪幾樣**（不是「行不行」）
 * 2. **上限有三種**，而金額只在 provider 回報實際值時存在
 * 3. **模型輸出是外部輸入** —— 角度、候選 URL、抽取結果全部要正規化
 * 4. **引文的位置自己找**，模型給的數字一律不採信
 */
export * from './capabilities.js';
export * from './budget.js';
export * from './source-hints.js';
export * from './plan.js';
export * from './candidates.js';
export * from './digest.js';
export * from './quote.js';
export * from './relations.js';
export * from './sandbox.js';
export * from './schema-check.js';
export * from './rate-limit.js';
