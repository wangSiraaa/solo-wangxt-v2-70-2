import { useRef } from 'react';
import { useStore, type Tool } from '../state/store';
import { computeRoiStats } from '../geometry/roi';
import { physicalDistance, VIEW_CONFIGS } from '../geometry/viewMath';
import { dtypeLabel } from '../format/corevol';

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'navigate', label: '浏览', hint: '拖动定位十字丝，滚轮换层' },
  { id: 'measure', label: '测量', hint: '依次点击两点测距（可跨视图）' },
  { id: 'roi', label: '框选 ROI', hint: '拖出矩形兴趣区' },
];

export function SidePanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const s = useStore();

  const activeRoi = s.rois.find((r) => r.id === s.activeRoiId) ?? null;
  const roiStats =
    activeRoi && s.volume
      ? computeRoiStats(s.volume.data, s.volume.header.dims, activeRoi, s.threshold)
      : null;

  return (
    <aside className="side-panel">
      <section>
        <h3>工程</h3>
        <div className="btn-row">
          <button onClick={() => void s.loadSample()}>加载样例</button>
          <button onClick={() => fileRef.current?.click()}>导入 .corevol</button>
          <input
            ref={fileRef}
            type="file"
            accept=".corevol"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void s.importFile(f);
              e.target.value = '';
            }}
          />
        </div>
        <ul className="project-list">
          {s.projects.map((p) => (
            <li key={p.id} className={p.id === s.projectId ? 'active' : ''}>
              <button className="link" onClick={() => void s.openProject(p.id)} title="打开工程">
                {p.name || p.id}
              </button>
              <button className="danger" onClick={() => void s.removeProject(p.id)} title="删除工程">
                ×
              </button>
            </li>
          ))}
          {s.projects.length === 0 && <li className="muted">暂无工程，请加载样例</li>}
        </ul>
      </section>

      {s.volume && (
        <>
          <section>
            <h3>体数据</h3>
            <div className="kv">
              <span>维度</span>
              <span>{s.volume.header.dims.join(' × ')}</span>
              <span>间距 (mm)</span>
              <span>{s.volume.header.spacing.map((v) => v.toFixed(2)).join(' × ')}</span>
              <span>类型</span>
              <span>{dtypeLabel(s.volume.header.dtype)}</span>
              <span>值域</span>
              <span>
                {s.volume.min} ~ {s.volume.max}
              </span>
            </div>
          </section>

          <section>
            <h3>工具</h3>
            <div className="btn-row">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  className={s.tool === t.id ? 'active' : ''}
                  title={t.hint}
                  onClick={() => s.setTool(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {s.pendingMeasure && (
              <div className="hint">
                已落下第一点，点击第二点完成测量。
                <button className="link" onClick={s.cancelPendingMeasure}>
                  取消
                </button>
              </div>
            )}
          </section>

          <section>
            <h3>窗宽 / 窗位</h3>
            <label>
              窗宽 {s.windowLevel.window.toFixed(0)}
              <input
                type="range"
                min={1}
                max={Math.max(s.volume.max - s.volume.min, 1) * 1.5}
                step={1}
                value={s.windowLevel.window}
                onChange={(e) =>
                  s.setWindowLevel({ ...s.windowLevel, window: Number(e.target.value) })
                }
              />
            </label>
            <label>
              窗位 {s.windowLevel.level.toFixed(0)}
              <input
                type="range"
                min={s.volume.min}
                max={s.volume.max}
                step={1}
                value={s.windowLevel.level}
                onChange={(e) =>
                  s.setWindowLevel({ ...s.windowLevel, level: Number(e.target.value) })
                }
              />
            </label>
          </section>

          <section>
            <h3>ROI 阈值预览</h3>
            <label>
              阈值 {s.threshold.toFixed(0)}
              <input
                type="range"
                min={s.volume.min}
                max={s.volume.max}
                step={1}
                value={s.threshold}
                onChange={(e) => s.setThreshold(Number(e.target.value))}
              />
            </label>
            {activeRoi && roiStats ? (
              <div className="kv">
                <span>体素总数</span>
                <span>{roiStats.total.toLocaleString()}</span>
                <span>≥ 阈值</span>
                <span>
                  {roiStats.above.toLocaleString()}（
                  {((roiStats.above / roiStats.total) * 100).toFixed(1)}%）
                </span>
                <span>最小 / 最大</span>
                <span>
                  {roiStats.min} / {roiStats.max}
                </span>
                <span>均值</span>
                <span>{roiStats.mean.toFixed(2)}</span>
              </div>
            ) : (
              <div className="hint">用「框选 ROI」工具拖出矩形后在此查看统计。</div>
            )}
          </section>

          <section>
            <h3>测量（{s.measurements.length}）</h3>
            <ul className="annot-list">
              {s.measurements.map((m) => (
                <li key={m.id}>
                  <span>
                    ({m.p1.join(', ')}) → ({m.p2.join(', ')}) ={' '}
                    <b>{physicalDistance(m.p1, m.p2, s.volume!.header.spacing).toFixed(2)} mm</b>
                  </span>
                  <button className="danger" onClick={() => s.deleteMeasurement(m.id)}>
                    ×
                  </button>
                </li>
              ))}
              {s.measurements.length === 0 && <li className="muted">暂无测量</li>}
            </ul>
          </section>

          <section>
            <h3>ROI（{s.rois.length}）</h3>
            <ul className="annot-list">
              {s.rois.map((r) => (
                <li key={r.id} className={r.id === s.activeRoiId ? 'active' : ''}>
                  <button className="link" onClick={() => s.setActiveRoi(r.id)}>
                    {VIEW_CONFIGS[r.axis].label} {r.axis === 0 ? 'I' : r.axis === 1 ? 'J' : 'K'}=
                    {r.slice}，[{r.min[0]}..{r.max[0]}]×[{r.min[1]}..{r.max[1]}]（
                    {(r.max[0] - r.min[0] + 1) * (r.max[1] - r.min[1] + 1)} 体素）
                  </button>
                  <button className="danger" onClick={() => s.deleteRoi(r.id)}>
                    ×
                  </button>
                </li>
              ))}
              {s.rois.length === 0 && <li className="muted">暂无 ROI</li>}
            </ul>
          </section>
        </>
      )}
    </aside>
  );
}
