/**
 * .corevol 体素文件格式（v1，小端序）
 *
 * 偏移  大小  类型      字段
 * 0     8     char[8]   魔数 "COREVOL\0"
 * 8     2     u16       格式版本 = 1
 * 10    2     u16       数值类型 dtype（见 DType）
 * 12    4     u32       headerSize：文件头总字节数（体素数据起始偏移，必须是 8 的倍数）
 * 16    12    3×u32     dims    [I, J, K] 体素维度
 * 28    24    3×f64     spacing [sx, sy, sz] 体素物理间距（mm）
 * 52    24    3×f64     origin  [ox, oy, oz] 物理原点（mm）
 * 76    2     u16       nameLength 工程名 UTF-8 字节数
 * 78    N     char      工程名（UTF-8）
 * ...         零填充至 headerSize
 * headerSize  …         体素数据，I 方向变化最快（x 最快，z 最慢），行主序
 *
 * 首版限制：仅支持小体积样例（体素总数 ≤ MAX_VOXELS）。
 */

export const COREVOL_MAGIC = [0x43, 0x4f, 0x52, 0x45, 0x56, 0x4f, 0x4c, 0x00] as const;
export const COREVOL_VERSION = 1;
export const FIXED_HEADER_SIZE = 78;
export const MAX_HEADER_SIZE = 4096;
/** 首版仅支持小体积：最多 6400 万体素 */
export const MAX_VOXELS = 64_000_000;

export const DType = {
  UInt8: 0,
  Int8: 1,
  UInt16: 2,
  Int16: 3,
  UInt32: 4,
  Int32: 5,
  Float32: 6,
  Float64: 7,
} as const;
export type DType = (typeof DType)[keyof typeof DType];

export type VoxelArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

interface DTypeInfo {
  bytes: number;
  label: string;
  create: (buffer: ArrayBuffer, byteOffset: number, length: number) => VoxelArray;
}

export const DTYPE_INFO: Record<DType, DTypeInfo> = {
  [DType.UInt8]: { bytes: 1, label: 'uint8', create: (b, o, n) => new Uint8Array(b, o, n) },
  [DType.Int8]: { bytes: 1, label: 'int8', create: (b, o, n) => new Int8Array(b, o, n) },
  [DType.UInt16]: { bytes: 2, label: 'uint16', create: (b, o, n) => new Uint16Array(b, o, n) },
  [DType.Int16]: { bytes: 2, label: 'int16', create: (b, o, n) => new Int16Array(b, o, n) },
  [DType.UInt32]: { bytes: 4, label: 'uint32', create: (b, o, n) => new Uint32Array(b, o, n) },
  [DType.Int32]: { bytes: 4, label: 'int32', create: (b, o, n) => new Int32Array(b, o, n) },
  [DType.Float32]: { bytes: 4, label: 'float32', create: (b, o, n) => new Float32Array(b, o, n) },
  [DType.Float64]: { bytes: 8, label: 'float64', create: (b, o, n) => new Float64Array(b, o, n) },
};

export type Vec3 = [number, number, number];

export interface CorevolHeader {
  version: number;
  dtype: DType;
  dims: Vec3;
  spacing: Vec3;
  origin: Vec3;
  name: string;
  headerSize: number;
}

export interface DecodedVolume {
  header: CorevolHeader;
  /** 体素数据（视图，底层 buffer 可转移） */
  data: VoxelArray;
  voxelCount: number;
  min: number;
  max: number;
}

export function dtypeLabel(dtype: DType): string {
  return DTYPE_INFO[dtype].label;
}

function readMagic(view: DataView): boolean {
  for (let i = 0; i < 8; i++) {
    if (view.getUint8(i) !== COREVOL_MAGIC[i]) return false;
  }
  return true;
}

