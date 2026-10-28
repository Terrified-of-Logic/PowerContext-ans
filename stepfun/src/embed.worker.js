/**
 * 端侧向量化 Worker
 *
 * 推理后端策略（验收要求「后端与降级」）：
 *   1. 优先尝试 WebGPU
 *   2. 不可用或初始化失败时自动降级到 WASM
 *   3. 把实际使用的后端回报给主线程，由界面明确提示
 *
 * 模型：onnx-community/bge-small-zh-v1.5-ONNX（中文，512 维，q8 量化 = INT8）
 * 权重来自魔搭社区（huggingface.co 国内直连不通）
 */
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.remoteHost = 'https://modelscope.cn/models';
env.remotePathTemplate = '{model}/resolve/master/';

const MODEL = 'onnx-community/bge-small-zh-v1.5-ONNX';
const DIM = 512;

let extractorPromise = null;
let backend = 'unknown';

/** 检测浏览器是否具备 WebGPU 能力 */
async function detectWebGPU() {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return { ok: false, reason: '浏览器未提供 navigator.gpu' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: '未取得 GPUAdapter（可能无独显或被禁用）' };
    return { ok: true, reason: 'WebGPU 可用' };
  } catch (e) {
    return { ok: false, reason: '请求适配器失败：' + (e?.message || e) };
  }
}

async function load(device, onProgress) {
  return pipeline('feature-extraction', MODEL, {
    device,
    dtype: 'q8',           // INT8 量化
    progress_callback: onProgress,
  });
}

async function getExtractor(onProgress, onBackend) {
  if (extractorPromise) return extractorPromise;

  extractorPromise = (async () => {
    // ---- 第一优先：WebGPU ----
    const gpu = await detectWebGPU();
    if (gpu.ok) {
      try {
        onBackend({ backend: 'webgpu', degraded: false, detail: 'WebGPU 可用，已选用 GPU 后端' });
        const ex = await load('webgpu', onProgress);
        backend = 'webgpu';
        return ex;
      } catch (e) {
        // WebGPU 初始化失败 → 降级
        onBackend({
          backend: 'wasm',
          degraded: true,
          detail: `WebGPU 初始化失败（${String(e?.message || e).slice(0, 80)}），已自动降级到 WASM`,
        });
      }
    } else {
      onBackend({
        backend: 'wasm',
        degraded: true,
        detail: `${gpu.reason}，已自动降级到 WASM`,
      });
    }

    // ---- 降级：WASM ----
    const ex = await load('wasm', onProgress);
    backend = 'wasm';
    return ex;
  })();

  return extractorPromise;
}

async function embed(texts) {
  const ex = await getExtractor();
  // BGE 系列用 CLS 池化（官方推荐）
  const out = await ex(texts, { pooling: 'cls', normalize: true });
  const [n, dim] = out.dims;
  const flat = Array.from(out.data);

  const vectors = [];
  for (let i = 0; i < n; i++) vectors.push(flat.slice(i * dim, (i + 1) * dim));
  return { vectors, dim };
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data || {};
  try {
    if (type === 'load') {
      const t0 = performance.now();
      const note = [];
      await getExtractor(
        (p) => {
          if (p && (p.status === 'progress' || p.status === 'done')) {
            self.postMessage({ type: 'progress', payload: { status: p.status, file: p.file, progress: p.progress } });
          }
        },
        (info) => {
          note.push(info);
          self.postMessage({ type: 'backend', payload: info });
        }
      );
      const loadMs = performance.now() - t0;

      // 预热：把 ONNX 会话初始化的开销挪到加载阶段
      const t1 = performance.now();
      await embed(['预热']);
      const warmMs = performance.now() - t1;

      self.postMessage({
        id, ok: true, dim: DIM, loadMs, warmMs,
        backend,
        fallbackNotes: note,
      });
      return;
    }

    if (type === 'embed') {
      const t0 = performance.now();
      const { vectors, dim } = await embed(payload.texts);
      const ms = performance.now() - t0;
      self.postMessage({ id, ok: true, vectors, dim, ms, backend });
      return;
    }

    self.postMessage({ id, ok: false, error: '未知消息类型: ' + type });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
