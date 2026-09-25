import { useEffect, useRef, useState } from 'react';
// 按需注册 OpenGL 实现（避免 Profiles/All 引入体积渲染等无用模块）
import '@kitware/vtk.js/Rendering/OpenGL/Texture';
import '@kitware/vtk.js/Rendering/OpenGL/Camera';
import '@kitware/vtk.js/Rendering/OpenGL/Renderer';
import '@kitware/vtk.js/Rendering/OpenGL/ImageMapper';
import '@kitware/vtk.js/Rendering/OpenGL/ImageSlice';
import vtkRenderWindow from '@kitware/vtk.js/Rendering/Core/RenderWindow';
import vtkRenderer from '@kitware/vtk.js/Rendering/Core/Renderer';
import vtkOpenGLRenderWindow from '@kitware/vtk.js/Rendering/OpenGL/RenderWindow';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkImageMapper from '@kitware/vtk.js/Rendering/Core/ImageMapper';
import { SlicingMode } from '@kitware/vtk.js/Rendering/Core/ImageMapper/Constants';
import vtkImageSlice from '@kitware/vtk.js/Rendering/Core/ImageSlice';
import type { Vec3 } from '../format/corevol';
import { useStore } from '../state/store';
import {
  VIEW_CONFIGS,
  fitHalfHeight,
  ijkToWorld,
  physicalDistance,
  screenToWorld,
  sliceFocal,
  viewBasis,
  worldToIjk,
  worldToScreen,
  type CameraModel,
  type PlaneAxis,
} from '../geometry/viewMath';

const CAMERA_DISTANCE = 1000;
const SLICING_MODES = [SlicingMode.I, SlicingMode.J, SlicingMode.K] as const;

const COLOR_CROSSHAIR = '#ffd54a';
const COLOR_MEASURE = '#4fc3f7';
const COLOR_ROI = '#69f0ae';
const COLOR_ROI_ACTIVE = '#ff9800';
const COLOR_MASK = 'rgba(255, 82, 82, 0.45)';

type RenderWindowT = ReturnType<typeof vtkRenderWindow.newInstance>;
type RendererT = ReturnType<typeof vtkRenderer.newInstance>;
type OpenGLT = ReturnType<typeof vtkOpenGLRenderWindow.newInstance>;
type MapperT = ReturnType<typeof vtkImageMapper.newInstance>;

interface ViewRuntime {
  renderWindow: RenderWindowT;
  renderer: RendererT;
  openGL: OpenGLT;
  mapper: MapperT;
  hasVolume: boolean;
}

interface DraftRect {
  start: [number, number];
  cur: [number, number];
}

