/**
 * `domain/graph` —— 圖模型、四層、六條轉移、墓碑、投影、可信度。
 *
 * ⚠️ **這個資料夾零依賴**（ADR-0014）：不 import 其他層、不 import npm 套件，
 * 也不 import `domain/` 的其他資料夾。**零依賴是「以後可以抽成套件」的前置條件。**
 *
 * `rubricator` 是已知的未來消費者。**現在不抽套件** —— 它真的要用的時候
 * 第一步是複製一份，而且要在複製的那個 commit 裡寫明它是複本。
 * 抽套件的觸發條件是：**兩邊的複本已經分岔，而那個分岔造成了一個 bug。**
 */
export * from './types.js';
export * from './edge-state.js';
export * from './tombstone.js';
export * from './projection.js';
export * from './confidence.js';
