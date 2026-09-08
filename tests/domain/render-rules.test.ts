/**
 * 四種畫法、兩種節點、兩個環。
 *
 * **這一份守的是 ADR-0018 的三條規則**：
 * 每個顏色只有一個意思／每個狀態都有第二重編碼／明暗只表示遠近。
 * 前兩條在這裡測得到 —— 第三條測不到（它是「不要拿明暗做別的事」，
 * 而那是一條靠 code review 守的規則）。
 */
import { describe, expect, it } from 'vitest';

import {
  drawsAsNode,
  drawsComentionLines,
  edgeDrawingFor,
  edgeDrawingOf,
  edgeLineFor,
  edgePanelFieldsFor,
  emphasisFor,
  labelWeightFor,
  NEIGHBOUR_OPACITY,
  nodeGlyphFor,
  REST_OPACITY,
  ringsFor,
  zoomLevelFor,
  DETAIL_DISTANCE,
  LABEL_DISTANCE,
  EDGE_LAYERS,
} from '../../src/domain/graph/index.js';

describe('層決定畫法：四層四種，一對一', () => {
  it.each([
    ['derived', 'folded'],
    ['named', 'tapered'],
    ['comention', 'boxed'],
    ['similarity', 'dotted'],
  ] as const)('%s → %s', (layer, drawing) => {
    expect(edgeDrawingFor(layer)).toBe(drawing);
  });

  it('四層畫出來的形狀彼此不同 —— 兩種塌成一種就分不出意義了', () => {
    const drawings = new Set(EDGE_LAYERS.map(edgeDrawingFor));
    expect(drawings.size).toBe(EDGE_LAYERS.length);
  });

  it('漸細 ＝ 有方向，其餘都沒有方向', () => {
    expect(edgeLineFor('named', 'confirmed').directional).toBe(true);
    for (const layer of EDGE_LAYERS.filter((l) => l !== 'named')) {
      expect(edgeLineFor(layer, 'confirmed').directional).toBe(false);
    }
  });

  it('轉載預設不畫線 —— 它摺進來源節點', () => {
    expect(edgeLineFor('derived', 'confirmed').hiddenByDefault).toBe(true);
  });
});

/**
 * 這一組守的是實作時看著畫面才發現的一條規則。
 * 沒有它，一個實體會在同一張圖上出現兩次：一次是線末端的空心節點，
 * 一次是線中間的方塊 —— 而那個方塊本來的意思就是「被攤平的那個實體」。
 */
describe('共同提及有兩種長相，差別在那個實體有沒有被畫成節點', () => {
  it('投影出來的線（有 via）中點放方塊 —— 方塊就是它', () => {
    expect(edgeDrawingOf({ layer: 'comention', via: 'ent-1' })).toBe('boxed');
  });

  it('實體已經是節點時，那條 item→entity 邊只是一條等寬線', () => {
    expect(edgeDrawingOf({ layer: 'comention', via: null })).toBe('uniform');
  });

  it('另外三層不受 via 影響', () => {
    for (const layer of EDGE_LAYERS.filter((l) => l !== 'comention')) {
      expect(edgeDrawingOf({ layer, via: null })).toBe(edgeDrawingFor(layer));
    }
  });
});

