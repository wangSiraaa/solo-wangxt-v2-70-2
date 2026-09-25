import { useStore } from '../state/store';
import { ijkToWorld, voxelIndex } from '../geometry/viewMath';

export function StatusBar() {
  const volume = useStore((s) => s.volume);
  const crosshair = useStore((s) => s.crosshair);
  const projectName = useStore((s) => s.projectName);
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);

  if (status === 'error') {
    return <footer className="status-bar error">错误：{error}</footer>;
  }
  if (!volume) {
    return <footer className="status-bar">{status === 'loading' ? '解码中…' : '未加载工程'}</footer>;
  }
  const { spacing, origin, dims } = volume.header;
  const world = ijkToWorld(crosshair, spacing, origin);
  const value = volume.data[voxelIndex(crosshair, dims)];
  return (
    <footer className="status-bar">
      <span>{projectName}</span>
      <span>
        IJK = ({crosshair[0]}, {crosshair[1]}, {crosshair[2]})
      </span>
      <span>
        物理坐标 = ({world[0].toFixed(2)}, {world[1].toFixed(2)}, {world[2].toFixed(2)}) mm
      </span>
      <span>值 = {value}</span>
    </footer>
  );
}
