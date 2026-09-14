// ──────────────────────────────────────────────────────────────────────────
// Host 工具目录 — 设置页展示用的静态分组清单。
//
// 工具本身注册在 src/main/host/tools/ 各模块中；此目录只描述
// "哪些工具属于哪个分组、叫什么中文名"，供设置页渲染开关。
// 新增 host 工具时在此登记，否则设置页不会展示其开关（默认仍暴露）。
// ──────────────────────────────────────────────────────────────────────────

export type HostToolMeta = {
  name: string;
  label: string;
};

export type HostToolGroup = {
  id: string;
  label: string;
  tools: HostToolMeta[];
};

export const HOST_TOOL_GROUPS: HostToolGroup[] = [
  {
    id: 'simulation',
    label: '仿真验证',
    tools: [
      { name: 'list_subsys', label: '列出子系统' },
      { name: 'list_cases', label: '列出测试用例' },
      { name: 'get_sim_options_schema', label: '仿真选项 Schema' },
      { name: 'run_simulation', label: '运行仿真' },
      { name: 'get_run_status', label: '查询运行状态' },
      { name: 'get_compile_errors', label: '获取编译错误' },
      { name: 'get_coverage', label: '获取覆盖率' },
    ],
  },
  {
    id: 'coverage',
    label: '覆盖率与统计',
    tools: [
      { name: 'get_coverage_detail', label: '覆盖率明细' },
      { name: 'get_coverage_uncovered', label: '未覆盖项' },
      { name: 'get_coverage_grade', label: '覆盖率等级' },
      { name: 'get_coverage_csv', label: '覆盖率导出 CSV' },
      { name: 'get_case_stats', label: '用例统计' },
      { name: 'get_project_overview', label: '项目总览' },
    ],
  },
  {
    id: 'context',
    label: '上下文',
    tools: [
      { name: 'read_file', label: '读取文件' },
      { name: 'get_module_source', label: '获取模块源码' },
      { name: 'get_test_template', label: '获取测试模板' },
    ],
  },
  {
    id: 'document',
    label: '文档处理',
    tools: [
      { name: 'doc_to_markdown', label: '文档转 Markdown' },
      { name: 'read_document', label: '读取文档' },
      { name: 'create_docx', label: '创建 Word' },
      { name: 'create_xlsx', label: '创建 Excel' },
      { name: 'create_pptx', label: '创建 PPT' },
      { name: 'create_pdf', label: '创建 PDF' },
    ],
  },
  {
    id: 'xlsx-edit',
    label: '表格编辑',
    tools: [
      { name: 'append_xlsx_row', label: '追加表格行' },
      { name: 'update_xlsx_cell', label: '更新表格单元格' },
    ],
  },
  {
    id: 'knowledge-base',
    label: '知识库',
    tools: [
      { name: 'kb_read', label: '知识库证据读取' },
      { name: 'kb_search', label: '知识库检索' },
      // docId 工具（大文档转换缓存回读；doc_to_markdown 登记在文档处理组）
      { name: 'kb_doc_read', label: '大文档分块回读' },
      { name: 'kb_doc_grep', label: '大文档关键词定位' },
      { name: 'kb_doc_outline', label: '大文档大纲' },
    ],
  },
];

export const HOST_TOOL_NAMES: string[] = HOST_TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.name));
