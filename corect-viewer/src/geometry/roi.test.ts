import { describe, expect, it } from 'vitest';
import { computeRoiStats } from './roi';
import { voxelIndex } from './viewMath';
import type { Vec3 } from '../format/corevol';

const DIMS: Vec3 = [4, 4, 4];

function makeData(): Uint8Array {
  const data = new Uint8Array(64);
  // 在 k=2 层放一个 2×2 高值区：i∈[1,2], j∈[1,2]，值 200
  for (const [i, j] of [
    [1, 1],
    [2, 1],
    [1, 2],
    [2, 2],
  ] as const) {
    data[voxelIndex([i, j, 2], DIMS)] = 200;
  }
  return data;
}

describe('ROI 统计', () => {
  it('体素计数与阈值计数（K 切面）', () => {
    const stats = computeRoiStats(makeData(), DIMS, {
      axis: 2,
      slice: 2,
      min: [0, 0],
      max: [3, 3],
    }, 100);
    expect(stats.total).toBe(16);
    expect(stats.above).toBe(4);
    expect(stats.min).toBe(0);
    expect(stats.max).toBe(200);
    expect(stats.mean).toBeCloseTo((4 * 200) / 16, 10);
  });

  it('阈值边界：≥ 阈值计入', () => {
    const stats = computeRoiStats(makeData(), DIMS, {
      axis: 2,
      slice: 2,
      min: [1, 1],
      max: [2, 2],
    }, 200);
    expect(stats.total).toBe(4);
    expect(stats.above).toBe(4);
  });

  it('I 切面（axis=0）使用 J×K 面内坐标', () => {
    const data = makeData();
    // i=1 切面：j∈[1,2], k=2 处有两个 200
    const stats = computeRoiStats(data, DIMS, { axis: 0, slice: 1, min: [1, 2], max: [2, 2] }, 100);
    expect(stats.total).toBe(2);
    expect(stats.above).toBe(2);
  });

  it('J 切面（axis=1）使用 I×K 面内坐标', () => {
    const data = makeData();
    const stats = computeRoiStats(data, DIMS, { axis: 1, slice: 1, min: [1, 2], max: [2, 2] }, 100);
    expect(stats.total).toBe(2);
    expect(stats.above).toBe(2);
  });
});
