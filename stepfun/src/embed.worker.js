/**
 * 端侧向量化 Worker
 *
 * 在独立线程里跑 ONNX Runtime Web，避免主线程卡顿。
 * 模型：onnx-community/bge-small-zh-v1.5-ONNX（中文优化，512 维，q8 量化）
 * 权重从魔搭社区拉取（huggingface.co 国内直连不通，hf-mirror 限流）
 */
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.remoteHost = 'https://modelscope.cn/models';
env.remotePathTemplate = '{model}/resolve/master/';

const MODEL = 'onnx-community/bge-small-zh-v1.5-ONNX';
const DIM = 512;

let extractorPromise = null;

function getExtractor(onProgress) {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODEL, {
      dtype: 'q8', // 量化：体积和延迟都显著下降
      progress_callback: onProgress,
    });
  }
  return extractorPromise;
}

async function embed(texts) {
  const ex = await getExtractor();
  // BGE 系列用 CLS 池化（官方推荐）；mean 池化会稀释关键词特征
  const out = await ex(texts, { pooling: 'cls', normalize: true });
  const [n, dim] = out.dims;
  const flat = Array.from(out.data);

  const vectors = [];
  for (let i = 0; i < n; i++) {
    vectors.push(flat.slice(i * dim, (i + 1) * dim));
  }
  return { vectors, dim };
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data || {};
  try {
    if (type === 'load') {
      const t0 = performance.now();
      await getExtractor((p) => {
        // 只透传下载进度，避免刷屏
        if (p && (p.status === 'progress' || p.status === 'done')) {
          self.postMessage({ type: 'progress', payload: { status: p.status, file: p.file, progress: p.progress } });
        }
      });
      const loadMs = performance.now() - t0;

      // 预热：首次推理会创建 ONNX session，把这段开销挪到加载阶段，
      // 否则第一次查询要等十几秒
      const t1 = performance.now();
      await embed(['预热']);
      const warmMs = performance.now() - t1;

      self.postMessage({ id, ok: true, dim: DIM, loadMs, warmMs });
      return;
    }

    if (type === 'embed') {
      const t0 = performance.now();
      const { vectors, dim } = await embed(payload.texts);
      const ms = performance.now() - t0;
      self.postMessage({ id, ok: true, vectors, dim, ms });
      return;
    }

    self.postMessage({ id, ok: false, error: '未知消息类型: ' + type });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
