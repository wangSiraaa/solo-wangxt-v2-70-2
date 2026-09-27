import {
  DTYPE_INFO,
  MAX_VOXELS,
  type DecodedVolume,
  type DType,
  type Vec3,
} from '../format/corevol';
import type { Measurement, Roi } from '../geometry/roi';
import type { PlaneAxis } from '../geometry/viewMath';

export const ANNOTATION_PACKAGE_FORMAT = 'corect.annotation-package+json';
export const ANNOTATION_PACKAGE_VERSION = 1;

/** 当前版本能够理解的未来版本必填特性；为空表示 v1 无额外特性开关。 */
const KNOWN_REQUIRED_FIELDS = new Set<string>();

export const COORDINATE_SYSTEM = {
  id: 'corect-ijk-mm-v1',
  type: 'orthogonal-indexed-voxel',
  axisNames: ['I', 'J', 'K'],
  worldAxes: ['x', 'y', 'z'],
  units: ['mm', 'mm', 'mm'],
  ijkToWorld: 'origin + ijk * spacing',
  fastestVaryingAxis: 'I',
  handedness: 'right-handed',
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
} as const;

export interface CoordinateSystemInfo {
  id: string;
  type: string;
  axisNames: readonly [string, string, string];
  worldAxes: readonly [string, string, string];
  units: readonly [string, string, string];
  ijkToWorld: string;
  fastestVaryingAxis: string;
  handedness: string;
  direction: readonly number[];
}

export interface VolumeIdentitySummary {
  name?: string;
  dtype: DType;
  dims: Vec3;
  spacing: Vec3;
  origin: Vec3;
  voxelCount: number;
  bodyByteLength: number;
  valueRange: { min: number; max: number };
  bodyDigestSHA256: string;
  coordinateSystem: CoordinateSystemInfo;
}

export interface DisplaySettings {
  crosshair: Vec3;
  windowLevel: { window: number; level: number };
  threshold: number;
}

export interface AnnotationPackage {
  format: string;
  formatVersion: number;
  exportedAt: number;
  requiredFields?: string[];
  packageDigestSHA256?: string;
  volume: VolumeIdentitySummary;
  display: DisplaySettings;
  measurements: Measurement[];
  rois: Roi[];
}

export type AnnotationKind = 'measurement' | 'roi';
export type ImportMode = 'merge' | 'replace';
export type PreviewStatus = 'new' | 'duplicate' | 'conflict' | 'invalid';

export interface PreviewItem {
  key: string;
  kind: AnnotationKind;
  index: number;
  id: string;
  label?: string;
  status: PreviewStatus;
  issue?: string;
  resolutionRequired: { merge: boolean; replace: boolean };
}

export interface ImportStats {
  added: number;
  duplicatesSkipped: number;
  conflictsRenamed: number;
  replacedExisting: number;
}

export interface ImportSourceSummary {
  fileName: string;
  fileSize: number;
  fileDigestSHA256: string;
  packageDigestSHA256?: string;
  sourceFormatVersion: number;
  importedAt: number;
}

export interface AnnotationPreview {
  package: AnnotationPackage | null;
  sourceFormatVersion: number | null;
  identity: {
    current: VolumeIdentitySummary | null;
    incoming: VolumeIdentitySummary | null;
    match: boolean;
    mismatches: string[];
  };
  errors: string[];
  warnings: string[];
  items: PreviewItem[];
  counts: Record<PreviewStatus, number>;
  existingCounts: { measurement: number; roi: number };
  resolutionSuggestions: Record<string, string>;
  canConfirm: boolean;
}

export interface PlannedImport {
  measurements: Measurement[];
  rois: Roi[];
  display: DisplaySettings;
  stats: ImportStats;
}

type ResolutionMap = Record<string, string>;

