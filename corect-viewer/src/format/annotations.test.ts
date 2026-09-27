import { describe, expect, it } from 'vitest';
import { DType, type DecodedVolume, type Vec3 } from './corevol';
import {
  ANNOTATION_PACKAGE_VERSION,
  buildAnnotationPreview,
  createAnnotationPackage,
  createVolumeIdentity,
  parseAnnotationPackage,
  planAnnotationImport,
  verifyPackageDigest,
} from './annotations';
import type { Measurement, Roi } from '../geometry/roi';

const dims: Vec3 = [4, 5, 6];
const spacing: Vec3 = [0.5, 0.6, 2];
const origin: Vec3 = [10, 20, 30];

function volume(data = new Uint8Array(dims.reduce((a, b) => a * b, 1))): DecodedVolume {
  data.forEach((_, i) => {
    data[i] = i % 251;
  });
  return {
    header: {
      version: 1,
      dtype: DType.UInt8,
      dims,
      spacing,
      origin,
      name: '测试岩芯',
      headerSize: 80,
    },
    data,
    voxelCount: data.length,
    min: 0,
    max: 250,
  };
}

const measurement: Measurement = {
  id: 'm1',
  label: '裂缝长度',
  p1: [0, 0, 0],
  p2: [1, 1, 1],
  createdAt: 1,
};
const roi: Roi = { id: 'r1', label: '孔洞', axis: 2, slice: 2, min: [0, 0], max: [2, 3], createdAt: 2 };
const display = {
  crosshair: [2, 3, 4] as Vec3,
  windowLevel: { window: 200, level: 120 },
  threshold: 90,
};

async function makePackage(v = volume()) {
  return createAnnotationPackage({
    volume: v,
    measurements: [measurement],
    rois: [roi],
    display,
    exportedAt: 123,
  });
}

async function previewOf(pkg: unknown, current = { measurements: [] as Measurement[], rois: [] as Roi[] }) {
  const parsed = parseAnnotationPackage(pkg);
  const digestError = await verifyPackageDigest(pkg);
  if (digestError) parsed.errors.push(digestError);
  return buildAnnotationPreview({
    parsed,
    currentIdentity: await createVolumeIdentity(volume()),
    current,
  });
}

