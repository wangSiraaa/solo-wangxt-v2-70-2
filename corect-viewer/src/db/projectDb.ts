import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { Vec3 } from '../format/corevol';
import type {
  DisplaySettings,
  ImportMode,
  ImportSourceSummary,
  PlannedImport,
} from '../format/annotations';
import { validatePlannedImport } from '../format/annotations';
import type { Measurement, Roi } from '../geometry/roi';

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  /** 原始 .corevol 文件内容，刷新后重新解码恢复体数据 */
  fileBuffer: ArrayBuffer;
}

export interface AnnotationRecord {
  projectId: string;
  measurements: Measurement[];
  rois: Roi[];
  display: DisplaySettings;
  lastImportSource: ImportSourceSummary | null;
  updatedAt: number;
}

export interface ImportEventRecord extends ImportSourceSummary {
  id: string;
  projectId: string;
  projectName: string;
  mode: ImportMode;
  stats: PlannedImport['stats'];
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
}

interface CoreCtDB extends DBSchema {
  projects: { key: string; value: ProjectRecord };
  annotations: { key: string; value: AnnotationRecord };
  importEvents: { key: string; value: ImportEventRecord; indexes: { byProject: string } };
}

const DB_NAME = 'corect-viewer';
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<CoreCtDB>> | null = null;

function getDb(): Promise<IDBPDatabase<CoreCtDB>> {
  if (!dbPromise) {
    dbPromise = openDB<CoreCtDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('annotations')) {
          db.createObjectStore('annotations', { keyPath: 'projectId' });
        }
        if (oldVersion < 2 && !db.objectStoreNames.contains('importEvents')) {
          const store = db.createObjectStore('importEvents', { keyPath: 'id' });
          store.createIndex('byProject', 'projectId');
        }
      },
    });
  }
  return dbPromise;
}

export async function saveProject(record: ProjectRecord): Promise<void> {
  const db = await getDb();
  await db.put('projects', record);
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const db = await getDb();
  const all = await db.getAll('projects');
  return all
    .map(({ id, name, createdAt }) => ({ id, name, createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getProject(id: string): Promise<ProjectRecord | undefined> {
  const db = await getDb();
  return db.get('projects', id);
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['projects', 'annotations', 'importEvents'], 'readwrite');
  const eventKeys = await tx
    .objectStore('importEvents')
    .index('byProject')
    .getAllKeys(IDBKeyRange.only(id));
  await Promise.all([
    tx.objectStore('projects').delete(id),
    tx.objectStore('annotations').delete(id),
    ...eventKeys.map((eventId) => tx.objectStore('importEvents').delete(eventId)),
  ]);
  await tx.done;
}

export async function saveAnnotations(
  record: Omit<AnnotationRecord, 'lastImportSource'> & {
    lastImportSource?: ImportSourceSummary | null;
  },
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('annotations', 'readwrite');
  const existing = await tx.store.get(record.projectId);
  await tx.store.put({
    ...record,
    display: record.display,
    lastImportSource: record.lastImportSource ?? existing?.lastImportSource ?? null,
  });
  await tx.done;
}

export async function getAnnotations(projectId: string): Promise<AnnotationRecord | undefined> {
  const db = await getDb();
  return db.get('annotations', projectId);
}

export interface CommitImportInput {
  projectId: string;
  projectName: string;
  plan: PlannedImport;
  dims: Vec3;
  source: ImportSourceSummary;
  mode: ImportMode;
}

/**
 * 用单个 IndexedDB 读写事务写入标注和导入来源。
 * 确认前已完成身份校验、冲突重命名和重复分析；事务开始后再做最终边界校验。
 */
export async function commitAnnotationImport(input: CommitImportInput): Promise<ImportEventRecord> {
  const db = await getDb();
  const tx = db.transaction(['annotations', 'importEvents'], 'readwrite');
  const annotationStore = tx.objectStore('annotations');
  const eventStore = tx.objectStore('importEvents');
  const validationErrors = validatePlannedImport(input.plan, input.dims);
  if (validationErrors.length > 0) {
    const message = validationErrors.join('；');
    // idb 会在中止时 reject tx.done；显式消费该 rejection，然后返回具体校验原因。
    void tx.done.catch(() => undefined);
    tx.abort();
    throw new Error(`导入事务已回滚，现有工程未修改：${message}`);
  }
  const now = Date.now();
  const record: AnnotationRecord = {
    projectId: input.projectId,
    measurements: input.plan.measurements,
    rois: input.plan.rois,
    display: input.plan.display,
    lastImportSource: input.source,
    updatedAt: now,
  };
  const event: ImportEventRecord = {
    ...input.source,
    id: crypto.randomUUID(),
    projectId: input.projectId,
    projectName: input.projectName,
    mode: input.mode,
    stats: input.plan.stats,
  };
  await Promise.all([annotationStore.put(record), eventStore.put(event)]);
  await transactionDone(tx);
  return event;
}

function transactionDone(tx: IDBPTransaction<CoreCtDB, ('annotations' | 'importEvents')[], 'readwrite'>): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.addEventListener('complete', () => resolve());
    tx.addEventListener('error', () =>
      reject(new Error('导入事务已回滚，现有工程未修改：标注包含非法坐标')),
    );
    tx.addEventListener('abort', () =>
      reject(new Error('导入事务已回滚，现有工程未修改：标注包含非法坐标')),
    );
  });
}

export async function listImportEvents(projectId: string): Promise<ImportEventRecord[]> {
  const db = await getDb();
  return (await db.getAllFromIndex('importEvents', 'byProject', projectId)).sort(
    (a, b) => b.importedAt - a.importedAt,
  );
}

export async function closeDatabase(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
}
