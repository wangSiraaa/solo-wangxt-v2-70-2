import type { Vec3 } from '../format/corevol';

/** 正交切面轴向：0=I（矢状面），1=J（冠状面），2=K（水平面） */
export type PlaneAxis = 0 | 1 | 2;

export interface ViewConfig {
  axis: PlaneAxis;
  /** 屏幕右方向对应的体素轴 */
  uAxis: PlaneAxis;
  /** 屏幕上方向对应的体素轴 */
  vAxis: PlaneAxis;
  /** 相机指向焦点的单位向量（世界系） */
  cameraDir: Vec3;
  viewUp: Vec3;
  label: string;
  axisLabel: string;
}

/**
 * 三个正交视图约定（右手系，K 轴向上）：
 * - I 切面：显示 J（右）× K（上），相机在 +I 侧
 * - J 切面：显示 I（右）× K（上），相机在 -J 侧
 * - K 切面：显示 I（右）× J（上），相机在 +K 侧
 */
export const VIEW_CONFIGS: Record<PlaneAxis, ViewConfig> = {
  0: { axis: 0, uAxis: 1, vAxis: 2, cameraDir: [-1, 0, 0], viewUp: [0, 0, 1], label: '矢状面', axisLabel: 'I' },
  1: { axis: 1, uAxis: 0, vAxis: 2, cameraDir: [0, 1, 0], viewUp: [0, 0, 1], label: '冠状面', axisLabel: 'J' },
  2: { axis: 2, uAxis: 0, vAxis: 1, cameraDir: [0, 0, -1], viewUp: [0, 1, 0], label: '水平面', axisLabel: 'K' },
};

/** 平行投影相机模型：与 vtk 相机参数一一对应，用于屏幕↔世界仿射换算 */
export interface CameraModel {
  /** 焦点（世界坐标，mm），位于当前切面上 */
  focal: Vec3;
  /** 屏幕右方向单位向量（世界系） */
  right: Vec3;
  /** 屏幕上方向单位向量（世界系） */
  up: Vec3;
  /** 视口半高对应的世界长度（vtk parallelScale） */
  halfHeight: number;
  /** 视口尺寸（CSS 像素） */
  width: number;
  height: number;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** 由视图配置推导相机模型的 right/up（right = dir × up） */
export function viewBasis(cfg: ViewConfig): { right: Vec3; up: Vec3 } {
  return { right: cross(cfg.cameraDir, cfg.viewUp), up: cfg.viewUp };
}

/** 当前切面的世界焦点：切面中心 */
export function sliceFocal(
  cfg: ViewConfig,
  dims: Vec3,
  spacing: Vec3,
  origin: Vec3,
  sliceIndex: number,
): Vec3 {
  const focal: Vec3 = [0, 0, 0];
  for (let a = 0 as PlaneAxis; a < 3; a = (a + 1) as PlaneAxis) {
    focal[a] =
      a === cfg.axis
        ? origin[a] + spacing[a] * sliceIndex
        : origin[a] + (spacing[a] * (dims[a] - 1)) / 2;
  }
  return focal;
}

/** 让整层切面恰好充满视口的平行投影半高（留 3% 边距） */
export function fitHalfHeight(cfg: ViewConfig, dims: Vec3, spacing: Vec3, aspect: number): number {
  const uExtent = dims[cfg.uAxis] * spacing[cfg.uAxis];
  const vExtent = dims[cfg.vAxis] * spacing[cfg.vAxis];
  return Math.max(vExtent / 2, uExtent / (2 * aspect)) * 1.03;
}

/** 屏幕坐标（CSS px，左上原点）→ 世界坐标（mm）。 */
export function screenToWorld(cam: CameraModel, px: number, py: number): Vec3 {
  const ox = ((px - cam.width / 2) / (cam.height / 2)) * cam.halfHeight;
  const oy = ((cam.height / 2 - py) / (cam.height / 2)) * cam.halfHeight;
  return [
    cam.focal[0] + cam.right[0] * ox + cam.up[0] * oy,
    cam.focal[1] + cam.right[1] * ox + cam.up[1] * oy,
    cam.focal[2] + cam.right[2] * ox + cam.up[2] * oy,
  ];
}

/** 世界坐标（mm）→ 屏幕坐标（CSS px）。 */
export function worldToScreen(cam: CameraModel, w: Vec3): [number, number] {
  const d: Vec3 = [w[0] - cam.focal[0], w[1] - cam.focal[1], w[2] - cam.focal[2]];
  const ox = d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2];
  const oy = d[0] * cam.up[0] + d[1] * cam.up[1] + d[2] * cam.up[2];
  return [
    cam.width / 2 + (ox / cam.halfHeight) * (cam.height / 2),
    cam.height / 2 - (oy / cam.halfHeight) * (cam.height / 2),
  ];
}

/** 体素索引（可为小数，表示体素边界）→ 世界坐标 mm */
export function ijkToWorld(ijk: Vec3, spacing: Vec3, origin: Vec3): Vec3 {
  return [
    origin[0] + ijk[0] * spacing[0],
    origin[1] + ijk[1] * spacing[1],
    origin[2] + ijk[2] * spacing[2],
  ];
}

/** 世界坐标 → 最近的体素索引（四舍五入并夹取到有效范围） */
export function worldToIjk(world: Vec3, spacing: Vec3, origin: Vec3, dims: Vec3): Vec3 {
  const ijk: Vec3 = [0, 0, 0];
  for (let a = 0 as PlaneAxis; a < 3; a = (a + 1) as PlaneAxis) {
    const idx = Math.round((world[a] - origin[a]) / spacing[a]);
    ijk[a] = Math.min(Math.max(idx, 0), dims[a] - 1);
  }
  return ijk;
}

export function clampIjk(ijk: Vec3, dims: Vec3): Vec3 {
  return [
    Math.min(Math.max(Math.round(ijk[0]), 0), dims[0] - 1),
    Math.min(Math.max(Math.round(ijk[1]), 0), dims[1] - 1),
    Math.min(Math.max(Math.round(ijk[2]), 0), dims[2] - 1),
  ];
}

/** 按体素物理间距计算两点真实距离（mm） */
export function physicalDistance(p1: Vec3, p2: Vec3, spacing: Vec3): number {
  const dx = (p1[0] - p2[0]) * spacing[0];
  const dy = (p1[1] - p2[1]) * spacing[1];
  const dz = (p1[2] - p2[2]) * spacing[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 体素数据线性索引：I 最快 */
export function voxelIndex(ijk: Vec3, dims: Vec3): number {
  return ijk[0] + dims[0] * (ijk[1] + dims[1] * ijk[2]);
}