export async function sha256Hex(input: Uint8Array<ArrayBuffer> | string): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'undefined') return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((k) => record[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
      .join(',')}}`;
  }
  throw new Error(`标注包中包含不可序列化的值：${typeof value}`);
}

export async function createVolumeIdentity(volume: DecodedVolume): Promise<VolumeIdentitySummary> {
  const { header, data, voxelCount, min, max } = volume;
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength) as Uint8Array<ArrayBuffer>;
  return {
    name: header.name || undefined,
    dtype: header.dtype,
    dims: [...header.dims] as Vec3,
    spacing: [...header.spacing] as Vec3,
    origin: [...header.origin] as Vec3,
    voxelCount,
    bodyByteLength: data.byteLength,
    valueRange: { min, max },
    bodyDigestSHA256: await sha256Hex(bytes),
    coordinateSystem: COORDINATE_SYSTEM,
  };
}

export interface CreatePackageInput {
  volume: DecodedVolume;
  measurements: Measurement[];
  rois: Roi[];
  display: DisplaySettings;
  exportedAt?: number;
}

export async function createAnnotationPackage(input: CreatePackageInput): Promise<AnnotationPackage> {
  const base: AnnotationPackage = {
    format: ANNOTATION_PACKAGE_FORMAT,
    formatVersion: ANNOTATION_PACKAGE_VERSION,
    exportedAt: input.exportedAt ?? Date.now(),
    volume: await createVolumeIdentity(input.volume),
    display: structuredClone(input.display),
    measurements: structuredClone(input.measurements),
    rois: structuredClone(input.rois),
  };
  return { ...base, packageDigestSHA256: await sha256Hex(stableStringify(base)) };
}

export async function verifyPackageDigest(raw: unknown): Promise<string | null> {
  if (!isRecord(raw) || raw.formatVersion !== ANNOTATION_PACKAGE_VERSION) return null;
  const digest = raw.packageDigestSHA256;
  if (typeof digest !== 'string' || !/^[0-9a-fA-F]{64}$/.test(digest)) {
    return '标注包缺少格式正确的 packageDigestSHA256 摘要';
  }
  const copy = { ...raw };
  delete copy.packageDigestSHA256;
  const actual = await sha256Hex(stableStringify(copy));
  return actual === digest.toLowerCase() ? null : '标注包摘要不匹配：文件可能已被修改';
}

interface ParseResult {
  package: AnnotationPackage;
  errors: string[];
  itemIssues: Map<string, string>;
  warnings: string[];
  sourceFormatVersion: number;
}

export function parseAnnotationPackage(raw: unknown): ParseResult {
  const fatal: string[] = [];
  if (!isRecord(raw)) {
    return {
      package: emptyPackage(),
      errors: ['标注包必须是 JSON 对象'],
      itemIssues: new Map(),
      warnings: [],
      sourceFormatVersion: NaN,
    };
  }
  const format = raw.format ?? ANNOTATION_PACKAGE_FORMAT;
  if (format !== ANNOTATION_PACKAGE_FORMAT) {
    fatal.push(`无法识别的标注包格式：${String(format)}`);
  }
  const version = raw.formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    fatal.push('formatVersion 必须是非负整数');
  }
  const sourceVersion = typeof version === 'number' ? version : 0;
  const requiredFields = raw.requiredFields ?? [];
  if (!Array.isArray(requiredFields) || !requiredFields.every((f) => typeof f === 'string')) {
    fatal.push('requiredFields 必须是字符串数组');
  } else {
    const unknown = requiredFields.filter((f) => !KNOWN_REQUIRED_FIELDS.has(f));
    if (unknown.length > 0) {
      fatal.push(`标注包来自更新版本，包含当前软件无法处理的必填字段：${unknown.join(', ')}`);
    }
  }

  const pkg = migratePackage(raw, sourceVersion);
  const warnings =
    sourceVersion < ANNOTATION_PACKAGE_VERSION
      ? [`已将旧版标注包 v${sourceVersion} 迁移为 v${ANNOTATION_PACKAGE_VERSION}；未知可选项已忽略。`]
      : [];
  const validation = validatePackage(pkg, {
    sourceVersion,
    requirePackageDigest: sourceVersion >= ANNOTATION_PACKAGE_VERSION,
  });
  return {
    package: pkg,
    errors: [...fatal, ...validation.errors],
    itemIssues: validation.itemIssues,
    warnings,
    sourceFormatVersion: sourceVersion,
  };
}

function migratePackage(raw: Record<string, unknown>, _version: number): AnnotationPackage {
  const v = isRecord(raw.volume) ? raw.volume : {};
  const d = isRecord(raw.display) ? raw.display : {};
  const annotations = isRecord(raw.annotations) ? raw.annotations : {};
  const dims = migrateVec(v.dims ?? v.dimensions ?? v.size);
  const dtype = numberOr(v.dtype ?? v.dataType, 0) as DType;
  const voxelCount = dims.reduce((product, d) => product * d, 1);
  const dtypeBytes = DTYPE_INFO[dtype as DType]?.bytes ?? 1;
  const range = isRecord(v.valueRange)
    ? v.valueRange
    : { min: v.min ?? 0, max: v.max ?? 0 };
  const measurements = Array.isArray(raw.measurements)
    ? raw.measurements
    : Array.isArray(annotations.measurements)
      ? annotations.measurements
      : [];
  const rois = Array.isArray(raw.rois)
    ? raw.rois
    : Array.isArray(annotations.rois)
      ? annotations.rois
      : [];
  const windowLevel =
    (isRecord(d.windowLevel) && d.windowLevel) ||
    (isRecord(d.window) && d.window) ||
    (isRecord(raw.windowLevel) && raw.windowLevel) ||
    (isRecord(raw.window) && raw.window) || { window: 1, level: 0 };

  return {
    format: ANNOTATION_PACKAGE_FORMAT,
    formatVersion: ANNOTATION_PACKAGE_VERSION,
    exportedAt: numberOr(raw.exportedAt, Date.now()),
    ...(typeof raw.packageDigestSHA256 === 'string'
      ? { packageDigestSHA256: raw.packageDigestSHA256 }
      : {}),
    volume: {
      name: typeof v.name === 'string' ? v.name : undefined,
      dtype,
      dims,
      spacing: migrateVec(v.spacing),
      origin: migrateVec(v.origin),
      voxelCount: numberOr(v.voxelCount, voxelCount),
      bodyByteLength: numberOr(v.bodyByteLength ?? v.byteLength, voxelCount * dtypeBytes),
      valueRange: { min: numberOr(range.min, 0), max: numberOr(range.max, 0) },
      bodyDigestSHA256: String(v.bodyDigestSHA256 ?? v.digestSHA256 ?? v.checksum ?? ''),
      coordinateSystem: isRecord(v.coordinateSystem)
        ? (v.coordinateSystem as unknown as CoordinateSystemInfo)
        : COORDINATE_SYSTEM,
    },
    display: {
      crosshair: migrateVec(d.crosshair ?? raw.crosshair),
      windowLevel: {
        window: numberOr((windowLevel as Record<string, unknown>).window, 1),
        level: numberOr((windowLevel as Record<string, unknown>).level, 0),
      },
      threshold: numberOr(d.threshold ?? raw.threshold, 0),
    },
    measurements: measurements.map((m) => (isRecord(m) ? (m as unknown as Measurement) : ({} as Measurement))),
    rois: rois.map((r) => (isRecord(r) ? (r as unknown as Roi) : ({} as Roi))),
  };
}

function emptyPackage(): AnnotationPackage {
  return {
    format: ANNOTATION_PACKAGE_FORMAT,
    formatVersion: ANNOTATION_PACKAGE_VERSION,
    exportedAt: Date.now(),
    volume: {
      dtype: 0,
      dims: [0, 0, 0],
      spacing: [1, 1, 1],
      origin: [0, 0, 0],
      voxelCount: 0,
      bodyByteLength: 0,
      valueRange: { min: 0, max: 0 },
      bodyDigestSHA256: '',
      coordinateSystem: COORDINATE_SYSTEM,
    },
    display: { crosshair: [0, 0, 0], windowLevel: { window: 1, level: 0 }, threshold: 0 },
    measurements: [],
    rois: [],
  };
}

interface ValidationResult {
  errors: string[];
  itemIssues: Map<string, string>;
}

interface ValidationOptions {
  sourceVersion: number;
  requirePackageDigest: boolean;
}

function validatePackage(pkg: AnnotationPackage, options: ValidationOptions): ValidationResult {
  const errors: string[] = [];
  const itemIssues = new Map<string, string>();
  const addItem = (key: string, message: string) => {
    const previous = itemIssues.get(key);
    itemIssues.set(key, previous ? `${previous}；${message}` : message);
  };
  const add = (path: string, message: string) => errors.push(`${path}: ${message}`);

  if (
    options.requirePackageDigest &&
    (typeof pkg.packageDigestSHA256 !== 'string' ||
      !/^[0-9a-fA-F]{64}$/.test(pkg.packageDigestSHA256))
  ) {
    add('packageDigestSHA256', 'v1 标注包必须提供 SHA-256 摘要');
  }
  if (!Number.isFinite(pkg.exportedAt) || pkg.exportedAt < 0) add('exportedAt', '必须是非负数');
  validateVolume(pkg.volume, add, options.sourceVersion >= ANNOTATION_PACKAGE_VERSION);

  const { dims } = pkg.volume;
  if (vecInvalid(pkg.display.crosshair, { integer: true })) {
    add('display.crosshair', '必须是 3 个有限整数');
  } else if (dims.every((d) => Number.isSafeInteger(d) && d > 0) && outOfBounds(pkg.display.crosshair, dims)) {
    add('display.crosshair', '超出体数据边界');
  }
  const { window, level } = pkg.display.windowLevel;
  if (!Number.isFinite(window) || window <= 0) add('display.windowLevel.window', '必须是正数');
  if (!Number.isFinite(level)) add('display.windowLevel.level', '必须是有限数值');
  if (!Number.isFinite(pkg.display.threshold)) add('display.threshold', '必须是有限数值');

  const measurementIds = new Set<string>();
  pkg.measurements.forEach((m, i) => {
    const key = `measurement:${i}`;
    if (!isRecord(m)) return addItem(key, '不是对象');
    if (typeof m.id !== 'string' || m.id.length === 0) addItem(key, 'id 必须是非空字符串');
    else if (measurementIds.has(m.id)) addItem(key, `id 重复：${m.id}`);
    measurementIds.add(m.id);
    if (m.label !== undefined && typeof m.label !== 'string') addItem(key, 'label 必须是字符串');
    if (!Number.isFinite(m.createdAt) || m.createdAt < 0) addItem(key, 'createdAt 必须是非负数');
    const pointIssue = validatePoint(m.p1, dims, 'p1') ?? validatePoint(m.p2, dims, 'p2');
    if (pointIssue) addItem(key, pointIssue);
  });

  const roiIds = new Set<string>();
  pkg.rois.forEach((r, i) => {
    const key = `roi:${i}`;
    if (!isRecord(r)) return addItem(key, '不是对象');
    if (typeof r.id !== 'string' || r.id.length === 0) addItem(key, 'id 必须是非空字符串');
    else if (roiIds.has(r.id)) addItem(key, `id 重复：${r.id}`);
    roiIds.add(r.id);
    if (r.label !== undefined && typeof r.label !== 'string') addItem(key, 'label 必须是字符串');
    if (!Number.isFinite(r.createdAt) || r.createdAt < 0) addItem(key, 'createdAt 必须是非负数');
    if (![0, 1, 2].includes(r.axis)) {
      addItem(key, 'axis 必须是 0、1 或 2');
      return;
    }
    const axis = r.axis as PlaneAxis;
    if (!safeInt(r.slice) || r.slice < 0 || r.slice >= dims[axis]) {
      addItem(key, `slice 必须在 [0, ${dims[axis] - 1}] 内`);
    }
    const inPlane = [0, 1, 2].filter((a) => a !== axis) as [number, number];
    for (const [name, value, axisIndex] of [
      ['min', r.min, inPlane],
      ['max', r.max, inPlane],
    ] as const) {
      if (!Array.isArray(value) || value.length !== 2) {
        addItem(key, `${name} 必须是两个体素索引`);
      } else {
        value.forEach((n, ci) => {
          const a = axisIndex[ci];
          if (!safeInt(n) || n < 0 || n >= dims[a]) {
            addItem(key, `${name}[${ci}] 必须在 [0, ${dims[a] - 1}] 内`);
          }
        });
      }
    }
    if (
      Array.isArray(r.min) &&
      Array.isArray(r.max) &&
      r.min.length === 2 &&
      r.max.length === 2 &&
      r.min.every(safeInt) &&
      r.max.every(safeInt) &&
      (r.min[0] > r.max[0] || r.min[1] > r.max[1])
    ) {
      addItem(key, 'min 不能大于 max');
    }
  });

  itemIssues.forEach((issue) => errors.push(issue));
  return { errors, itemIssues };
}

function validateVolume(v: VolumeIdentitySummary, add: (path: string, msg: string) => void, requireDigest: boolean) {
  if (!DTYPE_INFO[v.dtype]) add('volume.dtype', `未知数值类型 ${String(v.dtype)}`);
  if (!Array.isArray(v.dims) || v.dims.length !== 3 || !v.dims.every((d) => safeInt(d) && d > 0)) {
    add('volume.dims', '必须是 3 个正整数');
  } else if (v.dims.reduce((a, b) => a * b, 1) > MAX_VOXELS) {
    add('volume.voxelCount', '超出支持的体素总数');
  }
  if (!isFiniteVec(v.spacing) || v.spacing.some((s) => s <= 0)) add('volume.spacing', '必须是 3 个正数');
  if (!isFiniteVec(v.origin)) add('volume.origin', '必须是 3 个有限数值');
  const product = Array.isArray(v.dims) ? v.dims.reduce((p, d) => p * d, 1) : 0;
  if (v.voxelCount !== product) add('volume.voxelCount', '与 dims 乘积不一致');
  const expectedBytes = DTYPE_INFO[v.dtype] ? product * DTYPE_INFO[v.dtype].bytes : 0;
  if (v.bodyByteLength !== expectedBytes) add('volume.bodyByteLength', '与维度和数值类型不一致');
  if (
    !Number.isFinite(v.valueRange.min) ||
    !Number.isFinite(v.valueRange.max) ||
    v.valueRange.min > v.valueRange.max
  ) {
    add('volume.valueRange', '最小值/最大值非法');
  }
  if (requireDigest && !/^[0-9a-fA-F]{64}$/.test(v.bodyDigestSHA256)) {
    add('volume.bodyDigestSHA256', '必须是 SHA-256 十六进制摘要');
  }
  const cs = v.coordinateSystem;
  if (!cs || cs.id !== COORDINATE_SYSTEM.id) add('volume.coordinateSystem.id', '坐标系不受支持');
  if (!cs || !Array.isArray(cs.direction) || cs.direction.length !== 9) {
    add('volume.coordinateSystem.direction', '必须是 3×3 方向矩阵');
  } else if (!cs.direction.every((x, i) => x === COORDINATE_SYSTEM.direction[i])) {
    add('volume.coordinateSystem.direction', '仅支持单位方向矩阵');
  }
}

export function compareVolumeIdentity(
  current: VolumeIdentitySummary,
  incoming: VolumeIdentitySummary,
  allowMissingDigest = false,
): { match: boolean; mismatches: string[]; warnings: string[] } {
  const mismatches: string[] = [];
  const warnings: string[] = [];
  const compareVec = (field: string, a: Vec3, b: Vec3) => {
    if (a.some((v, i) => v !== b[i])) mismatches.push(`${field} 不一致`);
  };
  if (current.dtype !== incoming.dtype) mismatches.push('数值类型不一致');
  compareVec('维度', current.dims, incoming.dims);
  compareVec('体素间距', current.spacing, incoming.spacing);
  compareVec('物理原点', current.origin, incoming.origin);
  if (current.voxelCount !== incoming.voxelCount) mismatches.push('体素总数不一致');
  if (!allowMissingDigest && current.bodyByteLength !== incoming.bodyByteLength) {
    mismatches.push('体数据字节数不一致');
  }
  if (
    !allowMissingDigest &&
    (current.valueRange.min !== incoming.valueRange.min ||
      current.valueRange.max !== incoming.valueRange.max)
  ) {
    mismatches.push('体素值域摘要不一致');
  }
  if (!incoming.bodyDigestSHA256) {
    if (allowMissingDigest) warnings.push('旧版标注包未包含体数据摘要，只能校验尺寸、间距、原点和坐标系。');
    else mismatches.push('缺少体数据 SHA-256 摘要');
  } else if (current.bodyDigestSHA256.toLowerCase() !== incoming.bodyDigestSHA256.toLowerCase()) {
    mismatches.push('体数据 SHA-256 摘要不一致（尺寸相同但内容不同也会被阻止）');
  }
  if (current.coordinateSystem.id !== incoming.coordinateSystem.id) {
    mismatches.push('坐标系标识不一致');
  }
  return { match: mismatches.length === 0, mismatches, warnings };
}

interface BuildPreviewInput {
  parsed: ParseResult;
  currentIdentity: VolumeIdentitySummary;
  current: { measurements: Measurement[]; rois: Roi[] };
}

export function buildAnnotationPreview(input: BuildPreviewInput): AnnotationPreview {
  const { parsed, currentIdentity, current } = input;
  const hasFatalError = parsed.errors.some(
    (e) =>
      e === '标注包必须是 JSON 对象' ||
      e.includes('无法识别的标注包格式') ||
      e.includes('formatVersion') ||
      e.includes('必填字段') ||
      e.startsWith('volume.dims:') ||
      e.startsWith('volume.dtype:') ||
      e.startsWith('volume.coordinateSystem'),
  );
  const pkg = hasFatalError ? null : parsed.package;
  const identityCheck = pkg
    ? compareVolumeIdentity(currentIdentity, pkg.volume, parsed.sourceFormatVersion < ANNOTATION_PACKAGE_VERSION)
    : { match: false, mismatches: [], warnings: [] };
  const items: PreviewItem[] = [];
  const counts: Record<PreviewStatus, number> = { new: 0, duplicate: 0, conflict: 0, invalid: 0 };
  const suggestions: Record<string, string> = {};
  const usedLabels = new Set(
    [...current.measurements, ...current.rois].map((a) => a.label).filter((l): l is string => !!l),
  );

  const addItem = (kind: AnnotationKind, index: number, annotation: { id?: string; label?: string }) => {
    const issue = parsed.itemIssues.get(`${kind}:${index}`);
    const id = typeof annotation.id === 'string' ? annotation.id : '(非法 id)';
    const key = `${kind}:${index}:${id}`;
    if (issue) {
      items.push({ key, kind, index, id, label: annotation.label, status: 'invalid', issue, resolutionRequired: { merge: false, replace: false } });
      counts.invalid++;
      return;
    }
    const status = classifyItem(kind, index, annotation, current, pkg!);
    const existingConflict = (kind === 'measurement' ? current.measurements : current.rois).some(
      (a) => a.id === annotation.id,
    );
    const internalConflict = status === 'conflict' && !existingConflict;
    const item: PreviewItem = {
      key,
      kind,
      index,
      id,
      label: annotation.label,
      status,
      resolutionRequired: {
        merge: status === 'conflict',
        replace: status === 'conflict' && internalConflict,
      },
    };
    if (status === 'conflict') {
      const base = annotation.label || `${kind === 'measurement' ? '测量' : 'ROI'} 导入副本`;
      suggestions[key] = uniqueLabel(base, usedLabels);
    }
    items.push(item);
    counts[status]++;
  };

  if (pkg) {
    pkg.measurements.forEach((m, i) => addItem('measurement', i, m));
    pkg.rois.forEach((r, i) => addItem('roi', i, r));
  }

  const errors = [...parsed.errors, ...identityCheck.mismatches];
  return {
    package: pkg,
    sourceFormatVersion: Number.isFinite(parsed.sourceFormatVersion) ? parsed.sourceFormatVersion : null,
    identity: { current: currentIdentity, incoming: pkg?.volume ?? null, match: identityCheck.match, mismatches: identityCheck.mismatches },
    errors,
    warnings: [...parsed.warnings, ...identityCheck.warnings],
    items,
    counts,
    existingCounts: { measurement: current.measurements.length, roi: current.rois.length },
    resolutionSuggestions: suggestions,
    canConfirm: errors.length === 0,
  };
}

function classifyItem(
  kind: AnnotationKind,
  index: number,
  annotation: { id?: string },
  current: { measurements: Measurement[]; rois: Roi[] },
  pkg: AnnotationPackage,
): PreviewStatus {
  const currentList = kind === 'measurement' ? current.measurements : current.rois;
  const sameIdCurrent = (currentList as Array<Measurement | Roi>).find((a) => a.id === annotation.id);
  if (sameIdCurrent) {
    return annotationContentEqual(kind, annotation, sameIdCurrent) ? 'duplicate' : 'conflict';
  }

  const incomingList = kind === 'measurement' ? pkg.measurements : pkg.rois;
  for (let previousIndex = 0; previousIndex < index; previousIndex++) {
    const previous = incomingList[previousIndex];
    if (previous.id !== annotation.id) continue;
    return annotationContentEqual(kind, annotation, previous) ? 'duplicate' : 'conflict';
  }

  return 'new';
}

function uniqueLabel(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base} ${i}`)) i++;
  const label = `${base} ${i}`;
  used.add(label);
  return label;
}

