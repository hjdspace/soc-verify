/**
 * RegisterTableParser — Excel register specification table parser.
 *
 * Ported from the Python `register_table_parser` plugin (`main_window.py` + `widgets.py`).
 *
 * Features:
 * - Load .xlsx / .xls register table files (auto-fix format issues)
 * - Display header info (project, subsystem, module, base address)
 * - Register list with debounced search (name + hex/decimal offset)
 * - Field editor with:
 *   - Number format selector (Hex / Dec / Bin)
 *   - Editable field values with real-time register value calculation
 *   - Register value reverse annotation (apply reg value → extract field values)
 *   - Reset to default values
 *   - Field value validation (restore on invalid input)
 *   - Skip reserved fields; disable read-only field inputs
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { FolderOpen, RefreshCw, Search, HelpCircle, RotateCcw, Check } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';
import {
  type RegisterInfo,
  type RegisterTableData,
  type FieldInfo,
  type NumberFormat,
  getNonReservedFields,
  getWritableFields,
  isReadOnlyField,
  getBitWidth,
  parseNumberFromString,
  formatNumber,
  formatRegisterValue,
  calculateRegisterValue,
  initFieldValues,
  extractAllFieldValues,
  validateFieldValue,
  searchRegisters,
  getOffsetInt,
} from './utils';

export function RegisterTableParser({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  // ── State ──
  const [filePath, setFilePath] = useState('');
  const [tableData, setTableData] = useState<RegisterTableData | null>(null);
  const [selectedReg, setSelectedReg] = useState<RegisterInfo | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [parsing, setParsing] = useState(false);
  const [autoFix, setAutoFix] = useState(true);
  const [status, setStatus] = useState('请选择 Excel 文件');
  const [showHelp, setShowHelp] = useState(false);

  // Debounce search (300ms, matching Python version)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // ── Parse handler ──
  const handleParse = useCallback(async (path: string, fix?: boolean) => {
    if (!path) {
      setStatus('请先选择文件');
      return;
    }

    setParsing(true);
    setStatus('正在解析...');
    setTableData(null);
    setSelectedReg(null);

    try {
      const res = (await trpc.tools.registerTableParser.parse.mutate({
        filePath: path,
        autoFix: fix ?? autoFix,
      })) as unknown as RegisterTableData;
      setTableData(res);
      const fieldCount = res.registers.reduce((s, r) => s + r.fields.length, 0);
      setStatus(`✅ 解析完成: ${res.registers.length} 个寄存器, ${fieldCount} 个字段`);
    } catch (err) {
      setStatus(`❌ 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setParsing(false);
    }
  }, [autoFix]);

  const handleBrowse = useCallback(async () => {
    const res = await trpc.tools.selectFiles.mutate({
      title: '选择寄存器规格表 Excel 文件',
      filters: [{ name: 'Excel 文件', extensions: ['xlsx', 'xls'] }],
      defaultPath: projectRoot ?? undefined,
    });
    if (res.paths.length > 0) {
      setFilePath(res.paths[0]);
      await handleParse(res.paths[0]);
    }
  }, [projectRoot, handleParse]);

  const handleRefresh = useCallback(() => {
    if (filePath) handleParse(filePath);
  }, [filePath, handleParse]);

  // ── Filtered registers (debounced search) ──
  const filteredRegisters = useMemo(() => {
    if (!tableData) return [];
    if (!debouncedSearch) return tableData.registers;
    return searchRegisters(tableData, debouncedSearch);
  }, [tableData, debouncedSearch]);

  // ── Register selection ──
  const handleSelectRegister = useCallback((reg: RegisterInfo) => {
    setSelectedReg(reg);
  }, []);

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <input type="hidden" value={projectRoot ?? ''} onChange={(e) => onProjectRootChange(e.target.value)} />

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleBrowse}
          disabled={parsing}
          className="flex items-center gap-1 rounded bg-green-600 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-green-700 disabled:opacity-50"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          加载 Excel 文件
        </button>
        <button
          onClick={handleRefresh}
          disabled={parsing || !filePath}
          className="flex items-center gap-1 rounded bg-blue-600 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', parsing && 'animate-spin')} />
          刷新
        </button>
        <div className="flex items-center gap-1 px-1">
          <input
            type="checkbox"
            id="autoFix"
            checked={autoFix}
            onChange={(e) => setAutoFix(e.target.checked)}
            className="h-3.5 w-3.5 accent-purple-600"
          />
          <label htmlFor="autoFix" className="cursor-pointer text-xs font-medium" title="自动修复 Linux 内网环境下的 Excel 格式兼容性问题">
            自动修复格式
          </label>
        </div>
        <div className="flex-1 truncate text-xs text-muted-foreground" title={filePath}>
          {filePath ? `文件: ${filePath.split(/[/\\]/).pop()}` : '未加载文件'}
        </div>
        <button
          onClick={() => setShowHelp(true)}
          className="flex items-center gap-1 rounded bg-orange-500 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-orange-600"
        >
          <HelpCircle className="h-3.5 w-3.5" />
          帮助
        </button>
      </div>

      {/* ── Status ── */}
      <div className="text-xs text-muted-foreground">{status}</div>

      {/* ── Header info panel ── */}
      {tableData && (
        <div className="grid grid-cols-4 gap-2 rounded border border-border p-2">
          <div className="rounded border border-border/50 bg-muted/30 px-2 py-1">
            <div className="text-[10px] font-semibold text-muted-foreground">项目名称</div>
            <div className="truncate text-xs font-medium" title={tableData.header.projectName}>
              {tableData.header.projectName}
            </div>
          </div>
          <div className="rounded border border-border/50 bg-muted/30 px-2 py-1">
            <div className="text-[10px] font-semibold text-muted-foreground">子系统</div>
            <div className="truncate text-xs font-medium" title={tableData.header.subSystem}>
              {tableData.header.subSystem}
            </div>
          </div>
          <div className="rounded border border-border/50 bg-muted/30 px-2 py-1">
            <div className="text-[10px] font-semibold text-muted-foreground">模块名称</div>
            <div className="truncate text-xs font-medium" title={tableData.header.moduleName}>
              {tableData.header.moduleName}
            </div>
          </div>
          <div className="rounded border border-border/50 bg-muted/30 px-2 py-1">
            <div className="text-[10px] font-semibold text-muted-foreground">基地址</div>
            <div className="truncate text-xs font-mono font-medium" title={tableData.header.baseAddr}>
              {tableData.header.baseAddr}
            </div>
          </div>
        </div>
      )}

      {/* ── Main content: register list + field editor ── */}
      {tableData && (
        <div className="flex min-h-0 flex-1 gap-2">
          {/* Left: register list */}
          <div className="flex w-72 shrink-0 flex-col rounded border border-border">
            {/* Search */}
            <div className="border-b border-border p-2">
              <div className="flex items-center gap-1">
                <Search className="h-3 w-3 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索寄存器名称或偏移地址..."
                  className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
                />
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                💡 支持 0x 前缀十六进制和十进制
              </div>
            </div>
            {/* Register table */}
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/50">
                  <tr className="text-left">
                    <th className="border-b border-border px-2 py-1.5 font-semibold">偏移地址</th>
                    <th className="border-b border-border px-2 py-1.5 font-semibold">寄存器名称</th>
                    <th className="border-b border-border px-2 py-1.5 text-center font-semibold w-12">字段数</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRegisters.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-2 py-4 text-center text-muted-foreground">
                        无匹配结果
                      </td>
                    </tr>
                  ) : (
                    filteredRegisters
                      .slice()
                      .sort((a, b) => getOffsetInt(a.offset) - getOffsetInt(b.offset))
                      .map((reg, i) => {
                        const fieldCount = getNonReservedFields(reg).length;
                        return (
                          <tr
                            key={i}
                            onClick={() => handleSelectRegister(reg)}
                            className={cn(
                              'cursor-pointer border-b border-border/50 hover:bg-accent/30',
                              selectedReg?.name === reg.name && 'bg-accent/50',
                            )}
                            title={`寄存器: ${reg.name}\n偏移地址: ${reg.offset}\n总字段数: ${reg.fields.length}\n可编辑字段数: ${fieldCount}`}
                          >
                            <td className="px-2 py-1.5 font-mono">{reg.offset}</td>
                            <td className="px-2 py-1.5">{reg.name}</td>
                            <td className="px-2 py-1.5 text-center tabular-nums">{fieldCount}</td>
                          </tr>
                        );
                      })
                  )}
                </tbody>
              </table>
            </div>
            {/* Status bar */}
            <div className="border-t border-border bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground">
              {debouncedSearch && filteredRegisters.length !== tableData.registers.length
                ? `🔍 找到 ${filteredRegisters.length} 个 (共 ${tableData.registers.length} 个)`
                : `📊 显示 ${tableData.registers.length} 个寄存器`}
            </div>
          </div>

          {/* Right: field editor */}
          {selectedReg ? (
            <FieldEditor key={selectedReg.name} register={selectedReg} />
          ) : (
            <div className="flex min-w-0 flex-1 items-center justify-center rounded border border-border text-sm text-muted-foreground">
              请从左侧列表选择一个寄存器
            </div>
          )}
        </div>
      )}

      {/* ── Help dialog ── */}
      {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
    </div>
  );
}

