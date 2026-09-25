import { describe, expect, it } from 'vitest';
import {
  VIEW_CONFIGS,
  fitHalfHeight,
  ijkToWorld,
  physicalDistance,
  screenToWorld,
  sliceFocal,
  viewBasis,
  worldToIjk,
  worldToScreen,
  type CameraModel,
} from './viewMath';
import type { Vec3 } from '../format/corevol';

// 各向异性：K 方向层厚是 IJ 的 4 倍
const SPACING: Vec3 = [0.5, 0.5, 2.0];
const ORIGIN: Vec3 = [0, 0, 0];
const DIMS: Vec3 = [128, 128, 200];

describe('体素索引 ↔ 物理坐标（各向异性）', () => {
  it('ijkToWorld 按间距缩放', () => {
    expect(ijkToWorld([100, 30, 12], SPACING, ORIGIN)).toEqual([50, 15, 24]);
    expect(ijkToWorld([0, 0, 0], SPACING, ORIGIN)).toEqual([0, 0, 0]);
  });

  it('worldToIjk 四舍五入并夹取', () => {
    expect(worldToIjk([50, 15, 24], SPACING, ORIGIN, DIMS)).toEqual([100, 30, 12]);
    expect(worldToIjk([-5, 999, 24.9], SPACING, ORIGIN, DIMS)).toEqual([0, 127, 12]);
  });

  it('往返一致', () => {
    const ijk: Vec3 = [37, 91, 123];
    expect(worldToIjk(ijkToWorld(ijk, SPACING, ORIGIN), SPACING, ORIGIN, DIMS)).toEqual(ijk);
  });

  it('physicalDistance 使用物理间距', () => {
    // 体素差 (60, 80, 60) → 物理差 (30, 40, 120) → 130 mm
    expect(physicalDistance([24, 24, 60], [84, 104, 120], SPACING)).toBeCloseTo(130, 10);
    // 纯 K 方向 1 层 = 2.0 mm（各向异性检查）
    expect(physicalDistance([0, 0, 0], [0, 0, 1], SPACING)).toBeCloseTo(2.0, 10);
    // 纯 I 方向 1 体素 = 0.5 mm
    expect(physicalDistance([0, 0, 0], [1, 0, 0], SPACING)).toBeCloseTo(0.5, 10);
  });
});

describe('切面相机模型', () => {
  it.each([0, 1, 2] as const)('视图 %d：right/up 正交且为单位向量', (axis) => {
    const { right, up } = viewBasis(VIEW_CONFIGS[axis]);
    const dot = right[0] * up[0] + right[1] * up[1] + right[2] * up[2];
    expect(dot).toBeCloseTo(0, 10);
    expect(Math.hypot(...right)).toBeCloseTo(1, 10);
    expect(Math.hypot(...up)).toBeCloseTo(1, 10);
  });

  it('sliceFocal 位于当前层、面内居中', () => {
    const focal = sliceFocal(VIEW_CONFIGS[2], DIMS, SPACING, ORIGIN, 12);
    expect(focal[2]).toBeCloseTo(24, 10); // k=12 → z=24mm
    expect(focal[0]).toBeCloseTo((0.5 * 127) / 2, 10);
    expect(focal[1]).toBeCloseTo((0.5 * 127) / 2, 10);
  });

  it('屏幕 ↔ 世界往返一致（三个视图）', () => {
    for (const axis of [0, 1, 2] as const) {
      const cfg = VIEW_CONFIGS[axis];
      const { right, up } = viewBasis(cfg);
      const cam: CameraModel = {
        focal: sliceFocal(cfg, DIMS, SPACING, ORIGIN, 50),
        right,
        up,
        halfHeight: fitHalfHeight(cfg, DIMS, SPACING, 4 / 3),
        width: 640,
        height: 480,
      };
      const world = screenToWorld(cam, 123, 456);
      const [px, py] = worldToScreen(cam, world);
      expect(px).toBeCloseTo(123, 6);
      expect(py).toBeCloseTo(456, 6);
      // 映射回体素索引后应落在当前层上
      const ijk = worldToIjk(world, SPACING, ORIGIN, DIMS);
      expect(ijk[axis]).toBe(50);
    }
  });

  it('视口中心即焦点', () => {
    const cfg = VIEW_CONFIGS[2];
    const { right, up } = viewBasis(cfg);
    const focal = sliceFocal(cfg, DIMS, SPACING, ORIGIN, 100);
    const cam: CameraModel = { focal, right, up, halfHeight: 40, width: 400, height: 300 };
    expect(worldToScreen(cam, focal)).toEqual([200, 150]);
  });
});
