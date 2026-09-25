import { create } from 'zustand';
import type { DecodedVolume, Vec3 } from '../format/corevol';
import type { Measurement, Roi } from '../geometry/roi';
import { clampIjk } from '../geometry/viewMath';
import { decodeVolumeInWorker } from '../workers/decodeClient';
import {
  deleteProject as dbDeleteProject,
  getAnnotations,
  getProject,
  listProjects,
  saveAnnotations,
  saveProject,
  type ProjectMeta,
} from '../db/projectDb';

export type Tool = 'navigate' | 'measure' | 'roi';

const LAST_PROJECT_KEY = 'corect:lastProjectId';
const SAMPLE_URL = `${import.meta.env.BASE_URL}samples/synthetic-core.corevol`;
const SAMPLE_PROJECT_ID = 'sample:synthetic-core';

export interface AppState {
  status: 'empty' | 'loading' | 'ready' | 'error';
  error: string | null;
  projectId: string | null;
  projectName: string;
  projects: ProjectMeta[];
  volume: DecodedVolume | null;
  /** 当前十字丝位置（体素索引 IJK），三个切面由此同步 */
  crosshair: Vec3;
  tool: Tool;
  windowLevel: { window: number; level: number };
  /** ROI 阈值预览的阈值 */
  threshold: number;
  measurements: Measurement[];
  rois: Roi[];
  activeRoiId: string | null;
  /** 测量工具：已落下的第一个点（可跨视图完成第二点） */
  pendingMeasure: Vec3 | null;

