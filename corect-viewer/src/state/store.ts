import { create } from 'zustand';
import type { DecodedVolume, Vec3 } from '../format/corevol';
import {
  buildAnnotationPreview,
  createAnnotationPackage,
  createVolumeIdentity,
  parseAnnotationPackage,
  planAnnotationImport,
  sha256Hex,
  verifyPackageDigest,
  type AnnotationPreview,
  type DisplaySettings,
  type ImportMode,
  type ImportSourceSummary,
} from '../format/annotations';
import type { Measurement, Roi } from '../geometry/roi';
import { clampIjk } from '../geometry/viewMath';
import { decodeVolumeInWorker } from '../workers/decodeClient';
import {
  commitAnnotationImport,
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

export interface AnnotationImportSession {
  fileName: string;
  fileSize: number;
  fileDigestSHA256: string;
  preview: AnnotationPreview | null;
  resolutions: Record<string, string>;
  error: string | null;
  applying: boolean;
  applyError: string | null;
  previewToken: number;
}

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
  lastImportSource: ImportSourceSummary | null;
  importSession: AnnotationImportSession | null;
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

  exportAnnotationPackage: () => Promise<void>;
  previewAnnotationFile: (file: File) => Promise<void>;
  setAnnotationResolution: (key: string, label: string) => void;
  confirmAnnotationImport: (mode: ImportMode) => Promise<void>;
  cancelAnnotationImport: () => void;
}

function defaultWindowLevel(volume: DecodedVolume): { window: number; level: number } {
  const range = volume.max - volume.min;
  return { window: Math.max(range, 1), level: volume.min + range / 2 };
}

