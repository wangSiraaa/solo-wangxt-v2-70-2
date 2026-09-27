import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DType, decodeCorevol, encodeCorevol, type DecodedVolume, type Vec3 } from './corevol';
import {
  ANNOTATION_PACK_FORMAT,
  AnnotationPackError,
  buildCommittedAnnotationRecord,
  createAnnotationPack,
  previewAnnotationPack,
} from './annotationPack';
import type { Measurement, Roi } from '../geometry/roi';
import {
  __resetProjectDbForTests,
  commitAnnotationImport,
  getAnnotations,
  saveAnnotations,
  type AnnotationRecord,
} from '../db/projectDb';

const dims: Vec3 = [4, 5, 6];
const spacing: Vec3 = [0.5, 0.5, 2];
const origin: Vec3 = [10, 20, 30];

function makeVolume(data: number[]): DecodedVolume {
  const array = new Uint8Array(data);
  const buffer = encodeCorevol(
    { dtype: DType.UInt8, dims, spacing, origin, name: '测试岩芯' },
    array,
  );
  return decodeCorevol(buffer);
}

const volumeA = makeVolume(Array.from({ length: 120 }, (_, i) => i % 251));
const volumeB = makeVolume(Array.from({ length: 120 }, (_, i) => (i + 7) % 251));

const measurement: Measurement = {
  id: 'm1',
  p1: [0, 0, 0],
  p2: [3, 4, 5],
  createdAt: 1000,
};
const roi: Roi = {
  id: 'r1',
  axis: 2,
  slice: 3,
  min: [1, 1],
  max: [2, 3],
  createdAt: 2000,
};
const crosshair: Vec3 = [2, 3, 4];
const displaySettings = { windowLevel: { window: 120, level: 80 }, threshold: 150 };

async function packText(overrides: Parameters<typeof createAnnotationPack>[0] = {
  volume: volumeA,
  measurements: [measurement],
  rois: [roi],
  crosshair,
  displaySettings,
}) {
  const pack = await createAnnotationPack(overrides);
  return JSON.stringify(pack);
}

async function rawPackText(mutate: (pack: Awaited<ReturnType<typeof createAnnotationPack>>) => void) {
  const pack = await createAnnotationPack({
    volume: volumeA,
    measurements: [measurement],
    rois: [roi],
    crosshair,
    displaySettings,
  });
  mutate(pack);
  return JSON.stringify(pack);
}

async function commit(
  text: string,
  options: {
    projectId?: string;
    mode?: 'merge' | 'replace';
    volume?: DecodedVolume;
    measurements?: Measurement[];
    rois?: Roi[];
    resolutions?: Record<string, string>;
    acceptLegacy?: boolean;
    history?: AnnotationRecord['importHistory'];
  } = {},
) {
  const preview = await previewAnnotationPack({
    text,
    mode: options.mode ?? 'merge',
    volume: options.volume ?? volumeA,
    measurements: options.measurements ?? [],
    rois: options.rois ?? [],
  });
  return buildCommittedAnnotationRecord({
    projectId: options.projectId ?? 'project',
    preview,
    mode: options.mode ?? 'merge',
    resolutions: { ...preview.resolutions, ...options.resolutions },
    acceptLegacy: options.acceptLegacy ?? false,
    existing: {
      measurements: options.measurements ?? [],
      rois: options.rois ?? [],
      importHistory: options.history ?? [],
    },
    fallbackDisplaySettings: displaySettings,
    source: { fileName: 'annotations.json', fileSize: text.length },
    now: '2026-09-27T00:00:00.000Z',
  });
}

