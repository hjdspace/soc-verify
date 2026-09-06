/**
 * 框图连线几何纯函数（连线朝向 + 跨节点绕行）。
 *
 * 连线锚定不再由端口方向决定（input 左缘 / output 右缘），而是由两端
 * 节点的相对位置决定：源节点在左 → 源右缘出线、目标左缘入线（水平流
 * 优先）；纵向堆叠（|dy| > |dx|）→ 源下缘 → 目标上缘。每个端口渲染
 * 四向 handle（id 前缀 l:/r:/t:/b:），边按几何结果选择 handle。
 *
 * planDetour：直连线穿过中间节点时规划绕行通道（水平流绕上/下、纵向流
 * 绕左/右），detourGeometry 产出带引出桩的圆角折线，标签落在通道中点
 * （空白区），不再压在框上。
 *
 * 尺寸常量与 ModuleBoxView 渲染保持一致（NODE_WIDTH / 行高等）。
 */

export type Side = 'l' | 'r' | 't' | 'b';
export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

// ─── box 几何（与 ModuleBoxView 渲染尺寸一致）──────────────────

export const NODE_WIDTH = 286;
export const PORT_ROW_H = 30;
export const HEADER_H = 42;
export const FOOTER_H = 28;
export const BODY_PAD = 5;
/** 端口 body 最大高度（max-h-[300px]；超出部分滚动，elk 只按可视高度留位） */
export const BODY_MAX_H = 300;

/** box 尺寸：body 高度按可视区封顶（与 max-h-300 渲染一致，避免 elk 留位虚高） */
export function nodeSize(n: { bundles: unknown[]; leftovers: unknown[] }): { width: number; height: number } {
  const rows = Math.max(n.bundles.length + n.leftovers.length, 1);
  const bodyH = Math.min(rows * PORT_ROW_H + BODY_PAD * 2, BODY_MAX_H);
  return { width: NODE_WIDTH, height: HEADER_H + bodyH + FOOTER_H };
}

// ─── 锚定面选择 ───────────────────────────────────────────────

/** 两端节点相对位置 → 源出线面/目标入线面（水平流优先；纵向堆叠走上下） */
export function anchorSides(src: Rect, tgt: Rect): { source: Side; target: Side; axis: 'h' | 'v' } {
  const dx = tgt.x + tgt.width / 2 - (src.x + src.width / 2);
  const dy = tgt.y + tgt.height / 2 - (src.y + src.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { source: 'r', target: 'l', axis: 'h' } : { source: 'l', target: 'r', axis: 'h' };
  }
  return dy >= 0 ? { source: 'b', target: 't', axis: 'v' } : { source: 't', target: 'b', axis: 'v' };
}

export function handleId(side: Side, port: string): string {
  return `${side}:${port}`;
}

// ─── 绕行规划 ─────────────────────────────────────────────────

export type Detour = { axis: 'h' | 'v'; channel: number };

/** 线段与矩形相交（端点在内 / 跨边相交，带外扩 margin） */
function segmentHitsRect(a: Point, b: Point, rect: Rect, margin = 0): boolean {
  const minX = rect.x - margin;
  const minY = rect.y - margin;
  const maxX = rect.x + rect.width + margin;
  const maxY = rect.y + rect.height + margin;
  const inside = (p: Point): boolean => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
  if (inside(a) || inside(b)) return true;
  const edges: [Point, Point][] = [
    [{ x: minX, y: minY }, { x: maxX, y: minY }],
    [{ x: maxX, y: minY }, { x: maxX, y: maxY }],
    [{ x: maxX, y: maxY }, { x: minX, y: maxY }],
    [{ x: minX, y: maxY }, { x: minX, y: minY }],
  ];
  return edges.some(([p, q]) => crossIntersect(a, b, p, q));
}

function crossIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (d === 0) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

const DETOUR_MARGIN = 46;
const DETOUR_STAGGER = 18;

/** 通道线段是否压到任一障碍 */
function channelHits(axis: 'h' | 'v', channel: number, a: Point, b: Point, obstacles: Rect[]): boolean {
  const seg: [Point, Point] =
    axis === 'h'
      ? [{ x: a.x, y: channel }, { x: b.x, y: channel }]
      : [{ x: channel, y: a.y }, { x: channel, y: b.y }];
  return obstacles.some((r) => segmentHitsRect(seg[0], seg[1], r, 12));
}