describe('狀態決定顏色 —— 但只在具名關係上', () => {
  it('待查證是虛線，已確認不是', () => {
    expect(edgeLineFor('named', 'pending').dashed).toBe(true);
    expect(edgeLineFor('named', 'confirmed').dashed).toBe(false);
  });

  it('已否決是打叉而且預設隱藏 —— **它沒有自己的顏色**', () => {
    const line = edgeLineFor('named', 'rejected');
    expect(line.crossed).toBe(true);
    expect(line.hiddenByDefault).toBe(true);
  });

  /**
   * 這一條是實作時才發現的：另外三層在資料庫裡的 `status` 也是 `pending`，
   * 因為機器建立的邊沒有出處就只能是那個值（trigger 擋著）。
   *
   * 照字面畫的話，整張圖會佈滿永遠不會消失的琥珀虛線，
   * **而真正在等人判斷的那些就淹沒在裡面了** —— 琥珀色就失去了唯一的意思。
   */
  it('非具名層的 pending 不畫成虛線，因為沒有人在等你裁決它們', () => {
    for (const layer of EDGE_LAYERS.filter((l) => l !== 'named')) {
      expect(edgeLineFor(layer, 'pending').dashed).toBe(false);
      expect(edgeLineFor(layer, 'rejected').crossed).toBe(false);
    }
  });

  it('層先決定形狀，狀態再疊上去 —— 被否決的相似度線仍然是點線', () => {
    expect(edgeLineFor('similarity', 'rejected').drawing).toBe('dotted');
  });
});

describe('節點：只有兩個顏色，第三色不存在', () => {
  it('抓回來的是冷色實心', () => {
    const glyph = nodeGlyphFor({ kind: 'item', itemKind: 'web' });
    expect(glyph.fill).toBe('item');
    expect(glyph.hollow).toBe(false);
  });

  it('自己寫的是暖色 —— 那一對是有意義的軸', () => {
    expect(nodeGlyphFor({ kind: 'item', itemKind: 'note' }).fill).toBe('note');
  });

  it('實體靠空心分，不靠顏色', () => {
    const glyph = nodeGlyphFor({ kind: 'entity' });
    expect(glyph.hollow).toBe(true);
    expect(glyph.fill).toBe('entity');
  });

  it('已排除是打叉 ＋ 預設隱藏，不是換一個顏色', () => {
    const glyph = nodeGlyphFor({ kind: 'item', itemKind: 'web', excluded: true });
    expect(glyph.crossed).toBe(true);
    expect(glyph.hiddenByDefault).toBe(true);
  });
});

describe('環：外環＝你在哪，焦點環＝轉動中心', () => {
  it('兩個可以同時存在', () => {
    const rings = ringsFor({ selected: true, isFocus: true });
    expect(rings.selected).toBe(true);
    expect(rings.focus).toBe(true);
  });

  it('焦點環疊在上面，不取代節點自己的畫法', () => {
    const rings = ringsFor({ isFocus: true });
    expect(rings.focus).toBe(true);
    expect(rings.selected).toBe(false);
  });
});

describe('已讀標在標籤的字重上，不再是第三個環（ADR-0024）', () => {
  it('沒讀過的資料是粗體', () => {
    expect(labelWeightFor({ kind: 'item', readAt: null })).toBe('bold');
  });

  it('讀過的資料回到正常字重', () => {
    expect(labelWeightFor({ kind: 'item', readAt: 1_700_000_000_000 })).toBe('normal');
  });

  it('**實體沒有已讀這件事** —— 它一律正常字重，靠空心跟已讀的資料分開', () => {
    expect(labelWeightFor({ kind: 'entity', readAt: null })).toBe('normal');
    expect(labelWeightFor({ kind: 'entity', readAt: 1_700_000_000_000 })).toBe('normal');
  });

  it('沒有給 readAt 就當作沒讀過 —— 少一個欄位不該讓它看起來像讀完了', () => {
    expect(labelWeightFor({ kind: 'item' })).toBe('bold');
  });
});

describe('一跳鄰域只提亮、不改暗', () => {
  it('沒有選取時全部都是休息亮度 —— 不會忽明忽暗', () => {
    expect(emphasisFor(0, false)).toBe(REST_OPACITY);
    expect(emphasisFor(5, false)).toBe(REST_OPACITY);
  });

  it('有選取時一跳之內提亮，其餘維持原亮度', () => {
    expect(emphasisFor(1, true)).toBe(NEIGHBOUR_OPACITY);
    expect(emphasisFor(2, true)).toBe(REST_OPACITY);
  });

  it('提亮是往上加，不是把別人壓暗 —— 休息亮度在兩種情況下相同', () => {
    expect(emphasisFor(3, true)).toBe(emphasisFor(3, false));
  });
});