export function planAnnotationImport(
  pkg: AnnotationPackage,
  current: { measurements: Measurement[]; rois: Roi[] },
  mode: ImportMode,
  resolutions: ResolutionMap,
  createId: () => string = () => crypto.randomUUID(),
): { plan: PlannedImport | null; errors: string[] } {
  const errors: string[] = [];
  const base = mode === 'replace' ? { measurements: [], rois: [] } : structuredClone(current);
  const stats: ImportStats = {
    added: 0,
    duplicatesSkipped: 0,
    conflictsRenamed: 0,
    replacedExisting:
      mode === 'replace' ? current.measurements.length + current.rois.length : 0,
  };
  const usedRenamed =
    mode === 'merge'
      ? new Set(
          [...current.measurements, ...current.rois]
            .map((a) => a.label?.trim())
            .filter((label): label is string => !!label),
        )
      : new Set<string>();
  const seenIncomingIds = new Set<string>();

  const process = <T extends Measurement | Roi>(
    kind: AnnotationKind,
    incoming: T[],
    target: T[],
    clone: (id: string, label: string, source: T) => T,
  ) => {
    incoming.forEach((item, index) => {
      const key = `${kind}:${index}:${item.id}`;
      const currentIds =
        kind === 'measurement' ? new Set(current.measurements.map((a) => a.id)) : new Set(current.rois.map((a) => a.id));
      const existingSameId = mode === 'merge' && currentIds.has(item.id);
      const duplicateInPackage = seenIncomingIds.has(`${kind}:${item.id}`);
      const sameIdTarget = target.find((a) => a.id === item.id);
      const exactSameId = !!sameIdTarget && annotationContentEqual(kind, item, sameIdTarget);

      if ((existingSameId || duplicateInPackage) && exactSameId) {
        stats.duplicatesSkipped++;
        return;
      }
      if (existingSameId || duplicateInPackage) {
        const label = resolutions[key]?.trim();
        if (!label) errors.push(`${labelName(kind, item.id)}：冲突项必须填写新名称`);
        else if (usedRenamed.has(label)) errors.push(`重命名“${label}”重复`);
        else {
          usedRenamed.add(label);
          target.push(clone(createId(), label, item));
          stats.conflictsRenamed++;
          stats.added++;
        }
        return;
      }
      seenIncomingIds.add(`${kind}:${item.id}`);
      target.push(structuredClone(item));
      stats.added++;
    });
  };

  process('measurement', pkg.measurements, base.measurements, (id, label, source) => ({
    id,
    label,
    p1: structuredClone(source.p1),
    p2: structuredClone(source.p2),
    createdAt: source.createdAt,
  }));
  process('roi', pkg.rois, base.rois, (id, label, source) => ({
    id,
    label,
    axis: source.axis,
    slice: source.slice,
    min: structuredClone(source.min),
    max: structuredClone(source.max),
    createdAt: source.createdAt,
  }));

  return {
    plan: errors.length ? null : { ...base, display: structuredClone(pkg.display), stats },
    errors,
  };
}

