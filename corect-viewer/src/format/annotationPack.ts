import { DTYPE_INFO, type DecodedVolume, type Vec3 } from './corevol';
import type { Measurement, Roi } from '../geometry/roi';
import type { PlaneAxis } from '../geometry/viewMath';

export const ANNOTATION_PACK_FORMAT = 'corect-annotation-pack';
export const ANNOTATION_PACK_VERSION = 1;
const LEGACY_PACK_VERSION = 0;

export interface DisplaySettings {
  windowLevel: { window: number; level: number };
  threshold: number;
}

export interface VolumeIdentity {
  algorithm: 'SHA-256';
  digest: string;
  dtype: string;
  dimensions: Vec3;
  spacing: Vec3;
  origin: Vec3;
  voxelCount: number;
  voxelByteLength: number;
}

export interface AnnotationCoordinateSystem {
  kind: 'axis-aligned-ijk';
  indexBase: 0;
  fastestVaryingAxis: 'I';
  axisOrder: ['I', 'J', 'K'];
  axes: [
    { name: 'I'; unit: 'mm'; spacing: number },
    { name: 'J'; unit: 'mm'; spacing: number },
    { name: 'K'; unit: 'mm'; spacing: number },
  ];
  origin: Vec3;
  originUnit: 'mm';
}

export interface AnnotationPack {
  format: typeof ANNOTATION_PACK_FORMAT;
  formatVersion: typeof ANNOTATION_PACK_VERSION;
  exportedAt: string;
  volumeIdentity: VolumeIdentity;
  coordinateSystem: AnnotationCoordinateSystem;
  displaySettings: DisplaySettings;
  annotations: {
    crosshair: Vec3;
    measurements: Measurement[];
    rois: Roi[];
  };
}

export interface ImportSourceSummary {
  fileName: string;
  fileSize: number;
  importedAt: string;
  format: string;
  formatVersion: number;
  migratedFromVersion?: number;
  exportedAt?: string;
  volumeDigest?: string;
  volumeDimensions?: Vec3;
  mode: ImportMode;
  acceptedLegacyWithoutDigest: boolean;
  total: number;
  added: number;
  skippedDuplicates: number;
  renamedConflicts: number;
  replacedExistingMeasurements: number;
  replacedExistingRois: number;
}

export type ImportMode = 'merge' | 'replace';
export type IdentityStatus = 'exact' | 'mismatch' | 'legacy-unverified';
export type PreviewItemStatus = 'new' | 'duplicate' | 'conflict' | 'out-of-bounds';

export interface PreviewItem {
  key: string;
  instance: number;
  kind: 'measurement' | 'roi';
  id: string;
  label: string;
  status: PreviewItemStatus;
  reason: string;
  resolvedId?: string;
  collisionInPackage?: boolean;
}

export interface PreviewProblem {
  kind: 'measurement' | 'roi' | 'crosshair' | 'package';
  id?: string;
  message: string;
}

export interface AnnotationImportPreview {
  pack: AnnotationPack;
  currentIdentity: VolumeIdentity;
  identityStatus: IdentityStatus;
  identityMessage: string;
  migratedFromVersion?: number;
  items: PreviewItem[];
  crosshairStatus: 'ok' | 'out-of-bounds';
  problems: PreviewProblem[];
  resolutions: Record<string, string>;
  counts: Record<PreviewItemStatus, number>;
  canCommit: boolean;
  acceptLegacyRequired: boolean;
}

export class AnnotationPackError extends Error {
  code:
    | 'invalid-json'
    | 'unsupported-version'
    | 'invalid-schema'
    | 'identity-mismatch'
    | 'out-of-bounds'
    | 'conflict-resolution';

