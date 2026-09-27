# 岩芯 CT 体数据浏览器（corect-viewer）

纯浏览器端的地质岩芯 CT 体数据浏览工具：扫描资料**不出本机**，无需任何服务器处理。

- **React + TypeScript + vtk.js**：三个正交切面（水平面 K / 矢状面 I / 冠状面 J）联动显示
- **Web Worker** 解码项目约定的 `.corevol` 体素格式，主线程不卡顿
- **IndexedDB** 保存工程（原始体数据文件）与标注（测量、ROI、十字丝位置、显示设置、导入来源摘要），刷新页面后完整恢复
- JSON 标注包导入/导出：格式版本、体数据 SHA-256 摘要、尺寸、间距、原点和 IJK 坐标系随包校验；预览新增、重复、冲突和越界项，确认时一次 IndexedDB 事务提交
- 距离测量按**体素物理间距**（各向异性）计算
- 矩形 ROI 框选：体素计数 + 阈值预览（掩膜高亮 + 统计）

## 快速开始

```bash
npm install
npm run sample   # 重新生成合成岩芯样例（可选，已随仓库生成）
npm run dev      # 开发服务器
npm run test     # 单元测试 + 合成岩芯验收测试
npm run build    # 生产构建
```

打开页面后点击「加载样例」。首版仅支持随项目提供的小体积样例（体素总数 ≤ 6400 万）。

## `.corevol` 文件格式（v1，小端序）

| 偏移 | 大小 | 类型 | 字段 |
|---|---|---|---|
| 0 | 8 | char[8] | 魔数 `"COREVOL\0"` |
| 8 | 2 | u16 | 格式版本 = 1 |
| 10 | 2 | u16 | 数值类型：0=uint8 1=int8 2=uint16 3=int16 4=uint32 5=int32 6=float32 7=float64 |
| 12 | 4 | u32 | headerSize：文件头总字节数（体素数据起始偏移，须为 8 的倍数） |
| 16 | 12 | 3×u32 | dims = [I, J, K] 体素维度 |
| 28 | 24 | 3×f64 | spacing = [sx, sy, sz] 体素物理间距（mm） |
| 52 | 24 | 3×f64 | origin = [ox, oy, oz] 物理原点（mm） |
| 76 | 2 | u16 | 工程名 UTF-8 字节数 N |
| 78 | N | char | 工程名（UTF-8） |
| … | | | 零填充至 headerSize |
| headerSize | … | | 体素数据，**I 方向变化最快**（x 最快、z 最慢），行主序 |

解码器（`src/format/corevol.ts`，在 Web Worker 中运行）校验：魔数、版本、数值类型、
headerSize 对齐、维度合法且 ≤ 上限、间距为正有限数、文件总字节数精确匹配。

## 合成岩芯样例与验证清单

`public/samples/synthetic-core.corevol`（128×128×200，uint8，**各向异性**间距 0.5×0.5×2.0 mm），
由 `scripts/generate-sample.mjs` 生成。内置已知几何标志，用于验证坐标与测量：

| 验证项 | 标志 | 期望值 |
|---|---|---|
| 坐标换算 | 高亮立方体中心 IJK = (100, 30, 12) | 状态栏物理坐标 = (50.00, 15.00, 24.00) mm |
| 坐标一致性 | 十字丝移到 (100, 30, 12) | 三个切面同时显示立方体截面（5×5 亮块） |
| 距离测量 | 标志点 A=(24,24,60)、B=(84,104,120)（亮球） | 测量距离 = **130.00 mm**（体素差 (60,80,60) × 间距 = 物理差 (30,40,120)） |
| 各向异性 | K 方向滚轮换一层 | 状态栏物理 Z 变化 2.00 mm；I/J 方向 1 体素 = 0.50 mm |
| ROI 统计 | K=12 层框选立方体截面 [98..102]×[28..32] | 体素总数 = 25，阈值 ≥200 计数 = 25，均值 = 255 |
| 持久化 | 添加测量/ROI 后刷新页面 | 标注、十字丝位置完整恢复 |

以上全部有自动化测试覆盖（`src/format/sample.test.ts` 等，共 42 例）。

## JSON 标注包（v1）

侧栏「标注包」可导出当前测量、矩形 ROI、十字丝、窗宽窗位和 ROI 阈值。包内包含：

- `format = "corect-annotation-pack"`、`formatVersion = 1` 和导出时间
- `volumeIdentity`：dtype、dims、spacing、origin、voxelCount、voxelByteLength，以及几何参数 + 原始体素字节的 SHA-256
- `coordinateSystem`：0-based、I 最快变化、轴顺序 I/J/K、各轴 mm 间距与物理原点
- `annotations` 和 `displaySettings`

导入时先做只读预览：

1. 体数据摘要完全匹配才允许提交；尺寸相同但体素内容不同会被阻止。
2. 相同唯一键且内容相同的项幂等跳过；相同唯一键但内容不同，合并模式保留双方并要求重命名。
3. 任何越界坐标（包括十字丝）都会阻断确认；用户确认前不写 IndexedDB。
4. 可选择合并或替换。最终写入通过单个 `annotations` readwrite 事务完成，失败则回滚，并在记录中追加最多 20 条导入来源摘要。
5. 旧版 v0 包可在尺寸、间距和原点匹配时迁移，但旧包没有体素内容摘要，必须在预览中显式确认；更高版本或出现当前程序无法理解的必填字段时明确拒绝。

## 操作说明

- **浏览工具**：拖动定位十字丝（三视图同步）；滚轮在该视图换层
- **测量工具**：依次点击两点（可跨不同视图点击），生成距离标注（mm）
- **框选 ROI**：在某层拖出矩形，侧栏显示体素总数、≥阈值数量、min/max/均值；
  调节阈值滑块时当前层以红色掩膜预览 ≥ 阈值的体素
- 侧栏可切换/删除工程、调窗宽窗位、管理标注列表

## 数据持久化

- `projects` 对象仓库：原始 `.corevol` 文件（刷新后重新解码恢复体数据）
- `annotations` 对象仓库：测量、ROI、十字丝位置、显示设置和导入来源摘要（普通编辑变更后 300ms 防抖写入；导入确认使用单独事务一次性提交）
- `localStorage` 记录最后打开的工程 id，启动时自动恢复

## 目录结构

```
src/
  format/corevol.ts          # 体数据格式定义 + 编解码纯函数
  format/annotationPack.ts   # JSON 标注包、体数据摘要、预览与提交计划
  workers/                 # Web Worker 解码及主线程封装
  geometry/viewMath.ts     # IJK↔物理坐标、切面相机模型、屏幕映射、测距
  geometry/roi.ts          # ROI 统计（体素计数 / 阈值预览）
  db/projectDb.ts          # IndexedDB（idb 封装）
  state/store.ts           # zustand 全局状态 + 持久化订阅
  components/SliceView.tsx # 正交切面视图（vtk.js 渲染 + Canvas 叠加交互）
scripts/generate-sample.mjs # 合成岩芯样例生成器
```