/**
 * 直连线穿过障碍节点时规划绕行通道：水平流绕上/下、纵向流绕左/右；
 * 通道若仍压其他节点则继续外推；同侧多条边按 ordinal 错开。
 * 无障碍返回 null（走常规贝塞尔）。
 */
export function planDetour(a: Point, b: Point, obstacles: Rect[], ordinal = 0, axis: 'h' | 'v' = 'h'): Detour | null {
  const hits = obstacles.filter((r) => segmentHitsRect(a, b, r, 12));
  if (hits.length === 0) return null;
  if (axis === 'h') {
    const top = Math.min(...hits.map((r) => r.y));
    const bottom = Math.max(...hits.map((r) => r.y + r.height));
    const up = (a.y + b.y) / 2 < (top + bottom) / 2;
    let channel = up ? top - DETOUR_MARGIN : bottom + DETOUR_MARGIN;
    for (let i = 0; i < 8 && channelHits('h', channel, a, b, obstacles); i++) {
      channel += up ? -DETOUR_MARGIN : DETOUR_MARGIN;
    }
    return { axis: 'h', channel: channel + (up ? -1 : 1) * ordinal * DETOUR_STAGGER };
  }
  const left = Math.min(...hits.map((r) => r.x));
  const right = Math.max(...hits.map((r) => r.x + r.width));
  const toLeft = (a.x + b.x) / 2 < (left + right) / 2;
  let channel = toLeft ? left - DETOUR_MARGIN : right + DETOUR_MARGIN;
  for (let i = 0; i < 8 && channelHits('v', channel, a, b, obstacles); i++) {
    channel += toLeft ? -DETOUR_MARGIN : DETOUR_MARGIN;
  }
  return { axis: 'v', channel: channel + (toLeft ? -1 : 1) * ordinal * DETOUR_STAGGER };
}

// ─── 绕行 path 构建 ───────────────────────────────────────────

/** 折线圆角化（转折点用二次贝塞尔，半径随相邻段长自适应钳制） */
export function roundedPath(waypoints: Point[], radius = 16): string {
  if (waypoints.length < 2) return '';
  let d = `M ${waypoints[0]!.x},${waypoints[0]!.y}`;
  for (let i = 1; i < waypoints.length - 1; i++) {
    const prev = waypoints[i - 1]!;
    const cur = waypoints[i]!;
    const next = waypoints[i + 1]!;
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const p1 = { x: cur.x + ((prev.x - cur.x) / (inLen || 1)) * r, y: cur.y + ((prev.y - cur.y) / (inLen || 1)) * r };
    const p2 = { x: cur.x + ((next.x - cur.x) / (outLen || 1)) * r, y: cur.y + ((next.y - cur.y) / (outLen || 1)) * r };
    d += ` L ${p1.x},${p1.y} Q ${cur.x},${cur.y} ${p2.x},${p2.y}`;
  }
  const last = waypoints[waypoints.length - 1]!;
  return `${d} L ${last.x},${last.y}`;
}

const DETOUR_STUB = 20;

/**
 * 绕行边的 waypoints（以实测锚点为端点）与标签位置（通道中点空白区）。
 * 锚点先沿出线方向引出一小段桩（离开节点边框）再拐上/下（或左/右），
 * 避免折线贴着源/目标框的边缘走。
 */
export function detourGeometry(source: Point, target: Point, detour: Detour): { waypoints: Point[]; label: Point } {
  if (detour.axis === 'h') {
    const dir = Math.sign(target.x - source.x) || 1;
    const stub = Math.min(DETOUR_STUB, Math.abs(target.x - source.x) / 3);
    const sx = source.x + dir * stub;
    const tx = target.x - dir * stub;
    return {
      waypoints: [
        source,
        { x: sx, y: source.y },
        { x: sx, y: detour.channel },
        { x: tx, y: detour.channel },
        { x: tx, y: target.y },
        target,
      ],
      label: { x: (sx + tx) / 2, y: detour.channel },
    };
  }
  const dir = Math.sign(target.y - source.y) || 1;
  const stub = Math.min(DETOUR_STUB, Math.abs(target.y - source.y) / 3);
  const sy = source.y + dir * stub;
  const ty = target.y - dir * stub;
  return {
    waypoints: [
      source,
      { x: source.x, y: sy },
      { x: detour.channel, y: sy },
      { x: detour.channel, y: ty },
      { x: target.x, y: ty },
      target,
    ],
    label: { x: detour.channel, y: (sy + ty) / 2 },
  };
}
