/**
 * KB Wiki 只读守卫 — 受管路径判定（主进程/渲染端共用纯函数）。
 *
 * spec §2：知识库预览与通用文件编辑器识别受管 Wiki 页面并只读；
 * 应用受控写入入口不得绕过 KB 发布服务。
 *
 * 受管只读范围：
 *  - `<kb>/wiki/**`     知识页与聚合页（发布服务专属）；
 *  - `<kb>/schema.md`   受约束表须经规则编辑器校验入口修改；
 *  - `<kb>/purpose.md`  同上（规则编辑器）。
 *
 * `raw/**` 与 `.kb/**` 不在此守卫范围——它们由来源导入与库身份的
 * 受控入口治理（issue 01/02），不走通用文件编辑器写路径。
 *
 * 不承诺操作系统级防写：外部编辑器/shell 仍可能改磁盘，
 * 发布前由各受控入口自行检测文件哈希变化。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §2
 */

/** 归一化：统一 `/` 分隔 + Windows 小写（POSIX 保留大小写但前缀比较不受影响） */
function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 判断绝对路径是否位于挂载 wiki 库的受管只读范围内。
 * `kbPath` 为空（未挂载/非 wiki 布局）时恒为 false。
 */
export function isManagedWikiPath(kbPath: string | undefined | null, filePath: string): boolean {
  if (!kbPath || kbPath.length === 0) return false;
  const root = normalize(kbPath).toLowerCase();
  const target = normalize(filePath).toLowerCase();
  if (!target.startsWith(root + '/')) return false;

  const rest = target.slice(root.length + 1);
  if (rest === 'schema.md' || rest === 'purpose.md') return true;
  return rest === 'wiki' || rest.startsWith('wiki/');
}