function defaultDisplay(volume: DecodedVolume, crosshair?: Vec3): DisplaySettings {
  const { dims } = volume.header;
  const center =
    crosshair ??
    clampIjk(
      [Math.floor(dims[0] / 2), Math.floor(dims[1] / 2), Math.floor(dims[2] / 2)],
      dims,
    );
  return {
    crosshair: center,
    windowLevel: defaultWindowLevel(volume),
    threshold: volume.min + (volume.max - volume.min) * 0.6,
  };
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
  lastImportSource: null,
  importSession: null,
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

  removeProject: async (id) => {
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
        lastImportSource: null,
        importSession: null,
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

  exportAnnotationPackage: async () => {
    const state = get();
    if (!state.volume || !state.projectId) throw new Error('没有可导出的工程');
    await flushPendingAnnotationSave();
    const pkg = await createAnnotationPackage({
      volume: state.volume,
      measurements: state.measurements,
      rois: state.rois,
      display: {
        crosshair: state.crosshair,
        windowLevel: state.windowLevel,
        threshold: state.threshold,
      },
    });
    const text = JSON.stringify(pkg, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const base = state.projectName || state.projectId;
    a.href = url;
    a.download = `${base.replace(/[\\/:*?"<>|]+/g, '_')}.annotations.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  previewAnnotationFile: async (file) => {
    const state = get();
    if (!state.volume || !state.projectId || !state.projectName) return;
    await flushPendingAnnotationSave();
    const token = Date.now();
    set({ importSession: {
      fileName: file.name,
      fileSize: file.size,
      fileDigestSHA256: '',
      preview: null,
      resolutions: {},
      error: null,
      applying: false,
      applyError: null,
      previewToken: token,
    } });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()) as Uint8Array<ArrayBuffer>;
      const fileDigestSHA256 = await sha256Hex(bytes);
      const text = new TextDecoder().decode(bytes);
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error('标注包不是合法 JSON');
      }
      const digestError = await verifyPackageDigest(raw);
      const parsed = parseAnnotationPackage(raw);
      if (digestError) parsed.errors.push(digestError);
      const preview = buildAnnotationPreview({
        parsed,
        currentIdentity: await createVolumeIdentity(state.volume),
        current: { measurements: state.measurements, rois: state.rois },
      });
      const fresh = get();
      if (fresh.projectId !== state.projectId || fresh.importSession?.previewToken !== token) return;
      set({
        importSession: {
          fileName: file.name,
          fileSize: file.size,
          fileDigestSHA256,
          preview,
          resolutions: { ...preview.resolutionSuggestions },
          error: null,
          applying: false,
          applyError: null,
          previewToken: token,
        },
      });
    } catch (err) {
      const failedSession = get().importSession;
      if (failedSession?.previewToken !== token) return;
      set({
        importSession: {
          ...failedSession,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  },

  setAnnotationResolution: (key, label) => {
    const session = get().importSession;
    if (!session) return;
    set({
      importSession: { ...session, resolutions: { ...session.resolutions, [key]: label }, applyError: null },
    });
  },

  confirmAnnotationImport: async (mode) => {
    const state = get();
    const session = state.importSession;
    const pkg = session?.preview?.package;
    if (!state.volume || !state.projectId || !session || !pkg || !session.preview?.canConfirm) {
      throw new Error('当前没有可确认的标注导入');
    }
    const { plan, errors } = planAnnotationImport(
      pkg,
      { measurements: state.measurements, rois: state.rois },
      mode,
      session.resolutions,
    );
    if (!plan) {
      set({ importSession: { ...session, applyError: errors.join('；') } });
      return;
    }
    set({ importSession: { ...session, applying: true, applyError: null } });
    try {
      const source: ImportSourceSummary = {
        fileName: session.fileName,
        fileSize: session.fileSize,
        fileDigestSHA256: session.fileDigestSHA256,
        packageDigestSHA256: pkg.packageDigestSHA256,
        sourceFormatVersion: session.preview.sourceFormatVersion ?? pkg.formatVersion,
        importedAt: Date.now(),
      };
      await commitAnnotationImport({
        projectId: state.projectId,
        projectName: state.projectName,
        plan,
        dims: state.volume.header.dims,
        source,
        mode,
      });
      set({
        measurements: plan.measurements,
        rois: plan.rois,
        crosshair: clampIjk(plan.display.crosshair, state.volume.header.dims),
        windowLevel: plan.display.windowLevel,
        threshold: plan.display.threshold,
        activeRoiId: null,
        pendingMeasure: null,
        lastImportSource: source,
        importSession: null,
      });
    } catch (err) {
      const failed = get().importSession;
      if (failed) {
        set({
          importSession: {
            ...failed,
            applying: false,
            applyError: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  },

  cancelAnnotationImport: () => set({ importSession: null }),
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
  // 3. 恢复标注和显示设置（不存在则用体数据中心作为初始十字丝）
  const saved = await getAnnotations(projectId);
  const fallback = defaultDisplay(volume, saved?.display.crosshair);
  const display: DisplaySettings = saved?.display
    ? {
        crosshair: clampIjk(saved.display.crosshair, volume.header.dims),
        windowLevel: saved.display.windowLevel,
        threshold: saved.display.threshold,
      }
    : fallback;
  set({
    status: 'ready',
    error: null,
    projectId,
    projectName: name,
    volume,
    crosshair: display.crosshair,
    measurements: saved?.measurements ?? [],
    rois: saved?.rois ?? [],
    windowLevel: display.windowLevel,
    threshold: display.threshold,
    lastImportSource: saved?.lastImportSource ?? null,
    activeRoiId: null,
    pendingMeasure: null,
    importSession: null,
    projects: await listProjects(),
  });
  localStorage.setItem(LAST_PROJECT_KEY, projectId);
}

// 标注/显示设置变化后防抖写入 IndexedDB —— 刷新页面不丢失
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: Promise<void> | null = null;

export async function flushPendingAnnotationSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const s = useStore.getState();
    if (s.projectId) pendingSave = persistCurrentAnnotations(s);
  }
  await pendingSave;
}

function persistCurrentAnnotations(s: AppState): Promise<void> {
  return saveAnnotations({
    projectId: s.projectId!,
    measurements: s.measurements,
    rois: s.rois,
    display: {
      crosshair: s.crosshair,
      windowLevel: s.windowLevel,
      threshold: s.threshold,
    },
    updatedAt: Date.now(),
  });
}

useStore.subscribe((state, prev) => {
  if (!state.projectId || state.status !== 'ready') return;
  if (
    state.measurements === prev.measurements &&
    state.rois === prev.rois &&
    state.crosshair === prev.crosshair &&
    state.windowLevel === prev.windowLevel &&
    state.threshold === prev.threshold
  ) {
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const s = useStore.getState();
    if (!s.projectId) return;
    pendingSave = persistCurrentAnnotations(s);
  }, 300);
});