  constructor(
    message: string,
    code:
      | 'invalid-json'
      | 'unsupported-version'
      | 'invalid-schema'
      | 'identity-mismatch'
      | 'out-of-bounds'
      | 'conflict-resolution' = 'invalid-schema',
  ) {
    super(message);
    this.name = 'AnnotationPackError';
    this.code = code;
  }
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

function encodeCanonicalIdentity(volume: DecodedVolume): ArrayBuffer {
  const { header, data } = volume;
  const prefixSize = 32 + 6 * 8; // magic + version/dtype + dims + spacing/origin
  const bytes = new Uint8Array(prefixSize + data.byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('COREANNOT1\0'), 0);
  view.setUint16(12, 1, true);
  view.setUint16(14, header.dtype, true);
  header.dims.forEach((d, i) => view.setUint32(16 + i * 4, d, true));
  header.spacing.forEach((v, i) => view.setFloat64(28 + i * 8, v, true));
  header.origin.forEach((v, i) => view.setFloat64(52 + i * 8, v, true));
  bytes.set(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    prefixSize,
  );
  return bytes.buffer;
}

/** 体数据身份：几何参数 + dtype + 原始体素字节的 SHA-256。 */
export async function computeVolumeIdentity(volume: DecodedVolume): Promise<VolumeIdentity> {
  const canonical = encodeCanonicalIdentity(volume);
  const digestBuffer = await crypto.subtle.digest('SHA-256', canonical);
  const { dims, spacing, origin, dtype } = volume.header;
  return {
    algorithm: 'SHA-256',
    digest: toHex(digestBuffer),
    dtype: DTYPE_INFO[dtype].label,
    dimensions: [...dims] as Vec3,
    spacing: [...spacing] as Vec3,
    origin: [...origin] as Vec3,
    voxelCount: volume.voxelCount,
    voxelByteLength: volume.data.byteLength,
  };
}

export function createCoordinateSystem(volume: DecodedVolume): AnnotationCoordinateSystem {
  const { spacing, origin } = volume.header;
  return {
    kind: 'axis-aligned-ijk',
    indexBase: 0,
    fastestVaryingAxis: 'I',
    axisOrder: ['I', 'J', 'K'],
    axes: [
      { name: 'I', unit: 'mm', spacing: spacing[0] },
      { name: 'J', unit: 'mm', spacing: spacing[1] },
      { name: 'K', unit: 'mm', spacing: spacing[2] },
    ],
    origin: [...origin] as Vec3,
    originUnit: 'mm',
  };
}

export interface ExportAnnotationInput {
  volume: DecodedVolume;
  measurements: Measurement[];
  rois: Roi[];
  crosshair: Vec3;
  displaySettings: DisplaySettings;
  exportedAt?: string;
}

export async function createAnnotationPack(input: ExportAnnotationInput): Promise<AnnotationPack> {
  const identity = await computeVolumeIdentity(input.volume);
  const pack: AnnotationPack = {
    format: ANNOTATION_PACK_FORMAT,
    formatVersion: ANNOTATION_PACK_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    volumeIdentity: identity,
    coordinateSystem: createCoordinateSystem(input.volume),
    displaySettings: {
      windowLevel: { ...input.displaySettings.windowLevel },
      threshold: input.displaySettings.threshold,
    },
    annotations: {
      crosshair: [...input.crosshair] as Vec3,
      measurements: input.measurements.map((m) => ({
        ...m,
        p1: [...m.p1] as Vec3,
        p2: [...m.p2] as Vec3,
      })),
      rois: input.rois.map((r) => ({
        ...r,
        min: [...r.min] as [number, number],
        max: [...r.max] as [number, number],
      })),
    },
  };
  assertAnnotationPackShape(pack);
  assertWithinBounds(pack, identity.dimensions);
  return pack;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new AnnotationPackError(`${name} 必须是对象`);
  return value;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AnnotationPackError(`${name} 必须是有限数字`);
  }
  return value;
}

function integer(value: unknown, name: string): number {
  const n = finiteNumber(value, name);
  if (!Number.isSafeInteger(n)) throw new AnnotationPackError(`${name} 必须是安全整数`);
  return n;
}

function vec3(value: unknown, name: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new AnnotationPackError(`${name} 必须是包含 3 个数字的数组`);
  }
  return [
    finiteNumber(value[0], `${name}[0]`),
    finiteNumber(value[1], `${name}[1]`),
    finiteNumber(value[2], `${name}[2]`),
  ];
}

function intVec3(value: unknown, name: string): Vec3 {
  const v = vec3(value, name);
  if (!v.every((n) => Number.isSafeInteger(n))) {
    throw new AnnotationPackError(`${name} 必须全部为整数`);
  }
  return v;
}

function vec2(value: unknown, name: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new AnnotationPackError(`${name} 必须是包含 2 个数字的数组`);
  }
  return [finiteNumber(value[0], `${name}[0]`), finiteNumber(value[1], `${name}[1]`)];
}