// ── Field Editor (ported from widgets.py FieldEditorWidget) ──────────

function FieldEditor({ register }: { register: RegisterInfo }) {
  const [format, setFormat] = useState<NumberFormat>('hexadecimal');
  const [fieldValues, setFieldValues] = useState<Record<string, number>>({});
  const [regValueInput, setRegValueInput] = useState('');
  const [regValueError, setRegValueError] = useState('');

  // Initialize field values with reset values
  useEffect(() => {
    const values = initFieldValues(register);
    setFieldValues(values);
    setRegValueError('');
  }, [register]);

  // Calculate current register value
  const registerValue = useMemo(() => {
    return calculateRegisterValue(register.fields, fieldValues);
  }, [register, fieldValues]);

  // Update register value input when format changes or register changes
  useEffect(() => {
    setRegValueInput(formatRegisterValue(registerValue, format));
  }, [registerValue, format]);

  // ── Format change handler ──
  const handleFormatChange = useCallback((newFormat: NumberFormat) => {
    setFormat(newFormat);
  }, []);

  // ── Field value change handler ──
  const handleFieldValueChange = useCallback(
    (field: FieldInfo, text: string) => {
      try {
        if (!text.trim()) {
          // Empty input, set to 0
          setFieldValues((prev) => ({ ...prev, [field.name]: 0 }));
          return;
        }

        const value = parseNumberFromString(text.trim());

        // Validate range
        if (!validateFieldValue(value, field.bitRange)) {
          // Invalid value, will be restored by the input component
          return;
        }

        setFieldValues((prev) => ({ ...prev, [field.name]: value }));
      } catch {
        // Invalid format, input component will restore
      }
    },
    [],
  );

  // ── Apply register value (reverse annotation) ──
  const handleApplyRegValue = useCallback(() => {
    try {
      const inputText = regValueInput.trim();
      if (!inputText) return;

      const value = parseNumberFromString(inputText);

      // Validate 32-bit range
      if (value < 0 || value > 0xffffffff) {
        setRegValueError('寄存器值超出 32 位范围 (0 - 0xFFFFFFFF)');
        return;
      }

      setRegValueError('');

      // Extract field values from register value
      const extracted = extractAllFieldValues(register, value);
      setFieldValues(extracted);
    } catch (err) {
      setRegValueError(`寄存器值格式错误: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [regValueInput, register]);

  // ── Reset to default values ──
  const handleReset = useCallback(() => {
    const values = initFieldValues(register);
    setFieldValues(values);
    setRegValueError('');
  }, [register]);

  const nonReserved = getNonReservedFields(register);
  const writableCount = getWritableFields(register).length;
  const formattedRegValue = formatRegisterValue(registerValue, format);

  return (
    <div className="flex min-w-0 flex-1 flex-col rounded border border-border">
      {/* Top panel: register info + format + reg value input */}
      <div className="border-b border-border bg-muted/10 p-2">
        {/* Row 1: register info + format selector */}
        <div className="flex items-center gap-3">
          <div className="flex-1 rounded border border-green-500/30 bg-green-500/5 px-3 py-1.5">
            <span className="font-mono text-sm font-bold text-green-700 dark:text-green-400">
              {register.name} @ {register.offset}: [{formattedRegValue}]
            </span>
          </div>
          <label className="text-xs font-semibold text-blue-600 dark:text-blue-400">格式:</label>
          <select
            value={format}
            onChange={(e) => handleFormatChange(e.target.value as NumberFormat)}
            className="rounded border-2 border-blue-500/50 bg-background px-2 py-1 text-xs font-medium"
          >
            <option value="hexadecimal">十六进制 (0x)</option>
            <option value="decimal">十进制</option>
            <option value="binary">二进制 (0b)</option>
          </select>
        </div>
        {/* Row 2: register value input + apply + reset */}
        <div className="mt-2 flex items-center gap-2">
          <label className="text-xs font-bold text-orange-600 dark:text-orange-400">寄存器值:</label>
          <input
            type="text"
            value={regValueInput}
            onChange={(e) => {
              setRegValueInput(e.target.value);
              setRegValueError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleApplyRegValue();
            }}
            placeholder="输入寄存器值以反标到各字段..."
            className="min-w-0 flex-1 rounded border-2 border-orange-500/50 bg-background px-2 py-1 font-mono text-xs"
          />
          <button
            onClick={handleApplyRegValue}
            className="flex items-center gap-1 rounded bg-orange-500 px-2.5 py-1 text-xs font-bold text-white hover:bg-orange-600"
          >
            <Check className="h-3 w-3" />
            应用
          </button>
          <button
            onClick={handleReset}
            className="flex items-center gap-1 rounded bg-gray-500 px-2.5 py-1 text-xs font-bold text-white hover:bg-gray-600"
          >
            <RotateCcw className="h-3 w-3" />
            重置
          </button>
        </div>
        {regValueError && (
          <div className="mt-1 text-[10px] text-red-500">{regValueError}</div>
        )}
      </div>

      {/* Field list header */}
      <div className="border-b border-border bg-muted/30 px-3 py-1.5 text-xs font-semibold">
        ⚙️ 寄存器字段
      </div>

      {/* Scrollable field list */}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {nonReserved.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            该寄存器没有可编辑的字段
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {nonReserved.map((field) => (
              <FieldRow
                key={field.name}
                field={field}
                value={fieldValues[field.name] ?? 0}
                format={format}
                onChange={handleFieldValueChange}
              />
            ))}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="border-t border-border bg-muted/30 px-3 py-1 text-center text-[10px] text-muted-foreground">
        📝 {nonReserved.length} 个字段 ({writableCount} 个可编辑)
      </div>
    </div>
  );
}

// ── Field row (ported from widgets.py create_field_widget) ──────────

function FieldRow({
  field,
  value,
  format,
  onChange,
}: {
  field: FieldInfo;
  value: number;
  format: NumberFormat;
  onChange: (field: FieldInfo, text: string) => void;
}) {
  const [inputValue, setInputValue] = useState('');
  const readOnly = isReadOnlyField(field);
  const bitWidth = getBitWidth(field.bitRange);
  const maxValue = (1 << bitWidth) - 1;

  // Sync input value when format or value changes
  useEffect(() => {
    setInputValue(formatNumber(value, format, bitWidth));
  }, [value, format, bitWidth]);

  const handleChange = (text: string) => {
    setInputValue(text);
    onChange(field, text);
  };

  // If onChange fails validation, restore previous display
  const handleBlur = () => {
    setInputValue(formatNumber(value, format, bitWidth));
  };

  return (
    <div className="rounded border border-border/60 bg-muted/5 p-2 hover:border-border">
      {/* Row 1: field name + bit range + RW attribute */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold">{field.name}</span>
        <span className="rounded border border-blue-300/50 bg-blue-50 px-1.5 py-0.5 font-mono text-[9px] text-blue-600 dark:border-blue-700/50 dark:bg-blue-950/30 dark:text-blue-400">
          [{field.bitRange}]
        </span>
        <span
          className={cn(
            'rounded border px-1.5 py-0.5 text-[9px] font-bold',
            readOnly
              ? 'border-red-300/50 bg-red-50 text-red-600 dark:border-red-700/50 dark:bg-red-950/30 dark:text-red-400'
              : 'border-green-300/50 bg-green-50 text-green-600 dark:border-green-700/50 dark:bg-green-950/30 dark:text-green-400',
          )}
        >
          {field.rwAttribute}
        </span>
      </div>
      {/* Row 2: value input */}
      <div className="mt-1">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={handleBlur}
          disabled={readOnly}
          className={cn(
            'w-full rounded border px-2 py-1 font-mono text-xs',
            readOnly
              ? 'border-border/50 bg-muted/20 text-muted-foreground'
              : 'border-border bg-background focus:border-green-500/50 focus:bg-green-50/30 dark:focus:bg-green-950/10',
          )}
          title={
            readOnly
              ? `只读字段，不可编辑\n复位值: ${field.resetValue}`
              : `可编辑字段\n位宽: ${bitWidth} 位\n最大值: ${maxValue}`
          }
        />
      </div>
      {/* Row 3: description (if any) */}
      {field.description && (
        <div className="mt-0.5 text-[9px] italic text-muted-foreground">{field.description}</div>
      )}
    </div>
  );
}

// ── Help dialog (ported from main_window.py HelpDialog) ─────────────

function HelpDialog({ onClose }: { onClose: () => void }) {
  const sections: Array<{ title: string; content: string | string[] }> = [
    {
      title: '📋 功能概述',
      content: '寄存器表格解析器用于解析 Excel 格式的寄存器规格表，提供可视化显示和交互式字段编辑功能。',
    },
    {
      title: '📁 文件加载',
      content: [
        '• 点击"加载 Excel 文件"按钮选择寄存器规格表文件',
        '• 支持 .xlsx 和 .xls 格式的 Excel 文件',
        '• 文件加载后会自动解析并显示结果',
      ],
    },
    {
      title: '📊 文件格式要求',
      content: [
        '• 表头信息：前 4 行包含项目名称、子系统、模块名称、基地址',
        '• 第 10 行：寄存器表头',
        '• 第 11 行：Register group（跳过）',
        '• 第 12 行以后：寄存器数据',
      ],
    },
    {
      title: '🔍 寄存器搜索',
      content: [
        '• 在搜索框中输入关键词',
        '• 支持按寄存器名称模糊搜索',
        '• 支持按偏移地址搜索（十六进制或十进制）',
        '• 搜索结果实时更新（300ms 防抖）',
      ],
    },
    {
      title: '⚙️ 字段编辑功能',
      content: [
        '• 正向编辑：修改字段值，自动计算寄存器值',
        '• 反向编辑：输入寄存器值，自动反标到各字段',
        '• 格式转换：支持十六进制、十进制、二进制切换',
        '• 实时同步：字段值与寄存器值实时双向同步',
      ],
    },
    {
      title: '🔄 寄存器反标功能',
      content: [
        '• 在"寄存器值"输入框中输入完整的寄存器值',
        '• 支持 0x 前缀十六进制、十进制、0b 前缀二进制',
        '• 点击"应用"按钮或按回车键应用到各字段',
        '• 点击"重置"按钮恢复所有字段的默认值',
      ],
    },
    {
      title: '🔧 自动格式修复',
      content: [
        '• 自动检测并修复 Excel 格式兼容性问题',
        '• 清理异常字符（BOM、零宽空格、不间断空格等）',
        '• 默认启用，可通过工具栏复选框控制',
      ],
    },
    {
      title: '❓ 常见问题',
      content: [
        '• 解析失败：检查 Excel 文件格式是否符合要求',
        '• .xls 文件需使用自动修复功能',
        '• 值超范围：确保寄存器值在 32 位范围内（0-0xFFFFFFFF）',
      ],
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[800px] max-w-[90vw] flex-col rounded-lg border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 className="text-lg font-bold">📚 寄存器表格解析器使用说明</h2>
          <button onClick={onClose} className="rounded px-2 py-1 text-xs hover:bg-accent">
            ✕
          </button>
        </div>
        {/* Content */}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="flex flex-col gap-4">
            {sections.map((section, i) => (
              <div key={i}>
                <div className="rounded-l border-l-4 border-blue-500 bg-blue-50 px-3 py-1.5 text-sm font-bold text-blue-700 dark:bg-blue-950/30 dark:text-blue-400">
                  {section.title}
                </div>
                {typeof section.content === 'string' ? (
                  <div className="mt-1 rounded border border-border bg-muted/10 px-3 py-2 text-xs">
                    {section.content}
                  </div>
                ) : (
                  <div className="mt-1 flex flex-col gap-1">
                    {section.content.map((item, j) => (
                      <div
                        key={j}
                        className="rounded border border-border bg-muted/10 px-3 py-1.5 text-xs"
                      >
                        {item}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        {/* Footer */}
        <div className="flex justify-end border-t border-border p-3">
          <button
            onClick={onClose}
            className="rounded bg-blue-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-blue-700"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
