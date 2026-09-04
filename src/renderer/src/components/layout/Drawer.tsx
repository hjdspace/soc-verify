import { useEffect, useRef, type ReactNode } from 'react';
import { animate, motion, useMotionValue, useReducedMotion } from 'motion/react';
import { X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { DRAWER_LEFT_OFFSET, STATUS_BAR_HEIGHT, TITLE_BAR_HEIGHT } from './layout-constants';

/** 默认抽屉宽度（原型：文件抽屉 330px，AI 抽屉 360px 由调用方传入） */
const DEFAULT_WIDTH = 330;

/** 关闭态额外离屏余量（px）：抗子像素/边框圆角，保证完全离屏（原型取 400 > 398） */
const CLOSE_MARGIN_PX = 2;

/** 拖拽起手阈值（px）：横向位移越过才进入拖拽（§10 hysteresis，期间放行子元素点击） */
const DRAG_THRESHOLD_PX = 10;

/** 橡皮筋常数（§9 rubberband 的 constant） */
const RUBBERBAND_CONSTANT = 0.55;

/** 速度采样窗口（ms）：释放时用最近样本对求指针速度（§2 velocity history） */
const VELOCITY_WINDOW_MS = 100;

/**
 * 抽屉弹簧（apple-design §4 quick-ref：Drawer/sheet damping 0.8 / response 0.3）。
 * 不能用 duration/bounce 形式：motion-dom 的 getSpringOptions 对 duration
 * 定义弹簧显式置零 velocity（含中断继承与显式传入），会切断 §5 速度接手。
 * 物理参数等价换算：stiffness ≈ (2π/response)² ≈ 439，damping = 2·ζ·√k（ζ=0.8）≈ 33。
 */
export const DRAWER_SPRING = { type: 'spring', stiffness: 439, damping: 33 } as const;

/** 惯性减速系数（iOS UIScrollView decelerationRate，apple-design §6 momentum projection） */
const DECELERATION_RATE = 0.998;

/** 甩动判定速度（px/s）：|v| 超过此值直接按速度方向决策（quick-ref：用速度符号而非位置） */
const FLICK_VELOCITY = 400;

/** 吸附占比：动量投影落点越过行程 30% 时吸附到最近目标（§6） */
const SNAP_RATIO = 0.3;

/**
 * Apple 动量投影函数（apple-design §6 project()）：
 * 由释放速度外推「若无阻拦还会滑行多远」，与滚动减速同构。
 * 例：v = 500px/s → 约 250px。
 */
export function projectMomentum(velocity: number, decelerationRate = DECELERATION_RATE): number {
  return (velocity / 1000) * (decelerationRate / (1 - decelerationRate));
}

/**
 * 释放决策（quick-ref「Decide reverse vs. commit — use velocity sign, not position」）：
 * 1. 朝关闭方向甩动（|v| > FLICK_VELOCITY）→ 关闭；朝打开方向甩动 → 保持打开；
 * 2. 慢速释放 → 按 §6 动量投影落点吸附到最近目标。
 */
export function shouldCloseOnRelease(params: {
  side: 'left' | 'right';
  velocityX: number;
  offsetX: number;
  closeDistance: number;
}): boolean {
  const { side, velocityX, offsetX, closeDistance } = params;
  const closeSign = side === 'left' ? -1 : 1;
  const vTowardClose = velocityX * closeSign;
  if (vTowardClose > FLICK_VELOCITY) return true;
  if (vTowardClose < -FLICK_VELOCITY) return false;
  const projected = (offsetX + projectMomentum(velocityX)) * closeSign;
  return projected > closeDistance * SNAP_RATIO;
}

/** §9 公式原样：overshoot·dimension·c / (dimension + c·|overshoot|) */
export function rubberband(overshoot: number, dimension: number, constant = RUBBERBAND_CONSTANT): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * 指针位移 → 抽屉位移（§2 1:1 + §9 橡皮筋）：
 * raw 朝关闭方向（负）在 [−closeDistance, 0] 内 1:1 跟手；
 * raw 朝屏幕内推（正，越过打开位）橡皮筋衰减。
 */
export function resolveDragOffset(raw: number, closeDistance: number, viewportWidth: number): number {
  if (raw > 0) return rubberband(raw, viewportWidth);
  return Math.max(raw, -closeDistance);
}

type DrawerProps = {
  /** 抽屉停靠侧 */
  side: 'left' | 'right';
  /** 打开状态（组件常驻挂载以保证开合动画） */
  open: boolean;
  /** 关闭回调：Esc / 头部关闭按钮 / 拖拽吸附关闭时触发 */
  onClose: () => void;
  /** 头部标题 */
  title: string;
  /** 抽屉宽度（px） */
  width?: number;
  /**
   * 贴合内容模式：内容区不加分隔内边距与滚动，由子组件自管滚动与布局
   * （如 AI 会话：消息流滚动、composer 固定底部）。
   */
  flush?: boolean;
  children: ReactNode;
};

/**
 * 通用抽屉原语。
 * 关闭位移 ≥ left + width，保证关闭态完全离屏、不遮挡导航栏（原型 §2.1 第 1 条）。
 * z-index 50（刻度：backdrop 40 / drawer 50 / dropdown 70 / palette 80 / toast 100）。
 *
 * 动画与手势（apple-design）：
 * - §3/§4：开合用欠阻尼弹簧（damping 0.8 / response 0.3），可中断——
 *   animate() 从 motion value 当前展示值 + 当前速度继续，无跳跃、无「先完成旧动画」；
 * - §2：拖拽 1:1 跟手（Pointer Events + setPointerCapture，越界仍跟随），
 *   起手 10px 阈值滞回，未过阈值前放行子元素点击（§10）；
 * - §9：越过打开位朝屏幕内推时橡皮筋衰减，不硬停；
 * - §5/§6：释放时甩动按速度符号决策，慢速按动量投影落点吸附最近目标，
 *   指针速度作为弹簧初速（velocity handoff），无拖拽→动画接缝；
 * - §11：仅合成器友好属性（transform），will-change: transform；
 * - §14：prefers-reduced-motion 时退化为即时落位、拖拽手势禁用。
 *
 * 组件常驻挂载以保证关闭态也能播放离场动画。
 */
export function Drawer({ side, open, onClose, title, width = DEFAULT_WIDTH, flush = false, children }: DrawerProps) {
  const prefersReducedMotion = useReducedMotion();
  const gestureEnabled = !prefersReducedMotion && open;

  // 关闭位移：左抽屉须 ≥ DRAWER_LEFT_OFFSET + width 才完全离屏（原型 §2.1-1：68+330 → 400）
  const closeDistance =
    side === 'left' ? DRAWER_LEFT_OFFSET + width + CLOSE_MARGIN_PX : width + CLOSE_MARGIN_PX;
  const closedX = side === 'left' ? -closeDistance : closeDistance;
  /**
   * 指针位移 → 抽屉 x 的系数：两侧均为 +1。x 的符号约定已按 side 定向
   * （左抽屉朝关闭为负、右抽屉为正），指针朝关闭方向移动（左抽屉向左、
   * 右抽屉向右）恰好令 x 朝 closedX 符号变化，因此直接同号映射。
   */

  // x 为唯一运动轴（px，0 = 打开位，closedX = 关闭位）。初始值直接取目标位：
  // 首帧渲染即离屏，弹簧只负责后续开合（避免「先闪现在打开位再动画」）。
  const x = useMotionValue(open ? 0 : closedX);
  const panelRef = useRef<HTMLElement | null>(null);

  // open/onClose 的手势内最新引用（effect 依赖只挂手势开关，避免重挂丢失拖拽状态）
  const closedXRef = useRef(closedX);
  const closeDistanceRef = useRef(closeDistance);
  const onCloseRef = useRef(onClose);
  closedXRef.current = closedX;
  closeDistanceRef.current = closeDistance;
  onCloseRef.current = onClose;

  // Esc 关闭（仅打开时挂载监听）
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // ── 开合动画：open 变化时弹簧滑入/滑出（可中断，从当前展示值继续） ──
  useEffect(() => {
    const controls = animate(
      x,
      open ? 0 : closedX,
      prefersReducedMotion ? { duration: 0 } : DRAWER_SPRING,
    );
    return () => controls.stop();
    // closedX 随 width/side 派生；width 变化重定向目标
  }, [open, closedX, prefersReducedMotion, x]);

  // ── 拖拽手势（§2/§5/§6/§9/§10）───────────────────────────────
  useEffect(() => {
    if (!gestureEnabled) return;
    const panel = panelRef.current;
    if (!panel) return;

    type Sample = { x: number; t: number };
    let startPointerX = 0;
    let startX = 0;
    let pointerId = -1;
    let dragging = false;
    let history: Sample[] = [];
    let runningControls: { stop: () => void } | null = null;

    /** 最近 100ms 样本对的指针速度（px/s）；不足两帧为 0 */
    const releaseVelocityPx = (): number => {
      const last = history[history.length - 1];
      let first = history[0];
      for (let i = history.length - 1; i >= 0 && last.t - history[i].t <= VELOCITY_WINDOW_MS; i -= 1) {
        first = history[i];
      }
      const dt = last.t - first.t;
      if (dt <= 0) return 0;
      return (last.x - first.x) / (dt / 1000);
    };

    const onPointerDown = (e: PointerEvent) => {
      // button 0 排除右键/中键；多指场景以首个 pointerdown 为准（pointerId 匹配）。
      // 不依赖 isPrimary：jsdom 合成事件恒为 false，真实浏览器主指针恒为 true。
      if (e.button !== 0) return;
      pointerId = e.pointerId;
      startPointerX = e.clientX;
      startX = x.get();
      dragging = false;
      history = [{ x: e.clientX, t: performance.now() }];
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      history.push({ x: e.clientX, t: performance.now() });
      if (history.length > 8) history.shift();

      const dx = e.clientX - startPointerX;
      if (!dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        // 捕获后指针移出面板仍持续跟随（§2）；从阈值点重锚避免起手跳变
        startPointerX = e.clientX;
        startX = x.get();
        try {
          panel.setPointerCapture(e.pointerId);
        } catch {
          /* jsdom 无该实现；真实浏览器才需要捕获 */
        }
        // 冻结进行中的开/关弹簧：拖拽从当前展示值接管（§3 interruptibility）
        x.stop();
        document.body.style.userSelect = 'none';
      }
      // 左抽屉：raw < 0 = 关闭方向 1:1；raw > 0 = 越过打开位朝屏幕内推，橡皮筋衰减（§9）。
      // 右抽屉镜像（raw > 0 = 关闭方向），同式成立。
      const raw = e.clientX - startPointerX;
      x.set(resolveDragOffset(startX + raw, closeDistanceRef.current, window.innerWidth));
    };

    /** 释放：动量投影决策 + 速度接手（§5/§6） */
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      pointerId = -1;
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      if (panel.hasPointerCapture?.(e.pointerId)) panel.releasePointerCapture(e.pointerId);

      const offsetX = x.get();
      // 释放速度直接同号映射（x 与指针同轴：左抽屉负向关闭、右抽屉正向关闭）
      const velocityX = releaseVelocityPx();
      const close = shouldCloseOnRelease({
        side,
        velocityX,
        offsetX,
        closeDistance: closeDistanceRef.current,
      });
      if (close) onCloseRef.current();
      runningControls?.stop();
      runningControls = animate(
        x,
        close ? closedXRef.current : 0,
        prefersReducedMotion
          ? { duration: 0 }
          : { ...DRAWER_SPRING, velocity: velocityX },
      );
    };

    const onPointerCancel = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      pointerId = -1;
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      // 取消（无释放速度）：吸附最近目标
      const offsetX = x.get();
      const close = shouldCloseOnRelease({
        side,
        velocityX: 0,
        offsetX,
        closeDistance: closeDistanceRef.current,
      });
      if (close) onCloseRef.current();
      runningControls?.stop();
      runningControls = animate(
        x,
        close ? closedXRef.current : 0,
        prefersReducedMotion ? { duration: 0 } : DRAWER_SPRING,
      );
    };

    panel.addEventListener('pointerdown', onPointerDown);
    panel.addEventListener('pointermove', onPointerMove);
    panel.addEventListener('pointerup', onPointerUp);
    panel.addEventListener('pointercancel', onPointerCancel);
    return () => {
      panel.removeEventListener('pointerdown', onPointerDown);
      panel.removeEventListener('pointermove', onPointerMove);
      panel.removeEventListener('pointerup', onPointerUp);
      panel.removeEventListener('pointercancel', onPointerCancel);
      runningControls?.stop();
      document.body.style.userSelect = '';
    };
  }, [gestureEnabled, side, prefersReducedMotion, x]);

  return (
    <motion.aside
      ref={panelRef}
      role="dialog"
      aria-label={title}
      aria-hidden={!open}
      inert={!open}
      data-testid={`drawer-${side}`}
      className={cn(
        'fixed z-50 flex flex-col border border-border bg-glass shadow-2xl glass',
        'will-change-transform',
        side === 'left' ? 'rounded-r-[14px]' : 'rounded-tl-[14px]',
      )}
      style={{
        top: TITLE_BAR_HEIGHT,
        bottom: STATUS_BAR_HEIGHT,
        width,
        ...(side === 'left' ? { left: DRAWER_LEFT_OFFSET } : { right: 0 }),
        x,
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-[12.5px] font-semibold">
        {title}
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </div>
      <div
        className={cn(
          'min-h-0 flex-1',
          flush ? 'flex flex-col overflow-hidden' : 'overflow-y-auto p-2',
        )}
      >
        {children}
      </div>
    </motion.aside>
  );
}
