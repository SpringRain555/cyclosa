/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LineDashedMaterial, LineSegments, Mesh } from 'three';
import { buildNode, disposeTree, type NodeSpec } from '../../web/src/components/graph/objects.js';
import { REFERENCE_FILL_OPACITY } from '../../web/src/components/graph/reference-style.js';

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
  vi.stubGlobal('document', {
    documentElement: {},
    createElement: () => ({ getContext: () => null }),
  });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => 'blue' }));
});

afterEach(() => vi.unstubAllGlobals());

describe('書目虛線稜線與淡填', () => {
  it('固定淡填且可點選，稜線有距離資料，2D 與 3D 使用相同物件', () => {
    const group = buildNode(spec);
    const outline = group.getObjectByName('reference-outline') as LineSegments;
    expect(outline).toBeInstanceOf(LineSegments);
    expect(outline.material).toBeInstanceOf(LineDashedMaterial);
    expect(outline.geometry.getAttribute('lineDistance').count).toBe(24);
    expect(group.getObjectByName('outline')).toBeUndefined();
    const body = group.getObjectByName('body') as Mesh;
    expect(body.visible).toBe(true);
    expect(REFERENCE_FILL_OPACITY).toBe(0.3);
    expect(body.material).toMatchObject({
      opacity: spec.opacity * REFERENCE_FILL_OPACITY,
      transparent: true,
      depthWrite: false,
    });
    expect(body.userData['opacityScale']).toBe(REFERENCE_FILL_OPACITY);
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
