import { BarChart3, Database, FileCode2, FileText, FlaskConical, ScrollText } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { MessageReference } from './MarkdownRenderer';

export type SourceHue = 'blue' | 'green' | 'orange' | 'violet' | 'teal' | 'rose' | 'amber';

// 未知扩展名时按 key 哈希取色，保证同一来源每次渲染颜色稳定
const FALLBACK_HUES: SourceHue[] = ['blue', 'teal', 'violet', 'rose', 'amber', 'green'];

// 常见验证工程文件按语义上色：设计源码 / 约束与脚本 / 日志与数据 / 数据库
const FILE_EXT_HUE: Record<string, SourceHue> = {
  sv: 'blue',
  svh: 'blue',
  v: 'blue',
  vh: 'blue',
  tcl: 'amber',
  sdc: 'amber',
  xdc: 'amber',
  f: 'amber',
  do: 'amber',
  log: 'green',
  dbg: 'green',
  rpt: 'green',
  csv: 'green',
  dat: 'green',
  db: 'rose',
};

function hashHue(key: string): SourceHue {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return FALLBACK_HUES[Math.abs(h) % FALLBACK_HUES.length];
}

export function refIdentity(source: MessageReference): { hue: SourceHue; Icon: typeof FileText } {
  if (source.kind === 'uri') {
    const scheme = source.uri.slice(0, source.uri.indexOf('://'));
    if (scheme === 'case') return { hue: 'violet', Icon: FlaskConical };
    if (scheme === 'log') return { hue: 'green', Icon: ScrollText };
    return { hue: 'orange', Icon: BarChart3 };
  }
  const ext = source.path.includes('.') ? (source.path.split('.').pop() ?? '').toLowerCase() : '';
  const hue = FILE_EXT_HUE[ext] ?? hashHue(ext || source.path);
  if (ext === 'db') return { hue, Icon: Database };
  if (hue === 'blue' || hue === 'amber') return { hue, Icon: FileCode2 };
  return { hue, Icon: FileText };
}

interface SourceIconProps {
  source: MessageReference;
  /** stack：胶囊内的重叠圆形堆叠态；row：展开列表的圆角方形行首图标 */
  variant: 'stack' | 'row';
}

/**
 * 引用来源的身份图标（彩色圆角底 + 白色字形，视觉对齐 beautiful-ui
 * StreamingText 的 source-avatar）：同一图标在两种尺寸下复用，
 * 颜色按来源语义固定，明暗主题下均与白色字形保持对比。
 */
export function SourceIcon({ source, variant }: SourceIconProps) {
  const { hue, Icon } = refIdentity(source);
  return (
    <span
      className={cn(
        'ap-src-icon',
        `ap-src-icon--${hue}`,
        variant === 'stack' ? 'ap-src-icon--stack' : 'ap-src-icon--row',
      )}
      aria-hidden="true"
    >
      <Icon className={variant === 'stack' ? 'h-2.5 w-2.5' : 'h-3 w-3'} strokeWidth={2.25} />
    </span>
  );
}
