/**
 * 合成岩芯验收测试：用各向异性间距（0.5×0.5×2.0 mm）的样例文件
 * 验证坐标换算、物理测量与 ROI 统计的正确性。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeCorevol, DType, type DecodedVolume } from './corevol';
import { computeRoiStats } from '../geometry/roi';
import { ijkToWorld, physicalDistance, voxelIndex } from '../geometry/viewMath';

const SAMPLE_PATH = join(import.meta.dirname, '../../public/samples/synthetic-core.corevol');

function loadSample(): DecodedVolume {
  const buf = readFileSync(SAMPLE_PATH);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return decodeCorevol(arrayBuffer);
}

const vol = loadSample();
const { dims, spacing, origin } = vol.header;

// 样例设计参数（见 scripts/generate-sample.mjs）
const CUBE_CENTER: [number, number, number] = [100, 30, 12];
const LANDMARK_A: [number, number, number] = [24, 24, 60];
const LANDMARK_B: [number, number, number] = [84, 104, 120];

describe('合成岩芯样例（各向异性 0.5×0.5×2.0 mm）', () => {
  it('文件头：维度 / 间距 / 类型', () => {
    expect(dims).toEqual([128, 128, 200]);
    expect(spacing).toEqual([0.5, 0.5, 2.0]);
    expect(origin).toEqual([0, 0, 0]);
    expect(vol.header.dtype).toBe(DType.UInt8);
    expect(vol.voxelCount).toBe(128 * 128 * 200);
  });

  it('坐标验证：立方体中心 IJK(100,30,12) ↔ 物理 (50,15,24) mm', () => {
    expect(ijkToWorld(CUBE_CENTER, spacing, origin)).toEqual([50, 15, 24]);
    expect(vol.data[voxelIndex(CUBE_CENTER, dims)]).toBe(255);
  });

  it('坐标验证：立方体 5×5×5 个角均为 255，邻域不是 255', () => {
    for (let k = 10; k <= 14; k++)
      for (let j = 28; j <= 32; j++)
        for (let i = 98; i <= 102; i++) expect(vol.data[voxelIndex([i, j, k], dims)]).toBe(255);
    // 立方体正上方一层不再是 255（层理背景 < 255）
    expect(vol.data[voxelIndex([100, 30, 15], dims)]).not.toBe(255);
  });

  it('测量验证：标志点 A→B 距离恰为 130 mm', () => {
    expect(vol.data[voxelIndex(LANDMARK_A, dims)]).toBe(255);
    expect(vol.data[voxelIndex(LANDMARK_B, dims)]).toBe(255);
    // 体素差 (60,80,60) × 间距 (0.5,0.5,2.0) = (30,40,120) mm
    expect(physicalDistance(LANDMARK_A, LANDMARK_B, spacing)).toBeCloseTo(130, 10);
  });

  it('各向异性验证：K 方向相邻层物理距离 2.0 mm，I 方向 0.5 mm', () => {
    expect(physicalDistance([0, 0, 60], [0, 0, 61], spacing)).toBeCloseTo(2.0, 10);
    expect(physicalDistance([60, 0, 0], [61, 0, 0], spacing)).toBeCloseTo(0.5, 10);
  });

  it('ROI 验证：K=12 层框住立方体截面 → 25 体素全部 ≥ 阈值 200', () => {
    const stats = computeRoiStats(
      vol.data,
      dims,
      { axis: 2, slice: 12, min: [98, 28], max: [102, 32] },
      200,
    );
    expect(stats.total).toBe(25);
    expect(stats.above).toBe(25);
    expect(stats.min).toBe(255);
    expect(stats.mean).toBe(255);
  });

  it('ROI 验证：I=100 切面上立方体截面为 5×5', () => {
    // I 切面（axis=0）面内坐标为 (J, K)
    const stats = computeRoiStats(
      vol.data,
      dims,
      { axis: 0, slice: 100, min: [28, 10], max: [32, 14] },
      200,
    );
    expect(stats.total).toBe(25);
    expect(stats.above).toBe(25);
  });

  it('岩芯几何：圆柱外为空气（0），轴心处为岩石（>0）', () => {
    expect(vol.data[voxelIndex([0, 0, 50], dims)]).toBe(0); // 角落在圆柱外
    expect(vol.data[voxelIndex([64, 64, 50], dims)]).toBeGreaterThan(0); // 轴心
  });
});
