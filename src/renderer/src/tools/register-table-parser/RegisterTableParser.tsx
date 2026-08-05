/**
 * RegisterTableParser — Excel register specification table parser.
 *
 * Ported from the Python `register_table_parser` plugin.
 * Features: select Excel file, parse register/field data,
 * display register list + field detail table + header info.
 */

import { useState, useCallback } from 'react';
import { FolderOpen, FileSpreadsheet, Search } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';

type HeaderInfo = {
  projectName: string;
  subSystem: string;
  moduleName: string;
  baseAddr: string;
};

type FieldInfo = {
  name: string;
  bitRange: string;
  rwAttribute: string;
  resetValue: string;
  description: string;
};

type RegisterInfo = {
  offset: string;
  name: string;
  description: string;
  width: number;
  fields: FieldInfo[];
};

type RegisterTableData = {
  header: HeaderInfo;
  registers: RegisterInfo[];
};

export function RegisterTableParser({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [filePath, setFilePath] = useState('');
  const [tableData, setTableData] = useState<RegisterTableData | null>(null);
  const [selectedReg, setSelectedReg] = useState<RegisterInfo | null>(null);
  const [search, setSearch] = useState('');
  const [parsing, setParsing] = useState(false);
  const [status, setStatus] = useState('请选择 Excel 文件');

  const handleParse = useCallback(async (path: string) => {
    if (!path) {
      setStatus('请先选择文件');
      return;
    }

    setParsing(true);
    setStatus('正在解析...');
    setTableData(null);
    setSelectedReg(null);

    try {
      const res = await trpc.tools.registerTableParser.parse.mutate({ filePath: path });
      const data = res as unknown as RegisterTableData;
      setTableData(data);
      setStatus(`解析完成: ${data.registers.length} 个寄存器, ${data.registers.reduce((s, r) => s + r.fields.length, 0)} 个字段`);
    } catch (err) {
      setStatus(`解析失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setParsing(false);
    }
  }, []);

  const handleBrowse = useCallback(async () => {
    const res = await trpc.tools.selectFiles.mutate({
      title: '选择寄存器表格',
      filters: [{ name: 'Excel 文件', extensions: ['xlsx', 'xls'] }],
      defaultPath: projectRoot ?? undefined,
    });
    if (res.paths.length > 0) {
      setFilePath(res.paths[0]);
      await handleParse(res.paths[0]);
    }
  }, [projectRoot, handleParse]);

  const filteredRegisters = tableData
    ? tableData.registers.filter((r) => {
        if (!search) return true;
        const q = search.toLowerCase();
        return r.name.toLowerCase().includes(q) || r.offset.toLowerCase().includes(q);
      })
    : [];

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <input type="hidden" value={projectRoot ?? ''} onChange={(e) => onProjectRootChange(e.target.value)} />

      {/* ── File selection ── */}
      <div className="rounded border border-border p-3">
        <div className="flex items-center gap-1">
          <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={filePath}
            onChange={(e) => setFilePath(e.target.value)}
            placeholder="请选择寄存器表格 Excel 文件 (.xlsx / .xls)"
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
          />
          <button
            onClick={handleBrowse}
            className="flex items-center gap-1 rounded border border-border px-2 py-1.5 text-xs hover:bg-accent whitespace-nowrap"
          >
            <FolderOpen className="h-3 w-3" />
            浏览
          </button>
          <button
            onClick={() => handleParse(filePath)}
            disabled={parsing || !filePath}
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {parsing ? '解析中...' : '解析'}
          </button>
        </div>
      </div>

      {/* ── Status ── */}
      <div className="text-xs text-muted-foreground">{status}</div>

      {/* ── Header info ── */}
      {tableData && (
        <div className="grid grid-cols-4 gap-2">
          <div className="rounded border border-border p-2">
            <div className="text-[10px] text-muted-foreground">项目</div>
            <div className="truncate text-xs font-medium" title={tableData.header.projectName}>
              {tableData.header.projectName}
            </div>
          </div>
          <div className="rounded border border-border p-2">
            <div className="text-[10px] text-muted-foreground">子系统</div>
            <div className="truncate text-xs font-medium" title={tableData.header.subSystem}>
              {tableData.header.subSystem}
            </div>
          </div>
          <div className="rounded border border-border p-2">
            <div className="text-[10px] text-muted-foreground">模块</div>
            <div className="truncate text-xs font-medium" title={tableData.header.moduleName}>
              {tableData.header.moduleName}
            </div>
          </div>
          <div className="rounded border border-border p-2">
            <div className="text-[10px] text-muted-foreground">基地址</div>
            <div className="truncate text-xs font-medium" title={tableData.header.baseAddr}>
              {tableData.header.baseAddr}
            </div>
          </div>
        </div>
      )}

      {/* ── Register list + field detail ── */}
      {tableData && (
        <div className="flex min-h-0 flex-1 gap-2">
          {/* Register list */}
          <div className="flex min-w-0 flex-1 flex-col rounded border border-border">
            <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-2 py-1">
              <span className="text-xs font-semibold">寄存器列表 ({filteredRegisters.length})</span>
              <div className="ml-auto flex items-center gap-1">
                <Search className="h-3 w-3 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索..."
                  className="w-32 rounded border border-border bg-background px-2 py-0.5 text-xs"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/50">
                  <tr className="text-left">
                    <th className="px-2 py-1">偏移</th>
                    <th className="px-2 py-1">寄存器名</th>
                    <th className="px-2 py-1 text-center">位宽</th>
                    <th className="px-2 py-1 text-center">字段数</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRegisters.map((reg, i) => (
                    <tr
                      key={i}
                      onClick={() => setSelectedReg(reg)}
                      className={`cursor-pointer border-b border-border/50 hover:bg-accent/30 ${
                        selectedReg?.name === reg.name ? 'bg-accent/50' : ''
                      }`}
                    >
                      <td className="px-2 py-1 font-mono">{reg.offset}</td>
                      <td className="px-2 py-1">{reg.name}</td>
                      <td className="px-2 py-1 text-center">{reg.width}</td>
                      <td className="px-2 py-1 text-center">{reg.fields.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Field detail */}
          {selectedReg && (
            <div className="flex w-96 flex-col rounded border border-border">
              <div className="border-b border-border bg-muted/30 px-2 py-1 text-xs font-semibold">
                {selectedReg.name} ({selectedReg.offset}) — 字段详情
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/50">
                    <tr className="text-left">
                      <th className="px-2 py-1">位域</th>
                      <th className="px-2 py-1">字段名</th>
                      <th className="px-2 py-1 text-center">RW</th>
                      <th className="px-2 py-1">复位值</th>
                      <th className="px-2 py-1">描述</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedReg.fields.map((field, i) => (
                      <tr key={i} className="border-b border-border/50">
                        <td className="px-2 py-1 font-mono">{field.bitRange}</td>
                        <td className="px-2 py-1">{field.name}</td>
                        <td className="px-2 py-1 text-center">
                          <span className={`rounded px-1 text-[10px] font-medium ${
                            field.rwAttribute === 'RW' ? 'bg-green-500/10 text-green-600 dark:text-green-400' :
                            field.rwAttribute === 'RO' ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400' :
                            'bg-orange-500/10 text-orange-600 dark:text-orange-400'
                          }`}>
                            {field.rwAttribute}
                          </span>
                        </td>
                        <td className="px-2 py-1 font-mono">{field.resetValue}</td>
                        <td className="px-2 py-1 text-muted-foreground">{field.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
