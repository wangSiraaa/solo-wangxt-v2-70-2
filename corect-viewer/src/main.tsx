import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { useStore } from './state/store';

// 说明：不使用 StrictMode —— 其开发期双重挂载会让 vtk.js 的 WebGL 上下文
// 和 Worker 解码流程重复初始化，本应用的 effect 清理虽能兜底，但没必要付出这个代价。
createRoot(document.getElementById('root')!).render(<App />);

// 供 E2E 测试与调试台检查状态
(window as unknown as { __store: typeof useStore }).__store = useStore;
