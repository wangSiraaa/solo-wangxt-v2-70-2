import type { Vec3, VoxelArray } from '../format/corevol';
import { voxelIndex, type PlaneAxis } from './viewMath';

/** 距离测量标注：两个体素索引点 */
export interface Measurement {
  id: string;
  p1: Vec3;
  p2: Vec3;
  createdAt: number;
}

/** 矩形兴趣区：某切面某层上的 2D 矩形（体素索引，闭区间） */
export interface Roi {
  id: string;
  /** 所在切面轴向 */
  axis: PlaneAxis;
  /** 所在层号 */
  slice: number;
  /** 矩形角点（面内两轴的体素索引，含端点） */
  min: [number, number];
  max: [number, number];
  createdAt: number;
}

export interface RoiStats {
  /** ROI 内体素总数 */
  total: number;
  /** 值 ≥ 阈值的体素数 */
  above: number;
  min: number;
  max: number;
  mean: number;
}

/** 计算 ROI 内的体素统计（含阈值预览计数） */
export function computeRoiStats(
  data: VoxelArray,
  dims: Vec3,
  roi: Pick<Roi, 'axis' | 'slice' | 'min' | 'max'>,
  threshold: number,
): RoiStats {
  const uAxis = roi.axis === 0 ? 1 : 0;
  const vAxis = roi.axis === 2 ? 1 : 2;
  let total = 0;
  let above = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  const ijk: Vec3 = [0, 0, 0];
  ijk[roi.axis] = roi.slice;
  for (let v = roi.min[1]; v <= roi.max[1]; v++) {
    ijk[vAxis] = v;
    for (let u = roi.min[0]; u <= roi.max[0]; u++) {
      ijk[uAxis] = u;
      const value = data[voxelIndex(ijk, dims)];
      total++;
      if (value >= threshold) above++;
      if (value < min) min = value;
      if (value > max) max = value;
      sum += value;
    }
  }
  return { total, above, min, max, mean: total > 0 ? sum / total : NaN };
}
