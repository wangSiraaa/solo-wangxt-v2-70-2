import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Vec3 } from '../format/corevol';
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
  crosshair: Vec3;
  updatedAt: number;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
}

interface CoreCtDB extends DBSchema {
  projects: { key: string; value: ProjectRecord };
  annotations: { key: string; value: AnnotationRecord };
}

const DB_NAME = 'corect-viewer';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<CoreCtDB>> | null = null;

function getDb(): Promise<IDBPDatabase<CoreCtDB>> {
  if (!dbPromise) {
    dbPromise = openDB<CoreCtDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('projects', { keyPath: 'id' });
        db.createObjectStore('annotations', { keyPath: 'projectId' });
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
  await Promise.all([db.delete('projects', id), db.delete('annotations', id)]);
}

export async function saveAnnotations(record: AnnotationRecord): Promise<void> {
  const db = await getDb();
  await db.put('annotations', record);
}

export async function getAnnotations(projectId: string): Promise<AnnotationRecord | undefined> {
  const db = await getDb();
  return db.get('annotations', projectId);
}
