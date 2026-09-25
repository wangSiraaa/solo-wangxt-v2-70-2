/**
 * 生成合成岩芯样例 public/samples/synthetic-core.corevol
 *
 * 设计目标（用于验证坐标系与测量，详见 README「验证清单」）：
 * - 各向异性间距：0.5 × 0.5 × 2.0 mm（K 方向稀疏，模拟真实 CT 层厚）
 * - 验证立方体：IJK [98..102]×[28..32]×[10..14]，值 255，中心 (100,30,12) → 物理 (50,15,24) mm
 * - 标志点 A=(24,24,60)、B=(84,104,120)（值 255 小球）：
 *   体素差 (60,80,60) → 物理差 (30,40,120) mm → 距离恰为 130 mm
 * - 岩芯圆柱：IJ 面圆心 (63.5,63.5)，半径 62 体素（Ø 62 mm），轴沿 K
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIMS = [128, 128, 200];
const SPACING = [0.5, 0.5, 2.0];
const ORIGIN = [0, 0, 0];
const NAME = 'synthetic-core-aniso';

const [NI, NJ, NK] = DIMS;
const data = new Uint8Array(NI * NJ * NK);

const idx = (i, j, k) => i + NI * (j + NJ * k);

// 确定性伪随机（层理抖动用），保证多次生成结果一致
const jitter = (i, j, k) => {
  const h = ((i * 73856093) ^ (j * 19349663) ^ (k * 83492791)) >>> 0;
  return ((h % 1000) / 1000 - 0.5) * 12;
};

const CX = 63.5;
const CY = 63.5;
const RADIUS = 62;

for (let k = 0; k < NK; k++) {
  // 层理：沿 K 的正弦灰度变化
  const bedding = 96 + 28 * Math.sin((2 * Math.PI * k) / 24);
  for (let j = 0; j < NJ; j++) {
    for (let i = 0; i < NI; i++) {
      const di = i - CX;
      const dj = j - CY;
      const r = Math.sqrt(di * di + dj * dj);
      if (r > RADIUS) continue; // 岩芯外为空气（0）
      let v = bedding + jitter(i, j, k);
      // 致密夹层
      if (k >= 100 && k < 110) v += 50;
      // 张性裂隙（低值带）
      if (k >= 150 && k < 153 && r < 25) v = 30;
      data[idx(i, j, k)] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
}

// 黄铁矿结核（高密度球）
function paintSphere(ci, cj, ck, radius, value) {
  for (let k = Math.floor(ck - radius); k <= Math.ceil(ck + radius); k++) {
    for (let j = Math.floor(cj - radius); j <= Math.ceil(cj + radius); j++) {
      for (let i = Math.floor(ci - radius); i <= Math.ceil(ci + radius); i++) {
        if (i < 0 || j < 0 || k < 0 || i >= NI || j >= NJ || k >= NK) continue;
        const d = Math.sqrt((i - ci) ** 2 + (j - cj) ** 2 + (k - ck) ** 2);
        if (d <= radius) data[idx(i, j, k)] = value;
      }
    }
  }
}

paintSphere(40, 80, 60, 6, 230);
paintSphere(90, 40, 140, 8, 230);

// 验证立方体 5×5×5，中心 (100,30,12)
for (let k = 10; k <= 14; k++)
  for (let j = 28; j <= 32; j++)
    for (let i = 98; i <= 102; i++) data[idx(i, j, k)] = 255;

// 测量验证标志点（最后绘制，保证不被覆盖）
paintSphere(24, 24, 60, 3, 255); // A
paintSphere(84, 104, 120, 3, 255); // B

// ---- 写入 .corevol（格式见 src/format/corevol.ts）----
const MAGIC = [0x43, 0x4f, 0x52, 0x45, 0x56, 0x4f, 0x4c, 0x00];
const nameBytes = Buffer.from(NAME, 'utf8');
const headerSize = Math.ceil((78 + nameBytes.length) / 8) * 8;
const buffer = Buffer.alloc(headerSize + data.byteLength);
MAGIC.forEach((b, i) => (buffer[i] = b));
buffer.writeUInt16LE(1, 8); // version
buffer.writeUInt16LE(0, 10); // dtype uint8
buffer.writeUInt32LE(headerSize, 12);
buffer.writeUInt32LE(NI, 16);
buffer.writeUInt32LE(NJ, 20);
buffer.writeUInt32LE(NK, 24);
buffer.writeDoubleLE(SPACING[0], 28);
buffer.writeDoubleLE(SPACING[1], 36);
buffer.writeDoubleLE(SPACING[2], 44);
buffer.writeDoubleLE(ORIGIN[0], 52);
buffer.writeDoubleLE(ORIGIN[1], 60);
buffer.writeDoubleLE(ORIGIN[2], 68);
buffer.writeUInt16LE(nameBytes.length, 76);
nameBytes.copy(buffer, 78);
Buffer.from(data.buffer).copy(buffer, headerSize);

const out = join(dirname(fileURLToPath(import.meta.url)), '../public/samples/synthetic-core.corevol');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buffer);
console.log(`已生成 ${out}（${(buffer.length / 1024 / 1024).toFixed(2)} MB）`);
