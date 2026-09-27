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
  const volumeFileRef = useRef<HTMLInputElement>(null);
  const annotationFileRef = useRef<HTMLInputElement>(null);
  const s = useStore();

  const activeRoi = s.rois.find((r) => r.id === s.activeRoiId) ?? null;
  const roiStats =
    activeRoi && s.volume
      ? computeRoiStats(s.volume.data, s.volume.header.dims, activeRoi, s.threshold)
      : null;

  const run = (action: () => Promise<void>) => {
    action().catch((err: unknown) => {
      useStore.setState({ error: err instanceof Error ? err.message : String(err) });
    });
  };

  return (
    <aside className="side-panel">
      <section>
        <h3>工程</h3>
        <div className="btn-row">
          <button onClick={() => void s.loadSample()}>加载样例</button>
          <button onClick={() => volumeFileRef.current?.click()}>导入 .corevol</button>
          <input
            ref={volumeFileRef}
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
            <h3>标注包</h3>
            <div className="btn-row">
              <button onClick={() => run(s.exportAnnotations)}>导出 JSON</button>
              <button onClick={() => annotationFileRef.current?.click()}>导入标注包</button>
              <input
                ref={annotationFileRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) run(() => s.previewAnnotationImport(f));
                  e.target.value = '';
                }}
              />
            </div>
            <p className="muted">导出包含测量、ROI、十字丝、窗宽窗位、ROI 阈值、体数据 SHA-256 摘要和 IJK 坐标系。</p>
            {s.importHistory.length > 0 && (
              <div className="kv import-history">
                <span>上次导入</span>
                <span title={s.importHistory.at(-1)?.fileName}>
                  {s.importHistory.at(-1)?.fileName} · {s.importHistory.at(-1)?.mode === 'merge' ? '合并' : '替换'}
                </span>
                <span>导入结果</span>
                <span>
                  新增 {s.importHistory.at(-1)?.added}，跳过 {s.importHistory.at(-1)?.skippedDuplicates}
                  ，重命名 {s.importHistory.at(-1)?.renamedConflicts}
                </span>
              </div>
            )}
          </section>

          {s.importPreview && <ImportPreview />}

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

function ImportPreview() {
  const s = useStore();
  const preview = s.importPreview!;
  const blockers = preview.problems;
  const canConfirm =
    preview.canCommit &&
    (!preview.acceptLegacyRequired || s.acceptLegacyImport) &&
    !hasOutgoingConflictsResolved(preview, s.importResolutions, s.importMode);
  const grouped = {
    new: preview.items.filter((i) => i.status === 'new'),
    duplicate: preview.items.filter((i) => i.status === 'duplicate'),
    conflict: preview.items.filter((i) => i.status === 'conflict'),
    'out-of-bounds': preview.items.filter((i) => i.status === 'out-of-bounds'),
  };

  return (
    <section className="import-preview">
      <h3>导入预览：{s.importFileName}</h3>
      <div className={`identity ${preview.identityStatus}`}>{preview.identityMessage}</div>

      <div className="import-modes">
        <label>
          <input
            type="radio"
            checked={s.importMode === 'merge'}
            onChange={() => void s.setImportMode('merge')}
          />
          合并：保留现有标注
        </label>
        <label>
          <input
            type="radio"
            checked={s.importMode === 'replace'}
            onChange={() => void s.setImportMode('replace')}
          />
          替换：清空当前测量和 ROI
        </label>
      </div>

      <div className="preview-counts">
        <span className="new">新增 {preview.counts.new}</span>
        <span className="duplicate">重复跳过 {preview.counts.duplicate}</span>
        <span className="conflict">冲突 {preview.counts.conflict}</span>
        <span className="invalid">越界 {preview.counts['out-of-bounds']}</span>
      </div>

      {preview.acceptLegacyRequired && (
        <label className="legacy-check">
          <input
            type="checkbox"
            checked={s.acceptLegacyImport}
            onChange={(e) => s.setAcceptLegacyImport(e.target.checked)}
          />
          我理解这是旧版 v0 包，无法校验体素内容摘要；几何匹配时仍按迁移导入。
        </label>
      )}

      {blockers.length > 0 && (
        <ul className="problem-list">
          {blockers.map((p, i) => (
            <li key={`${p.kind}-${p.id ?? i}`}>{p.message}</li>
          ))}
        </ul>
      )}

      {(grouped.conflict.length > 0 || grouped['out-of-bounds'].length > 0) && (
        <ul className="preview-items">
          {[...grouped.conflict, ...grouped['out-of-bounds']].map((item) => {
            const needsRename = item.collisionInPackage || s.importMode === 'merge';
            const resolved = s.importResolutions[item.key] ?? '';
            return (
              <li key={`${item.key}-${item.label}`}>
                <div>
                  <b>{item.status === 'out-of-bounds' ? '越界' : '冲突'}：</b>
                  {item.label}
                  <div className="muted">{item.reason}</div>
                </div>
                {item.status === 'conflict' && needsRename && (
                  <input
                    aria-label={`重命名 ${item.label}`}
                    value={resolved}
                    onChange={(e) => s.setImportResolution(item.key, e.target.value)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="btn-row">
        <button disabled={!canConfirm} onClick={() => void s.confirmAnnotationImport()}>
          确认{s.importMode === 'merge' ? '合并' : '替换'}
        </button>
        <button onClick={s.cancelAnnotationImport}>取消</button>
      </div>
      {!canConfirm && (
        <p className="muted">存在越界、摘要不匹配、未处理的重命名或未确认的旧版迁移时，不会写入任何数据。</p>
      )}
    </section>
  );
}

function hasOutgoingConflictsResolved(
  preview: NonNullable<ReturnType<typeof useStore.getState>['importPreview']>,
  resolutions: Record<string, string>,
  mode: 'merge' | 'replace',
): boolean {
  const usedIds = new Set<string>();
  for (const item of preview.items) {
    if (item.status !== 'conflict') continue;
    const needsRename = item.collisionInPackage || mode === 'merge';
    if (!needsRename) continue;
    const nextId = resolutions[item.key]?.trim();
    if (!nextId || usedIds.has(`${item.kind}:${nextId}`)) return true;
    usedIds.add(`${item.kind}:${nextId}`);
  }
  return false;
}