export function validatePlannedImport(plan: PlannedImport, dims: Vec3): string[] {
  const errors: string[] = [];
  if (plan.display.crosshair.some((v, i) => !safeInt(v) || v < 0 || v >= dims[i])) {
    errors.push('十字丝坐标越界');
  }
  plan.measurements.forEach((m, i) => {
    for (const [name, p] of [['p1', m.p1], ['p2', m.p2]] as const) {
      if (p.some((v, axis) => !safeInt(v) || v < 0 || v >= dims[axis])) {
        errors.push(`测量 #${i + 1} 的 ${name} 越界`);
      }
    }
  });
  plan.rois.forEach((r, i) => {
    if (!safeInt(r.slice) || r.slice < 0 || r.slice >= dims[r.axis]) {
      errors.push(`ROI #${i + 1} 的 slice 越界`);
    }
    const axes = [0, 1, 2].filter((a) => a !== r.axis);
    for (const [name, point] of [['min', r.min], ['max', r.max]] as const) {
      point.forEach((v, ci) => {
        if (!safeInt(v) || v < 0 || v >= dims[axes[ci]]) {
          errors.push(`ROI #${i + 1} 的 ${name}[${ci}] 越界`);
        }
      });
    }
  });
  return errors;
}

function labelName(kind: AnnotationKind, id: string): string {
  return `${kind === 'measurement' ? '测量' : 'ROI'} ${id}`;
}