describe('标注包导出导入', () => {
  it('导回原体数据可无损恢复全部标注和显示设置', async () => {
    const pkg = await makePackage();
    const preview = await previewOf(pkg);
    expect(preview.errors).toEqual([]);
    expect(preview.identity.match).toBe(true);
    expect(preview.counts).toEqual({ new: 2, duplicate: 0, conflict: 0, invalid: 0 });

    const { plan, errors } = planAnnotationImport(pkg, { measurements: [], rois: [] }, 'replace', {});
    expect(errors).toEqual([]);
    expect(plan).toMatchObject({
      measurements: [measurement],
      rois: [roi],
      display,
    });
    expect(plan!.stats).toMatchObject({ added: 2, replacedExisting: 0 });
  });

  it('尺寸相同但体数据内容不同会被摘要阻止', async () => {
    const pkg = await makePackage();
    const changed = volume();
    changed.data[10] = 201;
    const parsed = parseAnnotationPackage(pkg);
    const preview = buildAnnotationPreview({
      parsed,
      currentIdentity: await createVolumeIdentity(changed),
      current: { measurements: [], rois: [] },
    });
    expect(preview.canConfirm).toBe(false);
    expect(preview.errors.some((e) => e.includes('SHA-256'))).toBe(true);
  });

  it('相同唯一键和内容重复导入时幂等跳过，不生成副本', async () => {
    const pkg = await makePackage();
    const current = { measurements: [measurement], rois: [roi] };
    const preview = await previewOf(pkg, current);
    expect(preview.counts.duplicate).toBe(2);

    const { plan } = planAnnotationImport(pkg, current, 'merge', {});
    expect(plan!.measurements).toHaveLength(1);
    expect(plan!.rois).toHaveLength(1);
    expect(plan!.stats.duplicatesSkipped).toBe(2);
  });

  it('唯一键相同但内容不同会保留双方并要求重命名', async () => {
    const pkg = await makePackage();
    const conflictingMeasurement: Measurement = { ...measurement, p2: [2, 2, 2] };
    const conflictingRoi: Roi = { ...roi, max: [3, 4] };
    const preview = await previewOf(pkg, {
      measurements: [conflictingMeasurement],
      rois: [conflictingRoi],
    });
    expect(preview.counts.conflict).toBe(2);

    const failed = planAnnotationImport(pkg, {
      measurements: [conflictingMeasurement],
      rois: [conflictingRoi],
    }, 'merge', {});
    expect(failed.plan).toBeNull();
    expect(failed.errors.join('；')).toContain('必须填写新名称');

    const resolutions = Object.fromEntries(
      preview.items
        .filter((i) => i.status === 'conflict')
        .map((i) => [i.key, `导入 ${i.kind}`]),
    );
    const { plan } = planAnnotationImport(
      pkg,
      { measurements: [conflictingMeasurement], rois: [conflictingRoi] },
      'merge',
      resolutions,
      () => 'new-id',
    );
    expect(plan!.measurements).toHaveLength(2);
    expect(plan!.rois).toHaveLength(2);
    expect(plan!.measurements.find((m) => m.id === 'new-id')?.label).toBe('导入 measurement');
    expect(plan!.rois.find((r) => r.id === 'new-id')?.label).toBe('导入 roi');
    expect(plan!.stats.conflictsRenamed).toBe(2);
  });

  it('部分标注越界时预览为非法且不能确认', async () => {
    const pkg = await makePackage();
    pkg.measurements[0] = { ...measurement, p2: [10, 0, 0] };
    pkg.rois[0] = { ...roi, slice: 99 };
    const preview = await previewOf(pkg);
    expect(preview.counts.invalid).toBe(2);
    expect(preview.canConfirm).toBe(false);
    expect(preview.errors.join('；')).toMatch(/超出|越界/);
  });

  it('旧版标注包可迁移，但缺少摘要时给出降级警告', async () => {
    const legacy = {
      formatVersion: 0,
      exportedAt: 456,
      volume: {
        dtype: DType.UInt8,
        dims,
        spacing,
        origin,
      },
      crosshair: [1, 2, 3],
      window: { window: 300, level: 100 },
      threshold: 50,
      measurements: [{ id: 'old-m', p1: [0, 0, 0], p2: [1, 1, 1], createdAt: 3 }],
      rois: [{ id: 'old-r', axis: 1, slice: 2, min: [0, 0], max: [3, 4], createdAt: 4 }],
    };
    const preview = await previewOf(legacy);
    expect(preview.canConfirm).toBe(true);
    expect(preview.warnings.join('；')).toContain('旧版标注包 v0 迁移');
    expect(preview.warnings.join('；')).toContain('未包含体数据摘要');
    expect(preview.package!.display.windowLevel).toEqual({ window: 300, level: 100 });
  });

  it('新版本未知必填字段被明确拒绝并给出字段名', async () => {
    const pkg = await makePackage();
    const future = {
      ...pkg,
      formatVersion: 9,
      requiredFields: ['multiframeTensors', 'quantumCoordinates'],
    };
    const preview = await previewOf(future);
    expect(preview.canConfirm).toBe(false);
    expect(preview.errors.join('；')).toContain('multiframeTensors');
    expect(preview.errors.join('；')).toContain('quantumCoordinates');
  });

  it('篡改包内容会因包摘要不匹配而拒绝', async () => {
    const pkg = await makePackage();
    const text = JSON.stringify(pkg);
    const tampered = JSON.parse(text.replace('裂缝长度', '被篡改'));
    const preview = await previewOf(tampered);
    expect(preview.canConfirm).toBe(false);
    expect(preview.errors.join('；')).toContain('标注包摘要不匹配');
  });

  it('导出包包含格式版本、尺寸、间距、原点、坐标系和体数据摘要', async () => {
    const pkg = await makePackage();
    expect(pkg.formatVersion).toBe(ANNOTATION_PACKAGE_VERSION);
    expect(pkg.volume.dims).toEqual(dims);
    expect(pkg.volume.spacing).toEqual(spacing);
    expect(pkg.volume.origin).toEqual(origin);
    expect(pkg.volume.bodyDigestSHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(pkg.volume.coordinateSystem.id).toBe('corect-ijk-mm-v1');
    expect(pkg.volume.coordinateSystem.direction).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});
