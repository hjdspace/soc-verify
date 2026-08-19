import { useMemo } from 'react';

// ── 路径解析工具 ────────────────────────────────────────────────

type PathSegment = {
  /** 段名称（如 `rtl`、`alu_add.sv`） */
  name: string;
  /** 累积路径（如 `/proj/rtl`），用于点击导航 */
  path: string;
};

/**
 * 将文件路径拆分为面包屑段数组。
 * 自动识别 `/` 和 `\` 分隔符，保留 Unix 前导 `/` 作为根段。
 *
 * 示例：
 *   `/proj/rtl/alu_add.sv` → [{ name: '/', path: '/' }, { name: 'proj', path: '/proj' }, { name: 'rtl', path: '/proj/rtl' }, { name: 'alu_add.sv', path: '/proj/rtl/alu_add.sv' }]
 *   `C:\proj\rtl\alu_add.sv` → [{ name: 'C:', path: 'C:' }, { name: 'proj', path: 'C:\proj' }, ...]
 *   `alu_add.sv` → [{ name: 'alu_add.sv', path: 'alu_add.sv' }]
 */
function parsePathSegments(filePath: string): PathSegment[] {
  // 检测分隔符：如果路径包含 `\` 则使用 `\`，否则使用 `/`
  const sep = filePath.includes('\\') ? '\\' : '/';
  const isAbsoluteUnix = filePath.startsWith('/');

  // 按分隔符拆分，过滤空段
  const parts = filePath.split(/[/\\]/).filter((p) => p.length > 0);
  if (parts.length === 0) return [{ name: filePath, path: filePath }];

  const segments: PathSegment[] = [];

  // Unix 绝对路径：前导 `/` 作为根段
  if (isAbsoluteUnix) {
    segments.push({ name: '/', path: '/' });
  }

  // 逐段累积路径
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (isAbsoluteUnix) {
      // /proj, /proj/rtl, /proj/rtl/alu_add.sv
      segments.push({ name: part, path: '/' + parts.slice(0, i + 1).join('/') });
    } else {
      // C:, C:\proj, C:\proj\rtl, ...
      const path = i === 0 ? part : parts.slice(0, i + 1).join(sep);
      segments.push({ name: part, path });
    }
  }

  return segments;
}

// ── Breadcrumb 组件 ────────────────────────────────────────────

interface BreadcrumbProps {
  /** 完整文件路径 */
  filePath: string;
  /** 点击非末尾段时的导航回调，参数为该段的累积路径（如 `/proj/rtl`） */
  onNavigate?: (dirPath: string) => void;
}

export function Breadcrumb({ filePath, onNavigate }: BreadcrumbProps) {
  const segments = useMemo(() => parsePathSegments(filePath), [filePath]);

  return (
    <nav
      className="flex items-center gap-0.5 overflow-hidden"
      aria-label="文件路径导航"
      data-testid="breadcrumb"
    >
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;

        return (
          <span key={`${segment.path}-${index}`} className="flex items-center gap-0.5">
            {index > 0 && (
              <span className="select-none text-muted-foreground/50" aria-hidden="true">
                ›
              </span>
            )}
            {isLast ? (
              <span
                className="truncate rounded px-1 text-xs font-medium text-foreground"
                data-testid="breadcrumb-active"
                title={segment.path}
              >
                {segment.name}
              </span>
            ) : (
              <button
                type="button"
                className="truncate rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={segment.path}
                onClick={() => onNavigate?.(segment.path)}
              >
                {segment.name}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
