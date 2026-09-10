<script setup lang="ts">
/**
 * 設定 → 狀態說明。**一次看完圖上每一個顏色與記號的意思。**
 *
 * ## 為什麼它跟圖上那一欄同時存在
 *
 * 兩個問題不一樣：圖上那一欄回答「我現在看到的這條線是什麼」（要即時、要窄），
 * 這一頁回答「這張圖總共用了哪些記號」（要完整、要看得完）。
 *
 * **但兩邊讀的是同一份宣告**（`graph/legend-items.ts`）與同一份樣式
 * （`styles/legend-marks.css`）—— 手寫兩份的話它們一定會漂，
 * 而這個專案已經為那件事付過錢：Stage 7 的圖例上寫著「已否決（打叉）」，
 * 而那個叉根本沒實作。
 */
import { LEGEND_SECTIONS } from './graph/legend-items';
import { guideItem, guideSection, t } from '../i18n/zh-TW';
</script>

<template>
  <div class="guide">
    <h2 class="group">{{ t.graph.guide.title }}</h2>
    <p class="group-what">{{ t.graph.guide.what }}</p>

    <section v-for="s in LEGEND_SECTIONS" :key="s.key">
      <h3>{{ guideSection(s.key) }}</h3>
      <dl>
        <template v-for="item in s.items" :key="item.key">
          <dt>
            <span v-if="item.mark" :class="['mark', item.mark]">{{ item.glyph ?? '' }}</span>
            <span class="name">{{ guideItem(item.key).short }}</span>
          </dt>
          <dd>{{ guideItem(item.key).long }}</dd>
        </template>
      </dl>
    </section>
  </div>
</template>

<style scoped>
.guide {
  padding-bottom: 24px;
}
.group {
  font-size: 15px;
  margin: 12px 0 4px;
}
.group-what {
  margin: 0 0 20px;
  max-width: 62ch;
  color: var(--text-tertiary);
  font-size: 13px;
  line-height: 1.6;
}
section {
  margin-bottom: 24px;
}
h3 {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  margin: 0 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line-subtle);
}
dl {
  margin: 0;
}
dt {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 12px;
  color: var(--text);
  font-size: 13px;
}
/* **樣本要跟文字對齊，而不是撐開那一行。** 線是 0 高度的邊框，
   所以它需要一個有高度的容器才對得上中線。 */
dt .mark {
  display: inline-block;
  align-self: center;
}
dt .name {
  font-weight: 600;
}
dd {
  margin: 3px 0 0 35px;
  max-width: 62ch;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.65;
}
</style>
