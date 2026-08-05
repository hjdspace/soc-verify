/**
 * Tool metadata types shared between main and renderer processes.
 *
 * Each tool has a unique `id` (used in hash routing: `#tool=<id>`),
 * a display name, an icon name (lucide-react), and a category for
 * grouping in the TitleBar dropdown menu.
 */

/** Tool category for dropdown grouping. */
export type ToolCategory =
  | 'version-control'
  | 'regression'
  | 'code-tools'
  | 'coverage'
  | 'simulation-monitor'
  | 'environment'
  | 'batch';

/** Tool metadata used in the TitleBar dropdown and tool registry. */
export type ToolMeta = {
  /** Unique identifier, used in hash routing (`#tool=<id>`). */
  id: string;
  /** Display name shown in the dropdown menu. */
  name: string;
  /** Short description shown as tooltip. */
  description: string;
  /** lucide-react icon name. */
  icon: string;
  /** Category for dropdown grouping. */
  category: ToolCategory;
  /** Default window width. */
  width: number;
  /** Default window height. */
  height: number;
};

/** Category display labels. */
export const TOOL_CATEGORY_LABELS: Record<ToolCategory, string> = {
  'version-control': '版本控制',
  'regression': '回归管理',
  'code-tools': '代码工具',
  'coverage': '覆盖率',
  'simulation-monitor': '仿真监控',
  'environment': '环境检查',
  'batch': '批量执行',
};

/** All tool metadata entries (Batch 1-3). */
export const ALL_TOOLS: ToolMeta[] = [
  // ── Batch 1: Infrastructure + Simple Tools ──
  { id: 'env-checker', name: '环境检查一键确认', description: '验证环境 force/wait 语句快速检查', icon: 'ShieldCheck', category: 'environment', width: 1280, height: 800 },
  { id: 'code-line-counter', name: 'Verilog 代码行数统计', description: '统计 Verilog/SystemVerilog 代码行数', icon: 'FileCode', category: 'code-tools', width: 1000, height: 700 },
  { id: 'find-replace', name: '查找与替换工具', description: '在文件或项目中进行文本查找和批量替换', icon: 'Replace', category: 'code-tools', width: 800, height: 600 },
  { id: 'performance-monitor', name: '性能监控器', description: '实时监控 CPU、内存、磁盘等系统资源使用情况', icon: 'Gauge', category: 'simulation-monitor', width: 1000, height: 600 },

  // ── Batch 2: Medium Complexity Tools ──
  { id: 'log-analyzer', name: 'EDA 日志分析器', description: '解析仿真日志，提取错误和警告信息', icon: 'ScrollText', category: 'simulation-monitor', width: 1200, height: 800 },
  { id: 'time-analyzer', name: '仿真时间分析器', description: '分析仿真时间消耗分布', icon: 'Clock', category: 'simulation-monitor', width: 1200, height: 800 },
  { id: 'coverage-merger', name: '覆盖率合并工具', description: '合并多个覆盖率数据库', icon: 'Merge', category: 'coverage', width: 1000, height: 700 },
  { id: 'batch-execution', name: '批量执行工具', description: '批量执行仿真用例', icon: 'Play', category: 'batch', width: 1000, height: 700 },
  { id: 'regression-analyzer', name: '回归结果解析器', description: '解析回归测试结果', icon: 'BarChart3', category: 'regression', width: 1200, height: 800 },
  { id: 'regression-list-gen', name: '回归列表生成工具', description: '生成回归测试用例列表', icon: 'ListPlus', category: 'regression', width: 1000, height: 700 },

  // ── Batch 3: Complex Tools ──
  { id: 'git-manager', name: 'Git 版本控制管理', description: 'Git 仓库状态、提交、分支管理', icon: 'GitBranch', category: 'version-control', width: 1200, height: 800 },
  { id: 'git-diff', name: 'Git 文件版本比对', description: '比对文件不同版本的差异', icon: 'GitCompare', category: 'version-control', width: 1200, height: 800 },
  { id: 'git-quick-pull', name: 'Git 一键 Pull', description: '快速拉取多个仓库的最新代码', icon: 'Download', category: 'version-control', width: 800, height: 600 },
  { id: 'register-table-parser', name: '寄存器表格解析器', description: '解析寄存器表格并生成代码', icon: 'TableProperties', category: 'code-tools', width: 1200, height: 800 },
  { id: 'reg2c', name: '寄存器表格转 C 驱动头文件', description: '寄存器表格转 C 驱动代码', icon: 'FileCode2', category: 'code-tools', width: 1000, height: 700 },
  { id: 'c-sv-converter', name: 'C/SV 代码互转', description: 'C 代码与 SystemVerilog 代码互转', icon: 'ArrowLeftRight', category: 'code-tools', width: 1200, height: 800 },
  { id: 'sv-ifdef-checker', name: 'SV ifdef 检查器', description: '检查 SystemVerilog ifdef 条件编译', icon: 'SearchCheck', category: 'code-tools', width: 1000, height: 700 },
];
