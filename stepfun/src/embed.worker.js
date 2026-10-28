/**
 * 端侧向量化 Worker
 *
 * 在独立线程里跑 ONNX Runtime Web（Transformers.js），避免主线程卡顿。
 * 模型：onnx-community/bge-small-zh-v1.5-ONNX（中文优化，512 维）
 *   权重从魔搭社区拉取（huggingface.co 国内直连不通，hf-mirror 限流）
 *
 * 推理后端（赛题 2.2.4）：
 *   1) 优先 WebGPU（显式 device='webgpu'，FP16 权重 model_fp16.onnx）
 *   2) 当前环境不支持 WebGPU 或初始化失败时，自动降级 WASM（INT8 权重 model_quantized.onnx），
 *      并把降级原因回传主线程，在界面上明确提示当前后端
 *   3) 可通过 ?device=wasm / ?device=webgpu 强制指定，用于验证两条路径
 */
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.remoteHost = 'https://modelscope.cn/models';
env.remotePathTemplate = '{model}/resolve/master/';

const MODEL = 'onnx-community/bge-small-zh-v1.5-ONNX';
const DIM = 512;

let extractorPromise = null;
let backend = { device: 'unknown', dtype: 'unknown', loadMs: 0, warmMs: 0, fallbackReason: '' };

function webgpuSupported() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

async function embedTexts(extractor, texts) {
  // BGE 系列用 CLS 池化（官方推荐）；mean 池化会稀释关键词特征
  const out = await extractor(texts, { pooling: 'cls', normalize: true });
  const [n, dim] = out.dims;
  const flat = Array.from(out.data);
  const vectors = [];
  for (let i = 0; i < n; i++) vectors.push(flat.slice(i * dim, (i + 1) * dim));
  return { vectors, dim };
}

async function build(device, dtype, onProgress) {
  const t0 = performance.now();
  const extractor = await pipeline('feature-extraction', MODEL, {
    device,
    dtype, // q8: INT8 量化；fp16: 半精度
    progress_callback: onProgress,
  });
  const loadMs = performance.now() - t0;

  // 预热：首次推理才真正建 ONNX 会话，把这段开销从用户查询路径挪到加载阶段。
  // 用「短文本 + 接近真实查询长度」各跑一次：不同序列长度会触发不同的图/着色器编译，
  // 只预热短文本时第一次真实查询仍会卡一下（实测 ~400ms）。
  const t1 = performance.now();
  await embedTexts(extractor, ['预热']);
  await embedTexts(extractor, ['预热：端侧向量化与 seekdb 混合检索性能测试，覆盖一次接近真实查询长度的推理。']);
  const warmMs = performance.now() - t1;
  return { extractor, loadMs, warmMs };
}

function progressForwarder(onProgress) {
  return (p) => {
    if (p && (p.status === 'progress' || p.status === 'done')) {
      onProgress({ type: 'progress', payload: { status: p.status, file: p.file, progress: p.progress } });
    }
  };
}

/**
 * 建立端侧推理管线（单例）。
 * @param {{device?: 'auto'|'webgpu'|'wasm', onProgress?: function}} opts
 */
function getExtractor(opts) {
  if (extractorPromise) return extractorPromise;
  const force = opts?.device || 'auto';
  const onProgress = opts?.onProgress || (() => {});
  extractorPromise = (async () => {
    if (force !== 'wasm' && webgpuSupported()) {
      try {
        const r = await build('webgpu', 'fp16', progressForwarder(onProgress));
        backend = { device: 'webgpu', dtype: 'fp16', fallbackReason: '', loadMs: r.loadMs, warmMs: r.warmMs };
        return r.extractor;
      } catch (e) {
        // WebGPU 初始化失败（驱动/算子不支持等）→ 自动降级 WASM
        backend.fallbackReason = 'WebGPU 初始化失败：' + String(e?.message || e).slice(0, 200);
      }
    } else if (force === 'wasm') {
      backend.fallbackReason = '按测试参数强制 WASM（用于验证降级路径）';
    } else {
      backend.fallbackReason = '当前环境不支持 WebGPU（navigator.gpu 不存在）';
    }

    const r = await build('wasm', 'q8', progressForwarder(onProgress));
    backend = {
      device: 'wasm',
      dtype: 'q8',
      fallbackReason: backend.fallbackReason,
      loadMs: r.loadMs,
      warmMs: r.warmMs,
    };
    return r.extractor;
  })();
  return extractorPromise;
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data || {};
  try {
    if (type === 'load') {
      const opts = { device: payload?.device || 'auto', onProgress: (m) => self.postMessage(m) };
      const t0 = performance.now();
      await getExtractor(opts);
      const loadWaitMs = performance.now() - t0;
      self.postMessage({
        id,
        ok: true,
        dim: DIM,
        device: backend.device,
        dtype: backend.dtype,
        backend: backend.device === 'webgpu' ? 'WebGPU' : 'WASM',
        loadMs: backend.loadMs,
        warmMs: backend.warmMs,
        loadWaitMs,
        fallbackReason: backend.fallbackReason,
      });
      return;
    }

    if (type === 'embed') {
      const extractor = await getExtractor({ device: payload?.device || 'auto', onProgress: (m) => self.postMessage(m) });
      const t0 = performance.now();
      const { vectors, dim } = await embedTexts(extractor, payload.texts);
      const ms = performance.now() - t0;
      self.postMessage({
        id,
        ok: true,
        vectors,
        dim,
        ms,
        device: backend.device,
        dtype: backend.dtype,
      });
      return;
    }

    self.postMessage({ id, ok: false, error: '未知消息类型: ' + type });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