describe('語意縮放：改變表示型態，不是只放大', () => {
  it('近距離顯示細節，中距離只顯示標題，遠距離只有形狀', () => {
    expect(zoomLevelFor(DETAIL_DISTANCE - 1)).toBe('detail');
    expect(zoomLevelFor(LABEL_DISTANCE - 1)).toBe('label');
    expect(zoomLevelFor(LABEL_DISTANCE + 1)).toBe('shape');
  });
});

describe('投影與畫法是同一個決定的兩面', () => {
  it('只有攤平那一段會產生共同提及線', () => {
    expect(drawsComentionLines('edge')).toBe(true);
    expect(drawsComentionLines('node')).toBe(false);
    expect(drawsComentionLines('attribute')).toBe(false);
  });

  it('只有展開那一段才是節點', () => {
    expect(drawsAsNode('node')).toBe(true);
    expect(drawsAsNode('edge')).toBe(false);
  });
});

/**
 * 面板上哪幾欄有意義。
 *
 * **這一段是 2026-09-08 人工驗收照出來的兩個錯的固化。**
 * 兩個都不是「算錯」而是「顯示了一個結構性的值」——
 * 而 345 個測試沒有一個抓得到，因為資料全部是對的。
 */
describe('關聯面板上哪幾欄有意義', () => {
  it('機器抽的具名關係：四樣都有 —— 它就是要給人判斷的那一種', () => {
    expect(edgePanelFieldsFor({ layer: 'named', origin: 'machine' })).toEqual({
      status: true,
      tier: true,
      evidenceFacts: true,
      adjudication: true,
    });
  });

  it.each(['comention', 'similarity', 'derived'] as const)(
    '機器建的 %s：四樣都沒有 —— 沒有判斷可做，那四樣就都是雜訊',
    (layer) => {
      expect(edgePanelFieldsFor({ layer, origin: 'machine' })).toEqual({
        status: false,
        tier: false,
        evidenceFacts: false,
        adjudication: false,
      });
    },
  );

  /**
   * **`status` 在那些列上永遠是 `pending`**（migration 003 逼的）。
   * 顯示它的話，標題旁邊會寫著「待查證」而正下方寫著「沒有確認與否決」——
   * 同一屏上兩句話互相矛盾，而那正是第一版的樣子。
   */
  it('狀態不顯示在裁決不動的邊上 —— 否則同一屏會自相矛盾', () => {
    expect(edgePanelFieldsFor({ layer: 'comention', origin: 'machine' }).status).toBe(false);
  });

  /**
   * 人建的邊 `confidence` 存的是 1，**那是為了線寬，不是量出來的**。
   * 顯示成「可信度：強」會讓它看起來像有東西評估過它。
   */
  it('人建的邊：可以裁決（建錯要拿得掉），但沒有可信度也沒有構成事實', () => {
    for (const layer of EDGE_LAYERS) {
      const fields = edgePanelFieldsFor({ layer, origin: 'human' });
      expect(fields.adjudication).toBe(true);
      expect(fields.status).toBe(true);
      expect(fields.tier).toBe(false);
      expect(fields.evidenceFacts).toBe(false);
    }
  });

  /**
   * **構成事實與校準比例回答的是「機器提的這條憑什麼」。**
   * 對一條你自己連的邊，「出處 0 筆 · 沒有直接引文」讀起來像它很弱，
   * 而在這個工具的模型裡，人親手連的線是最強的那一種。
   */
  it('構成事實只出現在機器抽的邊上', () => {
    expect(edgePanelFieldsFor({ layer: 'named', origin: 'human' }).evidenceFacts).toBe(false);
    expect(edgePanelFieldsFor({ layer: 'named', origin: 'machine' }).evidenceFacts).toBe(true);
  });
});
