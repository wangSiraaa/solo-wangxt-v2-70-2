import { useMemo, useState } from 'react';
import { useStore } from '../state/store';
import type { ImportMode, PreviewItem, PreviewStatus } from '../format/annotations';

const STATUS_TEXT: Record<PreviewStatus, string> = {
  new: '新增',
  duplicate: '重复（跳过）',
  conflict: '同 ID 内容不同',
  invalid: '越界/非法（阻止确认）',
};

function itemTitle(item: Pick<PreviewItem, 'kind' | 'id' | 'label'>) {
  return item.label || `${item.kind === 'measurement' ? '测量' : 'ROI'} ${item.id.slice(0, 8)}`;
}

export function ImportAnnotationsModal() {
  const session = useStore((s) => s.importSession);
  const setResolution = useStore((s) => s.setAnnotationResolution);
  const confirmImport = useStore((s) => s.confirmAnnotationImport);
  const cancel = useStore((s) => s.cancelAnnotationImport);
  const [mode, setMode] = useState<ImportMode>('merge');

  const missingResolutions = useMemo(() => {
    if (!session?.preview) return [];
    return session.preview.items.filter(
      (item) => item.status === 'conflict' && item.resolutionRequired[mode] && !session.resolutions[item.key]?.trim(),
    );
  }, [session, mode]);

  if (!session) return null;
  const preview = session.preview;
  const blocked = !!session.error || !preview || !preview.canConfirm || missingResolutions.length > 0;

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-label="导入标注包预览">
        <header className="modal-header">
          <h2>导入标注包</h2>
          <button onClick={cancel} title="关闭">×</button>
        </header>

        {session.error && <div className="modal-error">{session.error}</div>}

        {preview && (
          <div className="modal-body">
            <div className="kv">
              <span>文件</span>
              <span>{session.fileName}（{session.fileSize.toLocaleString()} 字节）</span>
              <span>包版本</span>
              <span>v{preview.sourceFormatVersion}</span>
              <span>体数据校验</span>
              <span className={preview.identity.match ? 'ok' : 'error-text'}>
                {preview.identity.match ? '通过' : '不通过'}
              </span>
            </div>

            {preview.warnings.length > 0 && (
              <ul className="modal-warnings">
                {preview.warnings.map((w) => <li key={w}>{w}</li>)}
              </ul>
            )}
            {preview.errors.length > 0 && (
              <ul className="modal-errors">
                {preview.errors.map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}

            <div className="mode-row">
              <button className={mode === 'merge' ? 'active' : ''} onClick={() => setMode('merge')}>
                合并到现有标注
              </button>
              <button className={mode === 'replace' ? 'active' : ''} onClick={() => setMode('replace')}>
                替换现有标注
              </button>
            </div>

            <div className="count-row">
              <span>新增 {preview.counts.new}</span>
              <span>重复 {preview.counts.duplicate}</span>
              <span>冲突 {preview.counts.conflict}</span>
              <span>非法 {preview.counts.invalid}</span>
              <span className="muted">
                现有：测量 {preview.existingCounts.measurement} / ROI {preview.existingCounts.roi}
              </span>
            </div>

            {missingResolutions.length > 0 && (
              <div className="modal-error">请为 {missingResolutions.length} 个冲突项填写新名称后再确认。</div>
            )}

            <ul className="preview-list">
              {preview.items.map((item) => (
                <li key={item.key} className={`preview-item ${item.status}`}>
                  <div>
                    <b>{itemTitle(item)}</b>
                    <span className="muted">
                      {item.kind === 'measurement' ? '测量' : '矩形 ROI'} · {STATUS_TEXT[item.status]}
                    </span>
                    {item.issue && <span className="error-text">{item.issue}</span>}
                  </div>
                  {item.status === 'conflict' && item.resolutionRequired[mode] && (
                    <label>
                      新名称
                      <input
                        value={session.resolutions[item.key] ?? ''}
                        onChange={(e) => setResolution(item.key, e.target.value)}
                      />
                    </label>
                  )}
                  {item.status === 'conflict' && !item.resolutionRequired[mode] && mode === 'replace' && (
                    <span className="muted">替换模式下沿用包内 ID</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {session.applyError && <div className="modal-error">{session.applyError}</div>}

        <footer className="modal-footer">
          <button onClick={cancel}>取消</button>
          <button
            className="primary"
            disabled={blocked || session.applying}
            onClick={() => void confirmImport(mode)}
          >
            {session.applying ? '事务提交中…' : mode === 'merge' ? '确认合并' : '确认替换'}
          </button>
        </footer>
      </section>
    </div>
  );
}
