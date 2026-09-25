/// <reference lib="webworker" />
import { decodeCorevol } from '../format/corevol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

export interface DecodeSuccess {
  ok: true;
  volume: ReturnType<typeof decodeCorevol>;
}

export interface DecodeFailure {
  ok: false;
  error: string;
}

scope.onmessage = (e: MessageEvent<ArrayBuffer>) => {
  try {
    const volume = decodeCorevol(e.data);
    // 体素数据是输入 buffer 上的视图，整体零拷贝转回主线程
    scope.postMessage({ ok: true, volume } satisfies DecodeSuccess, [
      volume.data.buffer as ArrayBuffer,
    ]);
  } catch (err) {
    scope.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies DecodeFailure);
  }
};
