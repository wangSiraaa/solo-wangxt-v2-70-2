import { describe, expect, it } from 'vitest';
import {
  COREVOL_VERSION,
  DType,
  MAX_VOXELS,
  decodeCorevol,
  encodeCorevol,
} from './corevol';

function makeVolume(dtype: DType, data: number[]) {
  const dims: [number, number, number] = [data.length, 1, 1];
  const typed =
    dtype === DType.UInt8
      ? new Uint8Array(data)
      : dtype === DType.Int16
        ? new Int16Array(data)
        : dtype === DType.UInt16
          ? new Uint16Array(data)
          : dtype === DType.Float32
            ? new Float32Array(data)
            : new Float64Array(data);
  return encodeCorevol(
    { dtype, dims, spacing: [0.5, 0.5, 2.0], origin: [0, 0, 0], name: '测试体' },
    typed,
  );
}

describe('corevol 编解码', () => {
  it('往返一致（uint8）', () => {
    const buf = makeVolume(DType.UInt8, [0, 1, 127, 255]);
    const vol = decodeCorevol(buf);
    expect(vol.header.version).toBe(COREVOL_VERSION);
    expect(vol.header.dtype).toBe(DType.UInt8);
    expect(vol.header.dims).toEqual([4, 1, 1]);
    expect(vol.header.spacing).toEqual([0.5, 0.5, 2.0]);
    expect(vol.header.name).toBe('测试体');
    expect(Array.from(vol.data)).toEqual([0, 1, 127, 255]);
    expect(vol.min).toBe(0);
    expect(vol.max).toBe(255);
  });

  it('往返一致（int16 / uint16 / float32 / float64）', () => {
    expect(Array.from(decodeCorevol(makeVolume(DType.Int16, [-100, 32000])).data)).toEqual([
      -100, 32000,
    ]);
    expect(Array.from(decodeCorevol(makeVolume(DType.UInt16, [0, 65535])).data)).toEqual([
      0, 65535,
    ]);
    const f32 = decodeCorevol(makeVolume(DType.Float32, [1.5, -2.25]));
    expect(Array.from(f32.data as Float32Array)).toEqual([1.5, -2.25]);
    expect(decodeCorevol(makeVolume(DType.Float64, [Math.PI])).data[0]).toBeCloseTo(Math.PI);
  });

  it('拒绝错误魔数', () => {
    const buf = makeVolume(DType.UInt8, [1, 2, 3]);
    new Uint8Array(buf)[0] = 0x58;
    expect(() => decodeCorevol(buf)).toThrow(/魔数/);
  });

  it('拒绝错误版本', () => {
    const buf = makeVolume(DType.UInt8, [1, 2, 3]);
    new DataView(buf).setUint16(8, 99, true);
    expect(() => decodeCorevol(buf)).toThrow(/版本/);
  });

  it('拒绝未知数值类型', () => {
    const buf = makeVolume(DType.UInt8, [1, 2, 3]);
    new DataView(buf).setUint16(10, 42, true);
    expect(() => decodeCorevol(buf)).toThrow(/数值类型/);
  });

  it('拒绝文件大小不符', () => {
    const buf = makeVolume(DType.UInt8, [1, 2, 3]);
    expect(() => decodeCorevol(buf.slice(0, buf.byteLength - 1))).toThrow(/大小/);
  });

  it('拒绝非法间距', () => {
    const buf = makeVolume(DType.UInt8, [1, 2, 3]);
    new DataView(buf).setFloat64(28, 0, true);
    expect(() => decodeCorevol(buf)).toThrow(/间距/);
  });

  it('拒绝超出首版体积上限', () => {
    // 构造一个声明维度超大但数据区合法的假文件：直接改维度字段，
    // 让 voxelCount 超限即可（大小校验在维度校验之后）
    const buf = encodeCorevol(
      { dtype: DType.UInt8, dims: [1, 1, 1], spacing: [1, 1, 1], origin: [0, 0, 0], name: '' },
      new Uint8Array(1),
    );
    const view = new DataView(buf);
    view.setUint32(16, MAX_VOXELS + 1, true);
    expect(() => decodeCorevol(buf)).toThrow(/上限/);
  });

  it('headerSize 8 字节对齐（float32/float64 视图要求）', () => {
    const buf = makeVolume(DType.Float64, [1, 2]);
    const headerSize = new DataView(buf).getUint32(12, true);
    expect(headerSize % 8).toBe(0);
  });
});
