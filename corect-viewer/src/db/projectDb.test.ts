import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Vec3 } from '../format/corevol';
import type { DisplaySettings, ImportSourceSummary, PlannedImport } from '../format/annotations';
import type { Measurement, Roi } from '../geometry/roi';
import {
  closeDatabase,
  commitAnnotationImport,
  getAnnotations,
  listImportEvents,
  saveAnnotations,
} from './projectDb';

const dims: Vec3 = [4, 4, 4];
const display: DisplaySettings = {
  crosshair: [1, 1, 1],
  windowLevel: { window: 100, level: 50 },
  threshold: 40,
};
const initialMeasurement: Measurement = { id: 'm-old', p1: [0, 0, 0], p2: [1, 1, 1], createdAt: 1 };
const initialRoi: Roi = { id: 'r-old', axis: 2, slice: 1, min: [0, 0], max: [1, 1], createdAt: 2 };
const incomingMeasurement: Measurement = { id: 'm-new', p1: [0, 0, 0], p2: [2, 2, 2], createdAt: 3 };

const source = (): ImportSourceSummary => ({
  fileName: 'import.json',
  fileSize: 12,
  fileDigestSHA256: 'a'.repeat(64),
  packageDigestSHA256: 'b'.repeat(64),
  sourceFormatVersion: 1,
  importedAt: Date.now(),
});

function plan(measurements: Measurement[], rois: Roi[] = [initialRoi]): PlannedImport {
  return {
    measurements,
    rois,
    display,
    stats: { added: measurements.length, duplicatesSkipped: 0, conflictsRenamed: 0, replacedExisting: 0 },
  };
}

beforeEach(async () => {
  await closeDatabase();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('corect-viewer');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('database delete blocked'));
  });
});

describe('标注导入 IndexedDB 事务', () => {
  it('确认成功时一次事务写入标注和导入来源摘要', async () => {
    await saveAnnotations({
      projectId: 'p1',
      measurements: [initialMeasurement],
      rois: [initialRoi],
      display,
      updatedAt: 1,
    });
    await commitAnnotationImport({
      projectId: 'p1',
      projectName: '工程',
      plan: plan([initialMeasurement, incomingMeasurement]),
      dims,
      source: source(),
      mode: 'merge',
    });

    const saved = await getAnnotations('p1');
    expect(saved?.measurements.map((m) => m.id)).toEqual(['m-old', 'm-new']);
    expect(saved?.lastImportSource?.fileName).toBe('import.json');
    expect(saved?.lastImportSource?.fileDigestSHA256).toBe('a'.repeat(64));
    const events = await listImportEvents('p1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ mode: 'merge', projectName: '工程' });
  });

  it('部分标注越界时整次确认回滚且现有工程不变', async () => {
    await saveAnnotations({
      projectId: 'p1',
      measurements: [initialMeasurement],
      rois: [initialRoi],
      display,
      updatedAt: 1,
    });
    const invalid: Measurement = { ...incomingMeasurement, p2: [99, 0, 0] };
    await expect(
      commitAnnotationImport({
        projectId: 'p1',
        projectName: '工程',
        plan: plan([initialMeasurement, invalid]),
        dims,
        source: source(),
        mode: 'merge',
      }),
    ).rejects.toThrow(/越界|回滚/);

    const saved = await getAnnotations('p1');
    expect(saved?.measurements).toEqual([initialMeasurement]);
    expect(saved?.rois).toEqual([initialRoi]);
    expect(saved?.lastImportSource).toBeNull();
    await expect(listImportEvents('p1')).resolves.toEqual([]);
  });
});