export function SliceView({ axis }: { axis: PlaneAxis }) {
  const cfg = VIEW_CONFIGS[axis];
  const containerRef = useRef<HTMLDivElement>(null);
  const vtkRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const rtRef = useRef<ViewRuntime | null>(null);
  const draggingRef = useRef(false);

  const [viewport, setViewport] = useState<{ w: number; h: number } | null>(null);
  const [cam, setCam] = useState<CameraModel | null>(null);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [draft, setDraft] = useState<DraftRect | null>(null);

  const volume = useStore((s) => s.volume);
  const crosshair = useStore((s) => s.crosshair);
  const tool = useStore((s) => s.tool);
  const windowLevel = useStore((s) => s.windowLevel);
  const threshold = useStore((s) => s.threshold);
  const measurements = useStore((s) => s.measurements);
  const rois = useStore((s) => s.rois);
  const activeRoiId = useStore((s) => s.activeRoiId);
  const pendingMeasure = useStore((s) => s.pendingMeasure);
  const setCrosshair = useStore((s) => s.setCrosshair);
  const clickMeasurePoint = useStore((s) => s.clickMeasurePoint);
  const addRoi = useStore((s) => s.addRoi);

  // ---- 初始化 vtk 渲染管线（每视图一次） ----
  useEffect(() => {
    const container = vtkRef.current;
    if (!container) return;
    const renderWindow = vtkRenderWindow.newInstance();
    const renderer = vtkRenderer.newInstance({ background: [0.07, 0.07, 0.09] });
    renderWindow.addRenderer(renderer);
    const openGL = vtkOpenGLRenderWindow.newInstance();
    openGL.setContainer(container);
    renderWindow.addView(openGL);

    const mapper = vtkImageMapper.newInstance();
    mapper.setSlicingMode(SLICING_MODES[axis]);
    const actor = vtkImageSlice.newInstance();
    actor.setMapper(mapper);
    actor.getProperty().setInterpolationTypeToNearest();
    renderer.addActor(actor);

    rtRef.current = { renderWindow, renderer, openGL, mapper, hasVolume: false };

    const parent = containerRef.current;
    const ro = new ResizeObserver(() => {
      if (!parent) return;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (w > 0 && h > 0) {
        openGL.setSize(w, h);
        setViewport({ w, h });
      }
    });
    if (parent) ro.observe(parent);

    return () => {
      ro.disconnect();
      rtRef.current = null;
      openGL.setContainer(null);
      renderWindow.removeView(openGL);
      actor.delete();
      mapper.delete();
      renderer.delete();
      openGL.delete();
      renderWindow.delete();
    };
  }, [axis]);

  // ---- 体数据到达后接入 mapper ----
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt || !volume) return;
    const imageData = vtkImageData.newInstance();
    const { dims, spacing, origin } = volume.header;
    imageData.setDimensions(dims);
    imageData.setSpacing(spacing);
    imageData.setOrigin(origin);
    imageData.getPointData().setScalars(
      vtkDataArray.newInstance({ values: volume.data, numberOfComponents: 1 }),
    );
    rt.mapper.setInputData(imageData);
    rt.hasVolume = true;
    // 触发一次相机同步（依赖 crosshair 的 effect 会在下一帧运行）
    setViewport((v) => (v ? { ...v } : v));
  }, [volume]);

  // ---- 窗宽窗位 ----
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt?.hasVolume) return;
    const actor = rt.renderer.getActors()[0] as ReturnType<typeof vtkImageSlice.newInstance>;
    actor.getProperty().setColorWindow(windowLevel.window);
    actor.getProperty().setColorLevel(windowLevel.level);
    rt.renderWindow.render();
  }, [windowLevel]);

  // ---- 同步切片位置与相机（十字丝变化 → 三视图联动） ----
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt?.hasVolume || !volume || !viewport) return;
    const { dims, spacing, origin } = volume.header;
    const slice = crosshair[axis];
    rt.mapper.setSlice(slice);

    const aspect = viewport.w / viewport.h;
    const halfHeight = fitHalfHeight(cfg, dims, spacing, aspect);
    const focal = sliceFocal(cfg, dims, spacing, origin, slice);
    const camera = rt.renderer.getActiveCamera();
    camera.setParallelProjection(true);
    camera.setParallelScale(halfHeight);
    camera.setFocalPoint(focal[0], focal[1], focal[2]);
    camera.setPosition(
      focal[0] - cfg.cameraDir[0] * CAMERA_DISTANCE,
      focal[1] - cfg.cameraDir[1] * CAMERA_DISTANCE,
      focal[2] - cfg.cameraDir[2] * CAMERA_DISTANCE,
    );
    camera.setViewUp(cfg.viewUp);
    camera.setClippingRange(1, CAMERA_DISTANCE * 2);
    rt.renderWindow.render();

    const { right, up } = viewBasis(cfg);
    setCam({ focal, right, up, halfHeight, width: viewport.w, height: viewport.h });
  }, [volume, viewport, crosshair, axis, cfg]);

  // ---- 叠加层绘制：十字丝 / 测量 / ROI / 阈值掩膜 ----
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !cam || !volume) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cam.width * dpr);
    canvas.height = Math.round(cam.height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cam.width, cam.height);

    const { spacing, origin } = volume.header;
    const slice = crosshair[axis];
    const uAxis = cfg.uAxis;
    const vAxis = cfg.vAxis;

    const uvToScreen = (u: number, v: number): [number, number] => {
      const ijk: Vec3 = [0, 0, 0];
      ijk[axis] = slice;
      ijk[uAxis] = u;
      ijk[vAxis] = v;
      return worldToScreen(cam, ijkToWorld(ijk, spacing, origin));
    };

    // 阈值掩膜（仅活动 ROI、当前层）
    const activeRoi = rois.find((r) => r.id === activeRoiId);
    if (activeRoi && activeRoi.axis === axis && activeRoi.slice === slice) {
      ctx.fillStyle = COLOR_MASK;
      const data = volume.data;
      const dims = volume.header.dims;
      for (let v = activeRoi.min[1]; v <= activeRoi.max[1]; v++) {
        for (let u = activeRoi.min[0]; u <= activeRoi.max[0]; u++) {
          const ijk: Vec3 = [0, 0, 0];
          ijk[axis] = slice;
          ijk[uAxis] = u;
          ijk[vAxis] = v;
          const idx = ijk[0] + dims[0] * (ijk[1] + dims[1] * ijk[2]);
          if (data[idx] >= threshold) {
            const p0 = uvToScreen(u - 0.5, v - 0.5);
            const p1 = uvToScreen(u + 0.5, v + 0.5);
            ctx.fillRect(
              Math.min(p0[0], p1[0]),
              Math.min(p0[1], p1[1]),
              Math.abs(p1[0] - p0[0]),
              Math.abs(p1[1] - p0[1]),
            );
          }
        }
      }
    }

    // ROI 矩形（当前层）
    for (const roi of rois) {
      if (roi.axis !== axis || roi.slice !== slice) continue;
      const p0 = uvToScreen(roi.min[0] - 0.5, roi.min[1] - 0.5);
      const p1 = uvToScreen(roi.max[0] + 0.5, roi.max[1] + 0.5);
      ctx.strokeStyle = roi.id === activeRoiId ? COLOR_ROI_ACTIVE : COLOR_ROI;
      ctx.lineWidth = roi.id === activeRoiId ? 2.5 : 1.5;
      ctx.strokeRect(
        Math.min(p0[0], p1[0]),
        Math.min(p0[1], p1[1]),
        Math.abs(p1[0] - p0[0]),
        Math.abs(p1[1] - p0[1]),
      );
    }

    // 框选中的草稿矩形
    if (draft) {
      ctx.strokeStyle = COLOR_ROI_ACTIVE;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(
        Math.min(draft.start[0], draft.cur[0]),
        Math.min(draft.start[1], draft.cur[1]),
        Math.abs(draft.cur[0] - draft.start[0]),
        Math.abs(draft.cur[1] - draft.start[1]),
      );
      ctx.setLineDash([]);
    }

    // 测量线段（离层的变淡）
    ctx.font = '12px sans-serif';
    for (const m of measurements) {
      const onSlice = m.p1[axis] === slice && m.p2[axis] === slice;
      ctx.globalAlpha = onSlice ? 1 : 0.3;
      const s1 = worldToScreen(cam, ijkToWorld(m.p1, spacing, origin));
      const s2 = worldToScreen(cam, ijkToWorld(m.p2, spacing, origin));
      ctx.strokeStyle = COLOR_MEASURE;
      ctx.fillStyle = COLOR_MEASURE;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(s1[0], s1[1]);
      ctx.lineTo(s2[0], s2[1]);
      ctx.stroke();
      for (const p of [s1, s2]) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], 3, 0, Math.PI * 2);
        ctx.fill();
      }
      const dist = physicalDistance(m.p1, m.p2, spacing);
      const label = `${dist.toFixed(2)} mm`;
      const lx = (s1[0] + s2[0]) / 2 + 6;
      const ly = (s1[1] + s2[1]) / 2 - 6;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3;
      ctx.strokeText(label, lx, ly);
      ctx.fillText(label, lx, ly);
      ctx.globalAlpha = 1;
    }

    // 测量待定第一点 + 橡皮筋
    if (pendingMeasure) {
      const s1 = worldToScreen(cam, ijkToWorld(pendingMeasure, spacing, origin));
      ctx.fillStyle = COLOR_MEASURE;
      ctx.beginPath();
      ctx.arc(s1[0], s1[1], 4, 0, Math.PI * 2);
      ctx.fill();
      if (hover) {
        ctx.strokeStyle = COLOR_MEASURE;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(s1[0], s1[1]);
        ctx.lineTo(hover[0], hover[1]);
        ctx.stroke();
        ctx.setLineDash([]);
        if (pendingMeasure[axis] === slice) {
          const world = screenToWorld(cam, hover[0], hover[1]);
          const ijk = worldToIjk(world, spacing, origin, volume.header.dims);
          const dist = physicalDistance(pendingMeasure, ijk, spacing);
          ctx.strokeStyle = 'rgba(0,0,0,0.8)';
          ctx.lineWidth = 3;
          const label = `${dist.toFixed(2)} mm`;
          ctx.strokeText(label, hover[0] + 8, hover[1] - 8);
          ctx.fillStyle = COLOR_MEASURE;
          ctx.fillText(label, hover[0] + 8, hover[1] - 8);
        }
      }
    }

    // 十字丝
    const [cx, cy] = worldToScreen(cam, ijkToWorld(crosshair, spacing, origin));
    ctx.strokeStyle = COLOR_CROSSHAIR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, cam.height);
    ctx.moveTo(0, cy);
    ctx.lineTo(cam.width, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.stroke();
  }, [cam, volume, crosshair, measurements, rois, activeRoiId, threshold, pendingMeasure, hover, draft, axis, cfg]);

  // ---- 交互 ----
  const eventPos = (e: React.PointerEvent | React.WheelEvent): [number, number] => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const posToIjk = (px: number, py: number): Vec3 | null => {
    if (!cam || !volume) return null;
    const world = screenToWorld(cam, px, py);
    return worldToIjk(world, volume.header.spacing, volume.header.origin, volume.header.dims);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!cam || !volume || e.button !== 0) return;
    overlayRef.current?.setPointerCapture(e.pointerId);
    const [px, py] = eventPos(e);
    if (tool === 'navigate') {
      draggingRef.current = true;
      const ijk = posToIjk(px, py);
      if (ijk) setCrosshair(ijk);
    } else if (tool === 'roi') {
      setDraft({ start: [px, py], cur: [px, py] });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const [px, py] = eventPos(e);
    setHover([px, py]);
    if (draggingRef.current && tool === 'navigate') {
      const ijk = posToIjk(px, py);
      if (ijk) setCrosshair(ijk);
    }
    if (draft) setDraft({ ...draft, cur: [px, py] });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!cam || !volume) return;
    const [px, py] = eventPos(e);
    if (tool === 'measure') {
      const ijk = posToIjk(px, py);
      if (ijk) clickMeasurePoint(ijk);
    } else if (tool === 'roi' && draft) {
      const a = posToIjk(draft.start[0], draft.start[1]);
      const b = posToIjk(px, py);
      if (a && b) {
        const minU = Math.min(a[cfg.uAxis], b[cfg.uAxis]);
        const maxU = Math.max(a[cfg.uAxis], b[cfg.uAxis]);
        const minV = Math.min(a[cfg.vAxis], b[cfg.vAxis]);
        const maxV = Math.max(a[cfg.vAxis], b[cfg.vAxis]);
        if (maxU >= minU && maxV >= minV) {
          addRoi({
            axis,
            slice: crosshair[axis],
            min: [minU, minV],
            max: [maxU, maxV],
          });
        }
      }
      setDraft(null);
    }
    draggingRef.current = false;
  };

  // 滚轮切换切片（需要 passive: false 才能阻止页面滚动）
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const state = useStore.getState();
      if (!state.volume) return;
      const delta = e.deltaY > 0 ? 1 : -1;
      const next: Vec3 = [...state.crosshair];
      next[axis] += delta;
      state.setCrosshair(next);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [axis]);

  return (
    <div ref={containerRef} className="slice-view">
      <div ref={vtkRef} className="vtk-container" />
      <canvas
        ref={overlayRef}
        className="overlay"
        style={{ cursor: tool === 'navigate' ? 'crosshair' : tool === 'measure' ? 'cell' : 'copy' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
      />
      <div className="view-label">
        {cfg.label}（{cfg.axisLabel} = {crosshair[axis]}）
      </div>
    </div>
  );
}
