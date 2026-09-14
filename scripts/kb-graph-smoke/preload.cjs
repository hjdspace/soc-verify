/**
 * 冒烟 harness 的 preload（issue 26）。
 *
 * 只做两件事，且都在页面脚本之前执行（因此能观测到组件产生的全部副作用）：
 *  1. 统计 Worker 的创建/终止次数与脚本 URL —— 证明布局 worker 是本地文件，
 *     并在卸载时被 terminate；
 *  2. 统计 WebGL 上下文的创建与丢失 —— 证明卸载时释放了 GPU 资源；
 *     当 KB_GRAPH_SMOKE_NO_WEBGL=1 时让探测与创建全部失败，用于验证降级路径。
 *
 * 不修改被测组件的任何行为（除了「无 WebGL」这一显式场景）。
 */

const stats = {
  workers: { created: 0, terminated: 0, postMessages: 0, urls: [] },
  contexts: { created: 0, lost: 0, refs: [] },
  noWebGL: process.env.KB_GRAPH_SMOKE_NO_WEBGL === '1',
};

window.__kbGraphStats = stats;

// ── Worker 计数 ─────────────────────────────────────────────
const NativeWorker = window.Worker;
function InstrumentedWorker(url, options) {
  const worker = new NativeWorker(url, options);
  stats.workers.created += 1;
  stats.workers.urls.push(String(url));
  const nativePost = worker.postMessage.bind(worker);
  worker.postMessage = (message, transfer) => {
    stats.workers.postMessages += 1;
    return nativePost(message, transfer);
  };
  const nativeTerminate = worker.terminate.bind(worker);
  worker.terminate = () => {
    stats.workers.terminated += 1;
    return nativeTerminate();
  };
  return worker;
}
InstrumentedWorker.prototype = NativeWorker.prototype;
window.Worker = InstrumentedWorker;

// ── WebGL 上下文计数 / 无 WebGL 场景 ────────────────────────
const nativeGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function getContext(type, ...args) {
  if (stats.noWebGL && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
    return null;
  }
  const context = nativeGetContext.call(this, type, ...args);
  if (context && (type === 'webgl' || type === 'webgl2')) {
    stats.contexts.created += 1;
    stats.contexts.refs.push(context);
  }
  return context;
};

// ── 上下文丢失探测：直接问上下文本身，避免依赖扩展对象的身份 ──
window.__kbGraphLostContexts = () => {
  let lost = 0;
  for (const context of stats.contexts.refs) {
    try {
      if (typeof context.isContextLost === 'function' && context.isContextLost()) lost += 1;
    } catch {
      // 忽略：已失效上下文可能拒绝访问
    }
  }
  return lost;
};