function sameVec3(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function normalizeMeasurement(value: unknown, idPrefix: string): Measurement {
  const o = asObject(value, '测量标注');
  const id = typeof o.id === 'string' && o.id.trim() ? o.id : `${idPrefix}-${crypto.randomUUID()}`;
  const createdAt = o.createdAt === undefined ? 0 : integer(o.createdAt, `${id} 的 createdAt`);
  return { id, p1: vec3(o.p1, `${id} 的 p1`), p2: vec3(o.p2, `${id} 的 p2`), createdAt };
}

function normalizeRoi(value: unknown, idPrefix: string): Roi {
  const o = asObject(value, 'ROI 标注');
  const id = typeof o.id === 'string' && o.id.trim() ? o.id : `${idPrefix}-${crypto.randomUUID()}`;
  const axis = integer(o.axis, `${id} 的 axis`);
  if (axis !== 0 && axis !== 1 && axis !== 2) {
    throw new AnnotationPackError(`${id} 的 axis 必须是 0、1 或 2`);
  }
  const createdAt = o.createdAt === undefined ? 0 : integer(o.createdAt, `${id} 的 createdAt`);
  return {
    id,
    axis: axis as PlaneAxis,
    slice: integer(o.slice, `${id} 的 slice`),
    min: vec2(o.min, `${id} 的 min`).map((n) => {
      if (!Number.isSafeInteger(n)) throw new AnnotationPackError(`${id} 的 min 必须为整数`);
      return n;
    }) as [number, number],
    max: vec2(o.max, `${id} 的 max`).map((n) => {
      if (!Number.isSafeInteger(n)) throw new AnnotationPackError(`${id} 的 max 必须为整数`);
      return n;
    }) as [number, number],
    createdAt,
  };
}

function normalizeDisplaySettings(value: unknown): DisplaySettings {
  const o = asObject(value, '显示设置');
  const wl = asObject(o.windowLevel, '窗宽窗位');
  const window = finiteNumber(wl.window, '窗宽');
  if (window <= 0) throw new AnnotationPackError('窗宽必须大于 0');
  return {
    windowLevel: { window, level: finiteNumber(wl.level, '窗位') },
    threshold: finiteNumber(o.threshold, 'ROI 阈值'),
  };
}

/** 旧版 v0 包迁移到 v1；旧格式没有体素摘要，只允许严格几何匹配后显式确认。 */
function migrateLegacyPack(root: Record<string, unknown>): { pack: AnnotationPack } {
  const dimensions = intVec3(root.dimensions, 'dimensions');
  const spacing = vec3(root.spacing, 'spacing');
  const origin = root.origin === undefined ? ([0, 0, 0] as Vec3) : vec3(root.origin, 'origin');
  if (dimensions.some((d) => d < 1)) throw new AnnotationPackError('旧版包维度非法');
  if (spacing.some((s) => s <= 0)) throw new AnnotationPackError('旧版包间距非法');
  const annotations = root.annotations;
  let legacyMeasurements: unknown = root.measurements ??
    (isPlainObject(annotations) ? annotations.measurements : undefined);
  let legacyRois: unknown = root.rois ??
    (isPlainObject(annotations) ? annotations.rois : undefined);
  let legacyCrosshair: unknown = root.crosshair ??
    (isPlainObject(annotations) ? annotations.crosshair : undefined);
  if (!Array.isArray(legacyMeasurements) || !Array.isArray(legacyRois)) {
    throw new AnnotationPackError('旧版包缺少标注数组');
  }
  const crosshair = intVec3(legacyCrosshair ?? [0, 0, 0], 'crosshair');
  const displaySettings =
    root.displaySettings === undefined
      ? { windowLevel: { window: 1, level: 0 }, threshold: 0 }
      : normalizeDisplaySettings(root.displaySettings);
  const voxelCount = dimensions[0] * dimensions[1] * dimensions[2];
  const pack: AnnotationPack = {
    format: ANNOTATION_PACK_FORMAT,
    formatVersion: ANNOTATION_PACK_VERSION,
    exportedAt: typeof root.exportedAt === 'string' ? root.exportedAt : new Date(0).toISOString(),
    volumeIdentity: {
      algorithm: 'SHA-256',
      digest: '',
      dtype: typeof root.dtype === 'string' ? root.dtype : 'unknown',
      dimensions,
      spacing,
      origin,
      voxelCount,
      voxelByteLength: 0,
    },
    coordinateSystem: {
      kind: 'axis-aligned-ijk',
      indexBase: 0,
      fastestVaryingAxis: 'I',
      axisOrder: ['I', 'J', 'K'],
      axes: [
        { name: 'I', unit: 'mm', spacing: spacing[0] },
        { name: 'J', unit: 'mm', spacing: spacing[1] },
        { name: 'K', unit: 'mm', spacing: spacing[2] },
      ],
      origin,
      originUnit: 'mm',
    },
    displaySettings,
    annotations: {
      crosshair,
      measurements: legacyMeasurements.map((m) => normalizeMeasurement(m, 'legacy-measurement')),
      rois: legacyRois.map((r) => normalizeRoi(r, 'legacy-roi')),
    },
  };
  return { pack };
}

export function parseAnnotationPack(text: string): {
  pack: AnnotationPack;
  migratedFromVersion?: number;
} {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    throw new AnnotationPackError(
      `标注包不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
      'invalid-json',
    );
  }
  const o = asObject(root, '标注包');
  const formatVersion = integer(o.formatVersion, 'formatVersion');

  if (formatVersion === LEGACY_PACK_VERSION) {
    if (typeof o.format === 'string' && o.format !== ANNOTATION_PACK_FORMAT) {
      throw new AnnotationPackError('format 不匹配，不是 corect 标注包');
    }
    const migrated = migrateLegacyPack(o);
    return { pack: migrated.pack, migratedFromVersion: LEGACY_PACK_VERSION };
  }
  if (formatVersion !== ANNOTATION_PACK_VERSION) {
    const required = Array.isArray(o.requiredFields) ? o.requiredFields : [];
    const unknownRequired = required.filter((f): f is string => typeof f === 'string');
    throw new AnnotationPackError(
      `不支持的标注包版本 ${formatVersion}（当前仅支持 v${ANNOTATION_PACK_VERSION}）` +
        (unknownRequired.length
          ? `；新版本包含当前程序无法理解的必填字段：${unknownRequired.join(', ')}`
          : '；请升级程序后再导入'),
      'unsupported-version',
    );
  }
  if (o.format !== ANNOTATION_PACK_FORMAT) {
    throw new AnnotationPackError('format 不匹配，不是 corect 标注包');
  }
  if (typeof o.exportedAt !== 'string' || Number.isNaN(Date.parse(o.exportedAt))) {
    throw new AnnotationPackError('exportedAt 必须是合法 ISO 时间字符串');
  }

  const identity = parseVolumeIdentity(o.volumeIdentity);
  const coordinateSystem = parseCoordinateSystem(o.coordinateSystem, identity);
  const displaySettings = normalizeDisplaySettings(o.displaySettings);
  const annotations = asObject(o.annotations, 'annotations');
  if (!Array.isArray(annotations.measurements) || !Array.isArray(annotations.rois)) {
    throw new AnnotationPackError('annotations 中必须包含 measurements 和 rois 数组');
  }
  const pack: AnnotationPack = {
    format: ANNOTATION_PACK_FORMAT,
    formatVersion: ANNOTATION_PACK_VERSION,
    exportedAt: o.exportedAt,
    volumeIdentity: identity,
    coordinateSystem,
    displaySettings,
    annotations: {
      crosshair: intVec3(annotations.crosshair, 'crosshair'),
      measurements: annotations.measurements.map((m) => {
        const x = normalizeMeasurement(m, 'measurement');
        if (!x.id.trim()) throw new AnnotationPackError('测量标注 id 不能为空');
        return x;
      }),
      rois: annotations.rois.map((r) => {
        const x = normalizeRoi(r, 'roi');
        if (!x.id.trim()) throw new AnnotationPackError('ROI 标注 id 不能为空');
        return x;
      }),
    },
  };
  return { pack };
}

function parseVolumeIdentity(value: unknown): VolumeIdentity {
  const o = asObject(value, 'volumeIdentity');
  if (o.algorithm !== 'SHA-256') throw new AnnotationPackError('仅支持 SHA-256 体数据摘要');
  const digest = finiteString(o.digest, 'volumeIdentity.digest');
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new AnnotationPackError('体数据摘要必须是 64 位十六进制 SHA-256');
  const dimensions = intVec3(o.dimensions, '体数据维度');
  if (dimensions.some((d) => d < 1)) throw new AnnotationPackError('体数据维度必须大于 0');
  const spacing = vec3(o.spacing, '体数据间距');
  if (spacing.some((s) => s <= 0)) throw new AnnotationPackError('体数据间距必须大于 0');
  const origin = vec3(o.origin, '体数据原点');
  const voxelCount = integer(o.voxelCount, 'voxelCount');
  if (voxelCount !== dimensions[0] * dimensions[1] * dimensions[2]) {
    throw new AnnotationPackError('体数据摘要中的 voxelCount 与维度不一致');
  }
  const voxelByteLength = integer(o.voxelByteLength, 'voxelByteLength');
  if (voxelByteLength < voxelCount) throw new AnnotationPackError('体素字节长度异常');
  return {
    algorithm: 'SHA-256',
    digest,
    dtype: finiteString(o.dtype, 'dtype'),
    dimensions,
    spacing,
    origin,
    voxelCount,
    voxelByteLength,
  };
}

function finiteString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new AnnotationPackError(`${name} 必须是非空字符串`);
  return value;
}

function parseCoordinateSystem(value: unknown, identity: VolumeIdentity): AnnotationCoordinateSystem {
  const o = asObject(value, 'coordinateSystem');
  if (o.kind !== 'axis-aligned-ijk') throw new AnnotationPackError('仅支持 axis-aligned-ijk 坐标系');
  if (o.indexBase !== 0) throw new AnnotationPackError('坐标系索引原点必须为 0');
  if (o.fastestVaryingAxis !== 'I') throw new AnnotationPackError('最快变化轴必须为 I');
  if (!Array.isArray(o.axisOrder) || o.axisOrder.join(',') !== 'I,J,K') {
    throw new AnnotationPackError('坐标系轴顺序必须为 I,J,K');
  }
  const axes = o.axes;
  if (!Array.isArray(axes) || axes.length !== 3) throw new AnnotationPackError('坐标系必须包含 3 个轴');
  axes.forEach((axis, i) => {
    const a = asObject(axis, `axes[${i}]`);
    if (a.name !== ['I', 'J', 'K'][i]) {
      throw new AnnotationPackError(`axes[${i}] 的名称必须为 ${['I', 'J', 'K'][i]}`);
    }
    if (a.unit !== 'mm') throw new AnnotationPackError(`axes[${i}] 的单位必须为 mm`);
    if (a.spacing !== identity.spacing[i]) throw new AnnotationPackError(`axes[${i}] 的间距与体数据摘要不一致`);
  });
  const origin = vec3(o.origin, '坐标系原点');
  if (!sameVec3(origin, identity.origin)) throw new AnnotationPackError('坐标系原点与体数据摘要不一致');
  if (o.originUnit !== 'mm') throw new AnnotationPackError('原点单位必须为 mm');
  return {
    kind: 'axis-aligned-ijk',
    indexBase: 0,
    fastestVaryingAxis: 'I',
    axisOrder: ['I', 'J', 'K'],
    axes: [
      { name: 'I', unit: 'mm', spacing: identity.spacing[0] },
      { name: 'J', unit: 'mm', spacing: identity.spacing[1] },
      { name: 'K', unit: 'mm', spacing: identity.spacing[2] },
    ],
    origin,
    originUnit: 'mm',
  };
}

/** 导出前再次检查，避免程序内部错误把非法坐标写入 JSON。 */
export function assertAnnotationPackShape(pack: AnnotationPack): void {
  const dims = pack.volumeIdentity.dimensions;
  if (pack.annotations.crosshair.some((n) => !Number.isSafeInteger(n))) {
    throw new AnnotationPackError('十字丝坐标必须为整数');
  }
  pack.annotations.measurements.forEach((m) => {
    if (!m.id.trim()) throw new AnnotationPackError('测量标注 id 不能为空');
    [m.p1, m.p2].forEach((p) => {
      if (!p.every((n) => Number.isSafeInteger(n))) throw new AnnotationPackError(`测量 ${m.id} 坐标必须为整数`);
    });
  });
  pack.annotations.rois.forEach((r) => {
    if (!r.id.trim()) throw new AnnotationPackError('ROI 标注 id 不能为空');
    if (![0, 1, 2].includes(r.axis)) throw new AnnotationPackError(`ROI ${r.id} 的 axis 非法`);
    [r.slice, ...r.min, ...r.max].forEach((n) => {
      if (!Number.isSafeInteger(n)) throw new AnnotationPackError(`ROI ${r.id} 坐标必须为整数`);
    });
  });
  assertWithinBounds(pack, dims);
}

export function validatePointInBounds(point: Vec3, dims: Vec3, prefix: string): string | null {
  for (let i = 0; i < 3; i++) {
    const axisName = ['I', 'J', 'K'][i];
    if (!Number.isSafeInteger(point[i]) || point[i] < 0 || point[i] >= dims[i]) {
      return `${prefix} 的 ${axisName}=${point[i]} 超出 [0, ${dims[i] - 1}]`;
    }
  }
  return null;
}

function validateMeasurement(m: Measurement, dims: Vec3): string | null {
  return validatePointInBounds(m.p1, dims, `测量 ${m.id} 的起点`) ??
    validatePointInBounds(m.p2, dims, `测量 ${m.id} 的终点`);
}

function validateRoi(r: Roi, dims: Vec3): string | null {
  if (![0, 1, 2].includes(r.axis)) return `ROI ${r.id} 的轴向 ${String(r.axis)} 非法`;
  if (r.slice < 0 || r.slice >= dims[r.axis]) {
    return `ROI ${r.id} 的 slice=${r.slice} 超出 [0, ${dims[r.axis] - 1}]`;
  }
  const planeAxes = r.axis === 0 ? [1, 2] : r.axis === 1 ? [0, 2] : [0, 1];
  for (let i = 0; i < 2; i++) {
    const axis = planeAxes[i] as 0 | 1 | 2;
    const lo = i === 0 ? r.min[0] : r.min[1];
    const hi = i === 0 ? r.max[0] : r.max[1];
    const name = ['I', 'J', 'K'][axis];
    if (lo < 0 || hi < 0 || lo >= dims[axis] || hi >= dims[axis]) {
      return `ROI ${r.id} 的 ${name} 坐标 [${lo}, ${hi}] 超出 [0, ${dims[axis] - 1}]`;
    }
    if (lo > hi) return `ROI ${r.id} 的 ${name} 坐标 min 大于 max`;
  }
  return null;
}

export function assertWithinBounds(pack: AnnotationPack, dims: Vec3): void {
  const problems: string[] = [];
  const crosshair = validatePointInBounds(pack.annotations.crosshair, dims, '十字丝');
  if (crosshair) problems.push(crosshair);
  for (const m of pack.annotations.measurements) {
    const p = validateMeasurement(m, dims);
    if (p) problems.push(p);
  }
  for (const r of pack.annotations.rois) {
    const p = validateRoi(r, dims);
    if (p) problems.push(p);
  }
  if (problems.length) throw new AnnotationPackError(problems.join('；'), 'out-of-bounds');
}

function measurementContentKey(m: Measurement): string {
  return JSON.stringify({ p1: m.p1, p2: m.p2 });
}

function roiContentKey(r: Roi): string {
  return JSON.stringify({
    axis: r.axis,
    slice: r.slice,
    min: r.min,
    max: r.max,
  });
}

function measurementLabel(m: Measurement): string {
  return `测量 (${m.p1.join(',')})→(${m.p2.join(',')})`;
}

function roiLabel(r: Roi): string {
  const axisName = ['I', 'J', 'K'][r.axis];
  return `ROI ${axisName}=${r.slice} [${r.min.join(',')}]-[${r.max.join(',')}]`;
}

function uniqueId(base: string, used: Set<string>): string {
  let candidate = base;
  let i = 2;
  while (used.has(candidate)) candidate = `${base}-renamed-${i++}`;
  return candidate;
}

export interface PreviewInput {
  text: string;
  mode: ImportMode;
  volume: DecodedVolume;
  measurements: Measurement[];
  rois: Roi[];
}

export async function previewAnnotationPack(input: PreviewInput): Promise<AnnotationImportPreview> {
  const parsed = parseAnnotationPack(input.text);
  const pack = parsed.pack;
  const currentIdentity = await computeVolumeIdentity(input.volume);
  const dims = currentIdentity.dimensions;

  let identityStatus: IdentityStatus;
  let identityMessage: string;
  if (parsed.migratedFromVersion === LEGACY_PACK_VERSION) {
    const sameGeometry =
      sameVec3(pack.volumeIdentity.dimensions, currentIdentity.dimensions) &&
      sameVec3(pack.volumeIdentity.spacing, currentIdentity.spacing) &&
      sameVec3(pack.volumeIdentity.origin, currentIdentity.origin);
    identityStatus = sameGeometry ? 'legacy-unverified' : 'mismatch';
    identityMessage = sameGeometry
      ? '旧版 v0 标注包：尺寸、间距和原点匹配，但旧格式不包含体素内容摘要，需明确确认后迁移。'
      : '旧版标注包的尺寸、间距或原点与当前体数据不一致，已阻止导入。';
  } else {
    const sameGeometry =
      pack.volumeIdentity.dtype === currentIdentity.dtype &&
      sameVec3(pack.volumeIdentity.dimensions, currentIdentity.dimensions) &&
      sameVec3(pack.volumeIdentity.spacing, currentIdentity.spacing) &&
      sameVec3(pack.volumeIdentity.origin, currentIdentity.origin) &&
      pack.volumeIdentity.voxelCount === currentIdentity.voxelCount &&
      pack.volumeIdentity.voxelByteLength === currentIdentity.voxelByteLength;
    const matches = sameGeometry && pack.volumeIdentity.digest === currentIdentity.digest;
    identityStatus = matches ? 'exact' : 'mismatch';
    identityMessage = matches
      ? '体数据 SHA-256 摘要、尺寸、间距和坐标系完全匹配。'
      : sameGeometry
        ? '尺寸、间距、原点和数据类型相同，但体数据 SHA-256 摘要不匹配：这是内容不同的体数据，已阻止导入。'
        : '标注包的尺寸、间距、原点或数据类型与当前体数据不一致，已阻止导入。';
  }

  const problems: PreviewProblem[] = [];
  if (identityStatus === 'mismatch') {
    problems.push({ kind: 'package', message: identityMessage });
  }
  const crosshairProblem = validatePointInBounds(pack.annotations.crosshair, dims, '十字丝');
  if (crosshairProblem) {
    problems.push({ kind: 'crosshair', message: crosshairProblem });
  }

  const existingMeasurements = new Map(input.measurements.map((m) => [m.id, m]));
  const existingRois = new Map(input.rois.map((r) => [r.id, r]));
  const items: PreviewItem[] = [];
  const resolutions: Record<string, string> = {};
  const counts: Record<PreviewItemStatus, number> = {
    new: 0,
    duplicate: 0,
    conflict: 0,
    'out-of-bounds': 0,
  };

  let measurementInstance = 0;
  let roiInstance = 0;

  const addItem = <T extends Measurement | Roi>(
    kind: 'measurement' | 'roi',
    incoming: T,
    label: string,
    invalid: string | null,
    existingMap: Map<string, T>,
    incomingMap: Map<string, T>,
    usedIds: Set<string>,
    contentKeyOf: (item: T) => string,
  ) => {
    const instance = kind === 'measurement' ? measurementInstance++ : roiInstance++;
    const namespacedId = `${kind}:${incoming.id}`;
    const itemKey = `${namespacedId}#${instance}`;
    let status: PreviewItemStatus;
    let reason: string;
    let resolvedId: string | undefined;
    let collisionInPackage = false;
    if (invalid) {
      status = 'out-of-bounds';
      reason = invalid;
      problems.push({ kind, id: incoming.id, message: invalid });
    } else {
      const existing = existingMap.get(incoming.id);
      const priorIncoming = incomingMap.get(incoming.id);
      const priorContentKey = priorIncoming !== undefined
        ? contentKeyOf(priorIncoming)
        : existing !== undefined
          ? contentKeyOf(existing)
          : undefined;
      const contentKey = contentKeyOf(incoming);

      if (priorContentKey === undefined) {
        status = 'new';
        reason = '当前工程中不存在该唯一键，将新增。';
        incomingMap.set(incoming.id, incoming);
        usedIds.add(incoming.id);
      } else if (priorContentKey === contentKey) {
        status = 'duplicate';
        reason = '唯一键和内容完全一致，幂等跳过，不生成副本。';
      } else {
        status = 'conflict';
        collisionInPackage = existing === undefined;
        const requiresRename = collisionInPackage || input.mode === 'merge';
        if (requiresRename) {
          resolvedId = uniqueId(incoming.id, usedIds);
          resolutions[itemKey] = resolvedId;
          usedIds.add(resolvedId);
          incomingMap.set(resolvedId, incoming);
        } else {
          incomingMap.set(incoming.id, incoming);
        }
        reason = collisionInPackage
          ? '标注包内部存在相同唯一键但内容不同，需要重命名其中一项。'
          : input.mode === 'merge'
            ? '当前工程已有相同唯一键但内容不同，合并时会保留双方，需要重命名导入项。'
            : '当前工程已有相同唯一键但内容不同，替换模式将用导入项覆盖。';
      }
    }
    items.push({
      key: itemKey,
      instance,
      kind,
      id: incoming.id,
      label,
      status,
      reason,
      resolvedId,
      collisionInPackage,
    });
    counts[status]++;
  };

  const incomingMeasurements = new Map<string, Measurement>();
  const usedMeasurementIds = new Set(
    input.mode === 'merge' ? input.measurements.map((m) => m.id) : [],
  );
  for (const m of pack.annotations.measurements) {
    addItem(
      'measurement',
      m,
      measurementLabel(m),
      validateMeasurement(m, dims),
      existingMeasurements,
      incomingMeasurements,
      usedMeasurementIds,
      measurementContentKey,
    );
  }

  const incomingRois = new Map<string, Roi>();
  const usedRoiIds = new Set(input.mode === 'merge' ? input.rois.map((r) => r.id) : []);
  for (const r of pack.annotations.rois) {
    addItem(
      'roi',
      r,
      roiLabel(r),
      validateRoi(r, dims),
      existingRois,
      incomingRois,
      usedRoiIds,
      roiContentKey,
    );
  }

  return {
    pack,
    currentIdentity,
    identityStatus,
    identityMessage,
    migratedFromVersion: parsed.migratedFromVersion,
    items,
    crosshairStatus: crosshairProblem ? 'out-of-bounds' : 'ok',
    problems,
    resolutions,
    counts,
    canCommit: identityStatus !== 'mismatch' && problems.length === 0,
    acceptLegacyRequired: identityStatus === 'legacy-unverified',
  };
}

export interface CommitPreviewInput {
  projectId: string;
  preview: AnnotationImportPreview;
  mode: ImportMode;
  resolutions: Record<string, string>;
  acceptLegacy: boolean;
  existing: {
    measurements: Measurement[];
    rois: Roi[];
    importHistory?: ImportSourceSummary[];
  };
  fallbackDisplaySettings: DisplaySettings;
  source: { fileName: string; fileSize: number };
  now?: string;
}

export interface CommittedAnnotationData {
  record: {
    projectId: string;
    measurements: Measurement[];
    rois: Roi[];
    crosshair: Vec3;
    displaySettings: DisplaySettings;
    importHistory: ImportSourceSummary[];
    updatedAt: number;
  };
  summary: ImportSourceSummary;
}

export function buildCommittedAnnotationRecord(input: CommitPreviewInput): CommittedAnnotationData {
  const { preview, mode } = input;
  const pack = preview.pack;
  const dims = preview.currentIdentity.dimensions;
  if (preview.identityStatus === 'mismatch') {
    throw new AnnotationPackError(preview.identityMessage, 'identity-mismatch');
  }
  if (preview.identityStatus === 'legacy-unverified' && !input.acceptLegacy) {
    throw new AnnotationPackError('旧版标注包没有体素内容摘要，必须勾选确认后才能迁移', 'identity-mismatch');
  }
  if (preview.pack.volumeIdentity.digest && pack.volumeIdentity.digest !== preview.currentIdentity.digest) {
    throw new AnnotationPackError('体数据摘要复核不匹配', 'identity-mismatch');
  }
  assertWithinBounds(pack, dims);

  const measurements = mode === 'merge' ? [...input.existing.measurements] : [];
  const rois = mode === 'merge' ? [...input.existing.rois] : [];
  const existingM = new Map(input.existing.measurements.map((m) => [m.id, m]));
  const existingR = new Map(input.existing.rois.map((r) => [r.id, r]));
  const mMap = new Map(measurements.map((m) => [m.id, m]));
  const rMap = new Map(rois.map((r) => [r.id, r]));
  const incomingM = new Map<string, Measurement>();
  const incomingR = new Map<string, Roi>();
  let added = 0;
  let skippedDuplicates = 0;
  let renamedConflicts = 0;

  pack.annotations.measurements.forEach((incoming, incomingIndex) => {
    let id = incoming.id;
    const currentExisting = existingM.get(id);
    const duplicateIncoming = incomingM.get(id);
    const duplicateContent =
      currentExisting && measurementContentKey(currentExisting) === measurementContentKey(incoming)
        ? currentExisting
        : duplicateIncoming && measurementContentKey(duplicateIncoming) === measurementContentKey(incoming)
          ? duplicateIncoming
          : undefined;
    if (duplicateContent) {
      skippedDuplicates++;
      if (mode === 'replace' && currentExisting) {
        const stored = { ...incoming, id };
        measurements.push(stored);
        mMap.set(id, stored);
        existingM.delete(id);
      }
      incomingM.set(id, { ...incoming, id });
      return;
    }
    if (duplicateIncoming || (mode === 'merge' && currentExisting)) {
      const previewItem = preview.items.find(
        (item) => item.kind === 'measurement' && item.instance === incomingIndex,
      );
      const requiresRename = previewItem?.status === 'conflict' &&
        (previewItem.collisionInPackage || mode === 'merge');
      if (!previewItem || !requiresRename) {
        throw new AnnotationPackError(`冲突测量 ${incoming.id} 的重命名预览缺失`, 'conflict-resolution');
      }
      const resolved = input.resolutions[previewItem.key]?.trim();
      if (!resolved) throw new AnnotationPackError(`冲突测量 ${incoming.id} 必须重命名`, 'conflict-resolution');
      if (mMap.has(resolved) || incomingM.has(resolved)) {
        throw new AnnotationPackError(`重命名后的测量 ID ${resolved} 仍然重复`, 'conflict-resolution');
      }
      id = resolved;
      renamedConflicts++;
    } else if (mode === 'replace' && currentExisting) {
      existingM.delete(id);
    }
    const stored = { ...incoming, id };
    measurements.push(stored);
    mMap.set(id, stored);
    incomingM.set(id, stored);
    added++;
  });

  pack.annotations.rois.forEach((incoming, incomingIndex) => {
    let id = incoming.id;
    const currentExisting = existingR.get(id);
    const duplicateIncoming = incomingR.get(id);
    const duplicateContent =
      currentExisting && roiContentKey(currentExisting) === roiContentKey(incoming)
        ? currentExisting
        : duplicateIncoming && roiContentKey(duplicateIncoming) === roiContentKey(incoming)
          ? duplicateIncoming
          : undefined;
    if (duplicateContent) {
      skippedDuplicates++;
      if (mode === 'replace' && currentExisting) {
        const stored = { ...incoming, id };
        rois.push(stored);
        rMap.set(id, stored);
        existingR.delete(id);
      }
      incomingR.set(id, { ...incoming, id });
      return;
    }
    if (duplicateIncoming || (mode === 'merge' && currentExisting)) {
      const previewItem = preview.items.find(
        (item) => item.kind === 'roi' && item.instance === incomingIndex,
      );
      const requiresRename = previewItem?.status === 'conflict' &&
        (previewItem.collisionInPackage || mode === 'merge');
      if (!previewItem || !requiresRename) {
        throw new AnnotationPackError(`冲突 ROI ${incoming.id} 的重命名预览缺失`, 'conflict-resolution');
      }
      const resolved = input.resolutions[previewItem.key]?.trim();
      if (!resolved) throw new AnnotationPackError(`冲突 ROI ${incoming.id} 必须重命名`, 'conflict-resolution');
      if (rMap.has(resolved) || incomingR.has(resolved)) {
        throw new AnnotationPackError(`重命名后的 ROI ID ${resolved} 仍然重复`, 'conflict-resolution');
      }
      id = resolved;
      renamedConflicts++;
    } else if (mode === 'replace' && currentExisting) {
      existingR.delete(id);
    }
    const stored = { ...incoming, id };
    rois.push(stored);
    rMap.set(id, stored);
    incomingR.set(id, stored);
    added++;
  });

  if (mode === 'replace') {
    const retainedMeasurementIds = new Set(measurements.map((m) => m.id));
    const retainedRoiIds = new Set(rois.map((r) => r.id));
    for (const incoming of pack.annotations.measurements) {
      retainedMeasurementIds.add(incoming.id);
      preview.items
          .filter((item) => item.kind === 'measurement')
          .map((item) => input.resolutions[item.key])
          .filter((id): id is string => !!id)
          .forEach((id) => retainedMeasurementIds.add(id));
    }
    for (const incoming of pack.annotations.rois) {
      retainedRoiIds.add(incoming.id);
      preview.items
          .filter((item) => item.kind === 'roi')
          .map((item) => input.resolutions[item.key])
          .filter((id): id is string => !!id)
          .forEach((id) => retainedRoiIds.add(id));
    }
    for (let i = measurements.length - 1; i >= 0; i--) {
      if (!retainedMeasurementIds.has(measurements[i].id)) measurements.splice(i, 1);
    }
    for (let i = rois.length - 1; i >= 0; i--) {
      if (!retainedRoiIds.has(rois[i].id)) rois.splice(i, 1);
    }
  }

  const displaySettings =
    preview.migratedFromVersion !== undefined &&
    pack.displaySettings.windowLevel.window === 1 &&
    pack.displaySettings.windowLevel.level === 0 &&
    pack.displaySettings.threshold === 0
      ? input.fallbackDisplaySettings
      : pack.displaySettings;
  const now = input.now ?? new Date().toISOString();
  const replacedExistingMeasurements = mode === 'replace' ? input.existing.measurements.length : 0;
  const replacedExistingRois = mode === 'replace' ? input.existing.rois.length : 0;
  const summary: ImportSourceSummary = {
    fileName: input.source.fileName,
    fileSize: input.source.fileSize,
    importedAt: now,
    format: pack.format,
    formatVersion: ANNOTATION_PACK_VERSION,
    migratedFromVersion: preview.migratedFromVersion,
    exportedAt: pack.exportedAt,
    volumeDigest: pack.volumeIdentity.digest || undefined,
    volumeDimensions: [...pack.volumeIdentity.dimensions] as Vec3,
    mode,
    acceptedLegacyWithoutDigest: preview.identityStatus === 'legacy-unverified',
    total: pack.annotations.measurements.length + pack.annotations.rois.length,
    added,
    skippedDuplicates,
    renamedConflicts,
    replacedExistingMeasurements,
    replacedExistingRois,
  };
  const history = [...(input.existing.importHistory ?? []), summary].slice(-20);

  return {
    record: {
      projectId: input.projectId,
      measurements,
      rois,
      crosshair: [...pack.annotations.crosshair] as Vec3,
      displaySettings,
      importHistory: history,
      updatedAt: Date.parse(now),
    },
    summary,
  };
}