describe('标注包导出与身份校验', () => {
  beforeEach(() => {
    __resetProjectDbForTests();
  });

  it('导回原体数据时无损恢复全部标注、显示设置、尺寸、间距和坐标系', async () => {
    const text = await packText();
    const pack = JSON.parse(text);
    expect(pack.format).toBe(ANNOTATION_PACK_FORMAT);
    expect(pack.formatVersion).toBe(1);
    expect(pack.volumeIdentity.dimensions).toEqual(dims);
    expect(pack.volumeIdentity.spacing).toEqual(spacing);
    expect(pack.volumeIdentity.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.coordinateSystem).toMatchObject({
      kind: 'axis-aligned-ijk',
      indexBase: 0,
      fastestVaryingAxis: 'I',
      axisOrder: ['I', 'J', 'K'],
      origin,
    });

    const preview = await previewAnnotationPack({
      text,
      mode: 'merge',
      volume: volumeA,
      measurements: [],
      rois: [],
    });
    expect(preview.identityStatus).toBe('exact');
    expect(preview.counts).toMatchObject({ new: 2, duplicate: 0, conflict: 0, 'out-of-bounds': 0 });

    const result = await commit(text, { projectId: 'roundtrip' });
    expect(result.record.measurements).toEqual([measurement]);
    expect(result.record.rois).toEqual([roi]);
    expect(result.record.crosshair).toEqual(crosshair);
    expect(result.record.displaySettings).toEqual(displaySettings);
    expect(result.summary.volumeDigest).toBe(pack.volumeIdentity.digest);
  });

  it('尺寸相同但体素内容不同：SHA-256 摘要不匹配并阻止确认', async () => {
    const text = await packText();
    const preview = await previewAnnotationPack({
      text,
      mode: 'merge',
      volume: volumeB,
      measurements: [],
      rois: [],
    });
    expect(volumeB.header.dims).toEqual(volumeA.header.dims);
    expect(preview.identityStatus).toBe('mismatch');
    expect(preview.canCommit).toBe(false);
    expect(preview.problems[0]?.message).toMatch(/摘要.*不匹配/);

    await expect(
      commit(text, { volume: volumeB, projectId: 'wrong-volume' }),
    ).rejects.toThrow(/摘要/);
  });

  it('重复导入相同唯一键和内容时幂等跳过，不生成副本', async () => {
    const text = await packText();
    const first = await commit(text, { projectId: 'duplicate' });
    const second = await commit(text, {
      projectId: 'duplicate',
      measurements: first.record.measurements,
      rois: first.record.rois,
      history: first.record.importHistory,
    });
    expect(second.record.measurements).toHaveLength(1);
    expect(second.record.rois).toHaveLength(1);
    expect(second.summary.skippedDuplicates).toBe(2);
    expect(second.summary.added).toBe(0);
    expect(second.record.importHistory).toHaveLength(2);
  });

  it('相同唯一键但内容不同：合并时保留双方并要求重命名', async () => {
    const changedMeasurement: Measurement = { ...measurement, p2: [1, 1, 1] };
    const changedRoi: Roi = { ...roi, max: [3, 4] };
    const text = await packText({
      volume: volumeA,
      measurements: [changedMeasurement],
      rois: [changedRoi],
      crosshair,
      displaySettings,
    });
    const preview = await previewAnnotationPack({
      text,
      mode: 'merge',
      volume: volumeA,
      measurements: [measurement],
      rois: [roi],
    });
    expect(preview.counts.conflict).toBe(2);
    expect(preview.resolutions['measurement:m1#0']).toBeTruthy();
    expect(preview.resolutions['roi:r1#0']).toBeTruthy();

    const result = await commit(text, {
      mode: 'merge',
      measurements: [measurement],
      rois: [roi],
    });
    expect(result.record.measurements.map((m) => m.id).sort()).toEqual(['m1', 'm1-renamed-2']);
    expect(result.record.rois.map((r) => r.id).sort()).toEqual(['r1', 'r1-renamed-2']);
    expect(result.summary.renamedConflicts).toBe(2);
  });

  it('任何越界坐标都进入预览问题列表且不会静默写入；确认抛错', async () => {
    const text = await rawPackText((pack) => {
      pack.annotations.measurements = [{ ...measurement, p2: [4, 0, 0] }];
      pack.annotations.rois = [{ ...roi, slice: 6 }];
      pack.annotations.crosshair = [0, 0, 99];
    });
    const preview = await previewAnnotationPack({
      text,
      mode: 'merge',
      volume: volumeA,
      measurements: [],
      rois: [],
    });
    expect(preview.canCommit).toBe(false);
    expect(preview.counts['out-of-bounds']).toBe(2);
    expect(preview.problems).toHaveLength(3);
    expect(preview.problems.map((p) => p.message).join(' ')).toMatch(/十字丝[\s\S]*测量[\s\S]*ROI/);

    await expect(commit(text, { projectId: 'invalid' })).rejects.toBeInstanceOf(AnnotationPackError);
  });

  it('标注包内部相同唯一键但内容不同也必须分别重命名，避免后一项覆盖前一项', async () => {
    const text = await rawPackText((pack) => {
      pack.annotations.measurements = [
        { ...measurement, p2: [1, 1, 1] },
        { ...measurement, p2: [2, 2, 2] },
      ];
      pack.annotations.rois = [];
    });
    const preview = await previewAnnotationPack({
      text,
      mode: 'merge',
      volume: volumeA,
      measurements: [measurement],
      rois: [],
    });
    expect(preview.items.filter((i) => i.status === 'conflict')).toHaveLength(2);
    expect(preview.resolutions['measurement:m1#0']).toBe('m1-renamed-2');
    expect(preview.resolutions['measurement:m1#1']).toBe('m1-renamed-3');

    const result = await commit(text, {
      mode: 'merge',
      measurements: [measurement],
      rois: [],
    });
    expect(result.record.measurements.map((m) => m.id)).toEqual(['m1', 'm1-renamed-2', 'm1-renamed-3']);
    expect(result.record.measurements.map((m) => m.p2.join(','))).toEqual([
      measurement.p2.join(','),
      '1,1,1',
      '2,2,2',
    ]);
  });

  it('旧版 v0 标注包在几何匹配时迁移，但必须显式接受缺失摘要', async () => {
    const legacy = JSON.stringify({
      formatVersion: 0,
      exportedAt: '2025-01-01T00:00:00.000Z',
      dimensions: dims,
      spacing,
      origin,
      dtype: 'uint8',
      crosshair,
      measurements: [measurement],
      rois: [roi],
    });
    const preview = await previewAnnotationPack({
      text: legacy,
      mode: 'merge',
      volume: volumeA,
      measurements: [],
      rois: [],
    });
    expect(preview.identityStatus).toBe('legacy-unverified');
    expect(preview.migratedFromVersion).toBe(0);
    expect(preview.acceptLegacyRequired).toBe(true);

    await expect(
      commit(legacy, { acceptLegacy: false, projectId: 'legacy' }),
    ).rejects.toThrow(/没有体素内容摘要/);
    const result = await commit(legacy, { acceptLegacy: true, projectId: 'legacy' });
    expect(result.summary.migratedFromVersion).toBe(0);
    expect(result.summary.acceptedLegacyWithoutDigest).toBe(true);
    expect(result.record.measurements).toEqual([measurement]);
  });

  it('旧版标注包几何不匹配时阻止迁移', () => {
    const legacy = JSON.stringify({
      formatVersion: 0,
      dimensions: [4, 5, 7],
      spacing,
      origin,
      crosshair,
      measurements: [],
      rois: [],
    });
    return expect(
      previewAnnotationPack({ text: legacy, mode: 'merge', volume: volumeA, measurements: [], rois: [] }),
    ).resolves.toMatchObject({ identityStatus: 'mismatch', canCommit: false });
  });

  it('未来版本带未知必填字段时明确拒绝并给出原因', async () => {
    const pack = JSON.parse(await packText());
    pack.formatVersion = 2;
    pack.requiredFields = ['annotations.aiLabels'];
    const text = JSON.stringify(pack);
    await expect(
      previewAnnotationPack({ text, mode: 'merge', volume: volumeA, measurements: [], rois: [] }),
    ).rejects.toThrow(/不支持的标注包版本 2[\s\S]*annotations\.aiLabels/);
  });

  it('替换模式会移除非包内现有标注；相同内容的同 ID 项仍计为重复且只保留一份', async () => {
    const untouchedMeasurement: Measurement = { id: 'remove-m', p1: [0, 0, 0], p2: [1, 1, 1], createdAt: 3 };
    const untouchedRoi: Roi = { id: 'remove-r', axis: 0, slice: 1, min: [0, 0], max: [1, 1], createdAt: 4 };
    const result = await commit(await packText(), {
      mode: 'replace',
      measurements: [measurement, untouchedMeasurement],
      rois: [roi, untouchedRoi],
    });
    expect(result.record.measurements.map((m) => m.id)).toEqual(['m1']);
    expect(result.record.rois.map((r) => r.id)).toEqual(['r1']);
    expect(result.summary.skippedDuplicates).toBe(2);
    expect(result.summary.added).toBe(0);
    expect(result.summary.replacedExistingMeasurements).toBe(2);
    expect(result.summary.replacedExistingRois).toBe(2);
  });

  it('确认导入只通过 IndexedDB 一次写入；非法确认时现有工程记录保持不变', async () => {
    const projectId = 'atomic-rollback';
    const existing = {
      projectId,
      measurements: [measurement],
      rois: [roi],
      crosshair: [0, 0, 0] as Vec3,
      updatedAt: 1,
    };
    await saveAnnotations(existing);

    const invalidText = await rawPackText((pack) => {
      pack.annotations.measurements = [
        { ...measurement, id: 'bad', p1: [-1, 0, 0], p2: [0, 0, 0] },
      ];
      pack.annotations.rois = [];
    });
    await expect(commit(invalidText, { projectId, mode: 'replace' })).rejects.toThrow();

    const afterFailed = await getAnnotations(projectId);
    expect(afterFailed?.measurements).toEqual([measurement]);
    expect(afterFailed?.rois).toEqual([roi]);

    const validText = await packText();
    const validPreview = await previewAnnotationPack({
      text: validText,
      mode: 'replace',
      volume: volumeA,
      measurements: [measurement],
      rois: [roi],
    });
    const committed = buildCommittedAnnotationRecord({
      projectId,
      preview: validPreview,
      mode: 'replace',
      resolutions: validPreview.resolutions,
      acceptLegacy: false,
      existing: { measurements: [measurement], rois: [roi], importHistory: [] },
      fallbackDisplaySettings: displaySettings,
      source: { fileName: 'valid.json', fileSize: validText.length },
    });
    await commitAnnotationImport(committed.record);
    const afterCommit = await getAnnotations(projectId);
    expect(afterCommit?.measurements).toEqual(committed.record.measurements);
    expect(afterCommit?.importHistory?.[0]?.fileName).toBe('valid.json');
  });
});