  refreshProjectList: () => Promise<void>;
  loadSample: () => Promise<void>;
  importFile: (file: File) => Promise<void>;
  openProject: (id: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  loadLastProject: () => Promise<void>;

  setCrosshair: (ijk: Vec3) => void;
  setTool: (tool: Tool) => void;
  setWindowLevel: (wl: { window: number; level: number }) => void;
  setThreshold: (t: number) => void;
  clickMeasurePoint: (ijk: Vec3) => void;
  cancelPendingMeasure: () => void;
  addRoi: (roi: Omit<Roi, 'id' | 'createdAt'>) => void;
  deleteMeasurement: (id: string) => void;
  deleteRoi: (id: string) => void;
  setActiveRoi: (id: string | null) => void;
}

function defaultWindowLevel(volume: DecodedVolume): { window: number; level: number } {
  const range = volume.max - volume.min;
  return { window: Math.max(range, 1), level: volume.min + range / 2 };
}

export const useStore = create<AppState>()((set, get) => ({
  status: 'empty',
  error: null,
  projectId: null,
  projectName: '',
  projects: [],
  volume: null,
  crosshair: [0, 0, 0],
  tool: 'navigate',
  windowLevel: { window: 1, level: 0 },
  threshold: 0,
  measurements: [],
  rois: [],
  activeRoiId: null,
  pendingMeasure: null,

  refreshProjectList: async () => {
    set({ projects: await listProjects() });
  },

  loadSample: async () => {
    set({ status: 'loading', error: null });
    try {
      const resp = await fetch(SAMPLE_URL);
      if (!resp.ok) throw new Error(`样例下载失败：HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();
      await openBuffer(SAMPLE_PROJECT_ID, buffer, set, get);
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  importFile: async (file: File) => {
    set({ status: 'loading', error: null });
    try {
      const buffer = await file.arrayBuffer();
      const id = `file:${file.name}:${file.size}`;
      await openBuffer(id, buffer, set, get);
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  openProject: async (id: string) => {
    set({ status: 'loading', error: null });
    try {
      const record = await getProject(id);
      if (!record) throw new Error('工程不存在或已被删除');
      await openBuffer(record.id, record.fileBuffer, set, get);
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  removeProject: async (id: string) => {
    await dbDeleteProject(id);
    if (get().projectId === id) {
      set({
        status: 'empty',
        projectId: null,
        projectName: '',
        volume: null,
        measurements: [],
        rois: [],
        activeRoiId: null,
        pendingMeasure: null,
        crosshair: [0, 0, 0],
      });
      localStorage.removeItem(LAST_PROJECT_KEY);
    }
    set({ projects: await listProjects() });
  },

  loadLastProject: async () => {
    set({ projects: await listProjects() });
    const lastId = localStorage.getItem(LAST_PROJECT_KEY);
    if (lastId && (await getProject(lastId))) {
      await get().openProject(lastId);
    }
  },

  setCrosshair: (ijk) => {
    const { volume } = get();
    if (!volume) return;
    set({ crosshair: clampIjk(ijk, volume.header.dims) });
  },

  setTool: (tool) => set({ tool, pendingMeasure: null }),

  setWindowLevel: (wl) => set({ windowLevel: wl }),

  setThreshold: (t) => set({ threshold: t }),

  clickMeasurePoint: (ijk) => {
    const { pendingMeasure, measurements } = get();
    if (!pendingMeasure) {
      set({ pendingMeasure: ijk });
    } else {
      set({
        measurements: [
          ...measurements,
          { id: crypto.randomUUID(), p1: pendingMeasure, p2: ijk, createdAt: Date.now() },
        ],
        pendingMeasure: null,
      });
    }
  },

  cancelPendingMeasure: () => set({ pendingMeasure: null }),

  addRoi: (roi) => {
    const id = crypto.randomUUID();
    set({ rois: [...get().rois, { ...roi, id, createdAt: Date.now() }], activeRoiId: id });
  },

  deleteMeasurement: (id) =>
    set({ measurements: get().measurements.filter((m) => m.id !== id) }),

  deleteRoi: (id) =>
    set({
      rois: get().rois.filter((r) => r.id !== id),
      activeRoiId: get().activeRoiId === id ? null : get().activeRoiId,
    }),

  setActiveRoi: (id) => set({ activeRoiId: id }),
}));

type Set = (partial: Partial<AppState>) => void;
type Get = () => AppState;

/** 打开一个 .corevol buffer：Worker 解码（用副本，会被转移）→ 原件入 IndexedDB → 恢复标注。 */
async function openBuffer(projectId: string, buffer: ArrayBuffer, set: Set, _get: Get) {
  // 1. Worker 解码（传入副本；解码失败则抛错，不落库）
  const volume = await decodeVolumeInWorker(buffer.slice(0));
  const name = volume.header.name || projectId;
  // 2. 原始文件入库，刷新页面后可恢复体数据
  const existing = await getProject(projectId);
  await saveProject({
    id: projectId,
    name,
    createdAt: existing?.createdAt ?? Date.now(),
    fileBuffer: buffer,
  });
  // 3. 恢复标注（不存在则用体数据中心作为初始十字丝）
  const saved = await getAnnotations(projectId);
  const { dims } = volume.header;
  const center = clampIjk(
    [Math.floor(dims[0] / 2), Math.floor(dims[1] / 2), Math.floor(dims[2] / 2)],
    dims,
  );
  set({
    status: 'ready',
    error: null,
    projectId,
    projectName: name,
    volume,
    crosshair: saved?.crosshair ?? center,
    measurements: saved?.measurements ?? [],
    rois: saved?.rois ?? [],
    activeRoiId: null,
    pendingMeasure: null,
    windowLevel: defaultWindowLevel(volume),
    threshold: volume.min + (volume.max - volume.min) * 0.6,
    projects: await listProjects(),
  });
  localStorage.setItem(LAST_PROJECT_KEY, projectId);
}

// 标注/十字丝变化后防抖写入 IndexedDB —— 刷新页面不丢失
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((state, prev) => {
  if (!state.projectId || state.status !== 'ready') return;
  if (
    state.measurements === prev.measurements &&
    state.rois === prev.rois &&
    state.crosshair === prev.crosshair
  ) {
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = useStore.getState();
    if (!s.projectId) return;
    void saveAnnotations({
      projectId: s.projectId,
      measurements: s.measurements,
      rois: s.rois,
      crosshair: s.crosshair,
      updatedAt: Date.now(),
    });
  }, 300);
});