export function annotationContentEqual(kind: AnnotationKind, a: unknown, b: unknown): boolean {
  if (!isRecord(a) || !isRecord(b)) return false;
  if (kind === 'measurement') {
    return stableStringify({ p1: a.p1, p2: a.p2 }) === stableStringify({ p1: b.p1, p2: b.p2 });
  }
  return stableStringify({ axis: a.axis, slice: a.slice, min: a.min, max: a.max }) ===
    stableStringify({ axis: b.axis, slice: b.slice, min: b.min, max: b.max });
}

function validatePoint(point: unknown, dims: Vec3, name: string): string | null {
  if (vecInvalid(point, { integer: true })) return `${name} 必须是 3 个有限整数`;
  const p = point as Vec3;
  if (dims.every((d) => safeInt(d) && d > 0) && outOfBounds(p, dims)) return `${name} 超出体数据边界`;
  return null;
}

function isFiniteVec(value: unknown): value is Vec3 {
  return !vecInvalid(value);
}

function vecInvalid(value: unknown, options: { integer?: boolean } = {}): value is Vec3 {
  if (!Array.isArray(value) || value.length !== 3) return true;
  return value.some((n) => !Number.isFinite(n) || (options.integer && !safeInt(n)));
}

function outOfBounds(p: Vec3, dims: Vec3): boolean {
  return p.some((v, i) => v < 0 || v >= dims[i]);
}

function safeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function migrateVec(value: unknown): Vec3 {
  return Array.isArray(value) && value.length >= 3
    ? [numberOr(value[0], 0), numberOr(value[1], 0), numberOr(value[2], 0)]
    : [0, 0, 0];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
