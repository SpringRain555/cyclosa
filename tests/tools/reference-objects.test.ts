/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LineDashedMaterial, LineSegments, Mesh } from 'three';
import { buildNode, disposeTree, type NodeSpec } from '../../web/src/components/graph/objects.js';
import {
  REFERENCE_FILL_OPACITY,
  referenceStyle,
} from '../../web/src/components/graph/reference-style.js';

const spec: NodeSpec = {
  color: 'blue',
  dashed: true,
  hollow: false,
  opacity: 0.6,
  selected: false,
  isFocus: false,
  crossed: false,
};

beforeEach(() => {
  vi.stubGlobal('window', { location: { search: '' } });
  vi.stubGlobal('document', {
    documentElement: {},
    createElement: () => ({ getContext: () => null }),
  });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => 'blue' }));
});

afterEach(() => vi.unstubAllGlobals());

describe('書目 A／B 比較', () => {
  it('預設 A；只有 refStyle=b 才用 B', () => {
    expect(referenceStyle('')).toBe('a');
    expect(referenceStyle('?refStyle=a')).toBe('a');
    expect(referenceStyle('?refStyle=unknown')).toBe('a');
    expect(referenceStyle('?other=1&refStyle=b')).toBe('b');
  });

  it.each(['a', 'b'])('%s 的稜線有距離資料，2D 與 3D 使用相同物件', (style) => {
    vi.stubGlobal('window', { location: { search: `?refStyle=${style}` } });
    const group = buildNode(spec);
    const outline = group.getObjectByName('reference-outline') as LineSegments;
    expect(outline).toBeInstanceOf(LineSegments);
    expect(outline.material).toBeInstanceOf(LineDashedMaterial);
    expect(outline.geometry.getAttribute('lineDistance').count).toBe(24);
    expect(group.getObjectByName('outline')).toBeUndefined();
    const body = group.getObjectByName('body') as Mesh;
    // A 也要點得到：本體留著、全透明，不是 visible = false
    expect(body.visible).toBe(true);
    const scale = style === 'b' ? REFERENCE_FILL_OPACITY : 0;
    expect(body.material).toMatchObject({ opacity: spec.opacity * scale, depthWrite: false });
    expect(body.userData['opacityScale']).toBe(scale);
    const dispose = vi.spyOn(outline.material as LineDashedMaterial, 'dispose');
    disposeTree(group);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('一般資料仍是實心與深色描邊，實體仍是線框', () => {
    const item = buildNode({ ...spec, dashed: false });
    expect(item.getObjectByName('outline')).toBeDefined();
    expect(item.getObjectByName('reference-outline')).toBeUndefined();
    const entity = buildNode({ ...spec, dashed: false, hollow: true });
    expect((entity.getObjectByName('body') as Mesh).material).toMatchObject({ wireframe: true });
    expect(entity.getObjectByName('outline')).toBeUndefined();
    disposeTree(item);
    disposeTree(entity);
  });
});