/** 解码并校验 .corevol 文件，失败抛出带中文说明的 Error。 */
export function decodeCorevol(buffer: ArrayBuffer): DecodedVolume {
  if (buffer.byteLength < FIXED_HEADER_SIZE) {
    throw new Error(`文件太小（${buffer.byteLength} 字节），不是有效的 .corevol 文件`);
  }
  const view = new DataView(buffer);
  if (!readMagic(view)) {
    throw new Error('魔数不匹配：不是 .corevol 体素文件');
  }
  const version = view.getUint16(8, true);
  if (version !== COREVOL_VERSION) {
    throw new Error(`不支持的格式版本 ${version}（本工具支持 v${COREVOL_VERSION}）`);
  }
  const dtype = view.getUint16(10, true) as DType;
  const info = DTYPE_INFO[dtype];
  if (!info) {
    throw new Error(`未知的数值类型代码 ${dtype}`);
  }
  const headerSize = view.getUint32(12, true);
  if (headerSize < FIXED_HEADER_SIZE || headerSize > MAX_HEADER_SIZE || headerSize % 8 !== 0) {
    throw new Error(`非法的文件头大小 ${headerSize}`);
  }
  const dims: Vec3 = [view.getUint32(16, true), view.getUint32(20, true), view.getUint32(24, true)];
  if (dims.some((d) => d < 1)) {
    throw new Error(`非法维度 [${dims.join(', ')}]`);
  }
  const voxelCount = dims[0] * dims[1] * dims[2];
  if (voxelCount > MAX_VOXELS) {
    throw new Error(
      `体素总数 ${voxelCount.toLocaleString()} 超出首版上限 ${MAX_VOXELS.toLocaleString()}（仅支持小体积样例）`,
    );
  }
  const spacing: Vec3 = [view.getFloat64(28, true), view.getFloat64(36, true), view.getFloat64(44, true)];
  if (spacing.some((s) => !Number.isFinite(s) || s <= 0)) {
    throw new Error(`非法体素间距 [${spacing.join(', ')}]`);
  }
  const origin: Vec3 = [view.getFloat64(52, true), view.getFloat64(60, true), view.getFloat64(68, true)];
  const nameLength = view.getUint16(76, true);
  if (FIXED_HEADER_SIZE + nameLength > headerSize) {
    throw new Error('工程名超出文件头边界');
  }
  const name = new TextDecoder().decode(new Uint8Array(buffer, FIXED_HEADER_SIZE, nameLength));

  const dataBytes = voxelCount * info.bytes;
  if (headerSize + dataBytes !== buffer.byteLength) {
    throw new Error(
      `文件大小校验失败：期望 ${headerSize + dataBytes} 字节，实际 ${buffer.byteLength} 字节`,
    );
  }
  const data = info.create(buffer, headerSize, voxelCount);

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  return {
    header: { version, dtype, dims, spacing, origin, name, headerSize },
    data,
    voxelCount,
    min,
    max,
  };
}

/** 编码为 .corevol 文件（用于测试与样例生成脚本参考）。 */
export function encodeCorevol(
  header: Omit<CorevolHeader, 'version' | 'headerSize'>,
  data: VoxelArray,
): ArrayBuffer {
  const nameBytes = new TextEncoder().encode(header.name);
  if (nameBytes.length > 65535) throw new Error('工程名过长');
  const headerSize = Math.ceil((FIXED_HEADER_SIZE + nameBytes.length) / 8) * 8;
  const total = headerSize + data.byteLength;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  COREVOL_MAGIC.forEach((b, i) => view.setUint8(i, b));
  view.setUint16(8, COREVOL_VERSION, true);
  view.setUint16(10, header.dtype, true);
  view.setUint32(12, headerSize, true);
  view.setUint32(16, header.dims[0], true);
  view.setUint32(20, header.dims[1], true);
  view.setUint32(24, header.dims[2], true);
  view.setFloat64(28, header.spacing[0], true);
  view.setFloat64(36, header.spacing[1], true);
  view.setFloat64(44, header.spacing[2], true);
  view.setFloat64(52, header.origin[0], true);
  view.setFloat64(60, header.origin[1], true);
  view.setFloat64(68, header.origin[2], true);
  view.setUint16(76, nameBytes.length, true);
  new Uint8Array(buffer, FIXED_HEADER_SIZE, nameBytes.length).set(nameBytes);
  new Uint8Array(buffer, headerSize, data.byteLength).set(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  );
  return buffer;
}
