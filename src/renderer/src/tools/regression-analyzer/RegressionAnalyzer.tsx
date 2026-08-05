/**
 * RegressionAnalyzer — regression result analysis tool.
 *
 * Ported from the Python `regression_result_analyzer` plugin.
 * Features: scan regression directories, view pass/fail cases by timestamp,
 * aggregate overview, parse compile/sim times, export report.
 */

import { useState, useCallback, useMemo } from 'react';
import { FolderOpen, Search, RefreshCw, Clock, Download, ChevronRight } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

type CaseRow = {
  caseName: string;
  status: string;
  seed: string;
  corner: string;
  compileTime: number | null;
  simTime: number | null;
  log: string | null;
  command: string;
};

type OverviewRow = {
  caseName: string;
  finalStatus: string;
  executionCount: number;
  corner: string;
  avgSimTime: number | null;
  latestCompileTime: number | null;
  seeds: string[];
  latestLog: string | null;
  latestCommand: string;
  isPostSim: boolean;
};

type ScanData = {
  timestamps: { ts: string; passCount: number; failCount: number }[];
  groups: { name: string; passCount: number; failCount: number }[];
  overview: OverviewRow[];
  passCases: CaseRow[];
  failCases: CaseRow[];
};

export function RegressionAnalyzer({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [regDir, setRegDir] = useState(projectRoot ? `${projectRoot}/work/regression` : '');
  const [scanData, setScanData] = useState<ScanData | null>(null);
  const [selectedTs, setSelectedTs] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [activeTab, setActiveTab] = useState<'overview' | 'pass' | 'fail'>('overview');
  const [scanning, setScanning] = useState(false);
  const [parsingTimes, setParsingTimes] = useState(false);
  const [status, setStatus] = useState('就绪');
  const [rawData, setRawData] = useState<RawData | null>(null);

  const handleBrowse = useCallback(async () => {
    const res = await trpc.tools.selectDirectory.mutate({
      title: '选择回归结果目录',
      defaultPath: regDir || projectRoot || undefined,
    });
    if (res.path) {
      setRegDir(res.path);
    }
  }, [regDir, projectRoot]);

  const handleScan = useCallback(async () => {
    if (!regDir) {
      setStatus('请输入回归目录');
      return;
    }
    setScanning(true);
    setStatus('正在扫描回归目录...');
    try {
      const result = await trpc.tools.regressionAnalyzer.scan.mutate({ regressionDir: regDir });
      const data = result.data as RawData;
      setRawData(data);
      setSelectedTs(null);
      setSelectedGroup(null);

      const timestamps = result.timestamps.map((ts: string) => {
        const tsData = data[ts];
        let passCount = 0;
        let failCount = 0;
        for (const cases of Object.values(tsData.pass)) passCount += cases.length;
        for (const cases of Object.values(tsData.fail)) failCount += cases.length;
        return { ts, passCount, failCount };
      });

      setScanData({
        timestamps,
        groups: [],
        overview: buildOverview(data, undefined),
        passCases: [],
        failCases: [],
      });

      setStatus(`扫描完成：共 ${result.totalCount} 个用例（PASS ${result.passCount}，FAIL ${result.failCount}）`);
    } catch (err) {
      setStatus(`扫描失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setScanning(false);
    }
  }, [regDir]);

  const handleTimestampClick = useCallback((ts: string) => {
    if (!rawData) return;
    setSelectedTs(ts);
    setSelectedGroup(null);

    const tsData = rawData[ts];

    const allGroups = new Set([...Object.keys(tsData.pass), ...Object.keys(tsData.fail)]);
    const groups = Array.from(allGroups).sort().map((name) => {
      const passCount = (tsData.pass[name] ?? []).length;
      const failCount = (tsData.fail[name] ?? []).length;
      return { name, passCount, failCount };
    });

    const { passCases, failCases } = buildAllCases(tsData);
    const overview = buildOverview(rawData, ts);

    setScanData((prev) => prev ? { ...prev, groups, overview, passCases, failCases } : null);
    setActiveTab('overview');
  }, [rawData]);

  const handleGroupClick = useCallback((group: string) => {
    if (!rawData || !selectedTs) return;
    setSelectedGroup(group);

    const tsData = rawData[selectedTs];
    const { passCases, failCases } = buildGroupCases(tsData, group);

    setScanData((prev) => prev ? { ...prev, passCases, failCases } : null);
  }, [rawData, selectedTs]);

  const handleShowAll = useCallback(() => {
    if (!rawData) return;
    setSelectedTs(null);
    setSelectedGroup(null);
    setScanData((prev) => prev ? {
      ...prev,
      groups: [],
      overview: buildOverview(rawData, undefined),
      passCases: [],
      failCases: [],
    } : null);
  }, [rawData]);

  const handleParseTimes = useCallback(async () => {
    if (!rawData) return;
    setParsingTimes(true);
    setStatus('正在解析编译和仿真时间...');
    try {
      const result = await trpc.tools.regressionAnalyzer.parseTimes.mutate({ data: rawData as never });
      const data = result.data as RawData;
      setRawData(data);
      const overview = buildOverview(data, selectedTs ?? undefined);
      setScanData((prev) => prev ? { ...prev, overview } : null);
      setStatus('时间解析完成');
    } catch (err) {
      setStatus(`时间解析失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setParsingTimes(false);
    }
  }, [rawData, selectedTs]);

  const handleExport = useCallback(async () => {
    if (!rawData || !scanData) return;
    try {
      const res = await trpc.tools.saveFileDialog.mutate({
        title: '导出回归测试报告',
        defaultPath: `regression_report${selectedTs ? `_${selectedTs}` : '_all'}.html`,
        filters: [{ name: 'HTML 文件', extensions: ['html'] }],
      });
      if (!res.path) return;

      await trpc.tools.regressionAnalyzer.exportReport.mutate({
        data: rawData as never,
        currentTimestamp: selectedTs,
        savePath: res.path,
      });
      setStatus(`报告已导出到: ${res.path}`);
    } catch (err) {
      setStatus(`导出失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [rawData, scanData, selectedTs]);

  // Filter rows by search text
  const filterRows = useCallback(<T extends { caseName: string }>(rows: T[]): T[] => {
    if (!searchText) return rows;
    const q = searchText.toLowerCase();
    return rows.filter((r) => r.caseName.toLowerCase().includes(q));
  }, [searchText]);

  const filteredOverview = useMemo(() => scanData ? filterRows(scanData.overview) : [], [scanData, filterRows]);
  const filteredPass = useMemo(() => scanData ? filterRows(scanData.passCases) : [], [scanData, filterRows]);
  const filteredFail = useMemo(() => scanData ? filterRows(scanData.failCases) : [], [scanData, filterRows]);

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <input type="hidden" value={projectRoot ?? ''} onChange={(e) => onProjectRootChange(e.target.value)} />

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium whitespace-nowrap">回归目录:</span>
        <input
          type="text"
          value={regDir}
          onChange={(e) => setRegDir(e.target.value)}
          placeholder="输入回归结果目录路径..."
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
        />
        <button onClick={handleBrowse} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent">
          <FolderOpen className="h-3 w-3" />
          浏览
        </button>
        <button onClick={handleScan} disabled={scanning} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50">
          <RefreshCw className={cn('h-3 w-3', scanning && 'animate-spin')} />
          扫描
        </button>
        <button onClick={handleParseTimes} disabled={parsingTimes || !scanData} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50">
          <Clock className="h-3 w-3" />
          解析时间
        </button>
        <button onClick={handleExport} disabled={!scanData} className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50">
          <Download className="h-3 w-3" />
          导出报告
        </button>
      </div>

      {/* ── Status ── */}
      <div className="text-xs text-muted-foreground">{status}</div>

      {/* ── Main content ── */}
      <div className="flex min-h-0 flex-1 gap-2">
        {/* Left panel: timestamps + groups */}
        <div className="flex w-64 shrink-0 flex-col gap-2 overflow-auto rounded border border-border p-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">回归时间戳</span>
            <button onClick={handleShowAll} className="text-[10px] text-primary hover:underline">
              显示全部
            </button>
          </div>
          <div className="flex flex-col gap-0.5">
            {scanData?.timestamps.map((t) => (
              <button
                key={t.ts}
                onClick={() => handleTimestampClick(t.ts)}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-1 text-left text-xs hover:bg-accent',
                  selectedTs === t.ts && 'bg-accent',
                )}
              >
                <ChevronRight className="h-3 w-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono">{t.ts}</span>
                <span className="text-green-500">{t.passCount}</span>
                <span className="text-red-500">{t.failCount}</span>
              </button>
            )) ?? (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">无数据</div>
            )}
          </div>

          {scanData && scanData.groups.length > 0 && (
            <>
              <div className="mt-2 border-t border-border pt-2">
                <span className="text-xs font-semibold">用例组</span>
              </div>
              <div className="flex flex-col gap-0.5">
                {scanData.groups.map((g) => (
                  <button
                    key={g.name}
                    onClick={() => handleGroupClick(g.name)}
                    className={cn(
                      'flex items-center gap-1 rounded px-2 py-1 text-left text-xs hover:bg-accent',
                      selectedGroup === g.name && 'bg-accent',
                    )}
                  >
                    <ChevronRight className="h-3 w-3 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{g.name}</span>
                    <span className="text-green-500">{g.passCount}</span>
                    <span className="text-red-500">{g.failCount}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Right panel: tables */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* Search */}
          <div className="flex items-center gap-2">
            <Search className="h-3 w-3 text-muted-foreground" />
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="输入关键字搜索..."
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
            />
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 border-b border-border">
            {(['overview', 'pass', 'fail'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'border-b-2 px-3 py-1.5 text-xs font-medium',
                  activeTab === tab
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {tab === 'overview' ? `总览表 (${filteredOverview.length})` : tab === 'pass' ? `PASS用例 (${filteredPass.length})` : `FAIL用例 (${filteredFail.length})`}
              </button>
            ))}
          </div>

          {/* Table */}
          <div className="min-h-0 flex-1 overflow-auto rounded border border-border">
            {!scanData ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                请选择回归目录并点击"扫描"
              </div>
            ) : activeTab === 'overview' ? (
              <OverviewTable rows={filteredOverview} />
            ) : activeTab === 'pass' ? (
              <DetailTable rows={filteredPass} />
            ) : (
              <DetailTable rows={filteredFail} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Overview table ─────────────────────────────────────────────────

function OverviewTable({ rows }: { rows: OverviewRow[] }) {
  if (rows.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">无数据</div>;
  }

  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-muted">
        <tr>
          <th className="border-b border-border px-2 py-2 text-left font-semibold">用例名</th>
          <th className="border-b border-border px-2 py-2 text-center font-semibold w-16">状态</th>
          <th className="border-b border-border px-2 py-2 text-center font-semibold w-16">次数</th>
          <th className="border-b border-border px-2 py-2 text-center font-semibold w-20">Corner</th>
          <th className="border-b border-border px-2 py-2 text-right font-semibold w-24">仿真时间</th>
          <th className="border-b border-border px-2 py-2 text-right font-semibold w-24">编译时间</th>
          <th className="border-b border-border px-2 py-2 text-left font-semibold">种子</th>
          <th className="border-b border-border px-2 py-2 text-left font-semibold">日志</th>
          <th className="border-b border-border px-2 py-2 text-left font-semibold">命令</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="hover:bg-accent/50">
            <td className="border-b border-border px-2 py-1.5">{row.caseName}</td>
            <td className={cn('border-b border-border px-2 py-1.5 text-center font-medium', row.finalStatus === 'PASS' ? 'text-green-500' : 'text-red-500')}>
              {row.finalStatus}
            </td>
            <td className="border-b border-border px-2 py-1.5 text-center tabular-nums">{row.executionCount}</td>
            <td className="border-b border-border px-2 py-1.5 text-center">{row.corner}</td>
            <td className="border-b border-border px-2 py-1.5 text-right tabular-nums">
              {row.avgSimTime !== null ? row.avgSimTime.toFixed(2) : '-'}
            </td>
            <td className="border-b border-border px-2 py-1.5 text-right tabular-nums">
              {row.latestCompileTime !== null ? row.latestCompileTime.toFixed(2) : '-'}
            </td>
            <td className="border-b border-border px-2 py-1.5">
              <span className="block max-w-[120px] truncate text-[10px] text-muted-foreground" title={row.seeds.join(', ')}>
                {row.seeds.join(', ')}
              </span>
            </td>
            <td className="border-b border-border px-2 py-1.5">
              <span className="block max-w-[200px] truncate text-[10px] text-blue-500" title={row.latestLog ?? ''}>
                {row.latestLog ?? '-'}
              </span>
            </td>
            <td className="border-b border-border px-2 py-1.5">
              <span className="block max-w-[300px] truncate font-mono text-[10px] text-green-600" title={row.latestCommand}>
                {row.latestCommand}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Detail table ───────────────────────────────────────────────────

function DetailTable({ rows }: { rows: CaseRow[] }) {
  if (rows.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">无数据</div>;
  }

  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-muted">
        <tr>
          <th className="border-b border-border px-2 py-2 text-left font-semibold">用例名</th>
          <th className="border-b border-border px-2 py-2 text-center font-semibold w-16">状态</th>
          <th className="border-b border-border px-2 py-2 text-center font-semibold w-20">种子</th>
          <th className="border-b border-border px-2 py-2 text-center font-semibold w-20">Corner</th>
          <th className="border-b border-border px-2 py-2 text-right font-semibold w-24">编译时间</th>
          <th className="border-b border-border px-2 py-2 text-right font-semibold w-24">仿真时间</th>
          <th className="border-b border-border px-2 py-2 text-left font-semibold">日志</th>
          <th className="border-b border-border px-2 py-2 text-left font-semibold">命令</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="hover:bg-accent/50">
            <td className="border-b border-border px-2 py-1.5">{row.caseName}</td>
            <td className={cn('border-b border-border px-2 py-1.5 text-center font-medium', row.status === 'PASS' ? 'text-green-500' : 'text-red-500')}>
              {row.status}
            </td>
            <td className="border-b border-border px-2 py-1.5 text-center tabular-nums">{row.seed}</td>
            <td className="border-b border-border px-2 py-1.5 text-center">{row.corner || '-'}</td>
            <td className="border-b border-border px-2 py-1.5 text-right tabular-nums">
              {row.compileTime !== null ? row.compileTime.toFixed(2) : '-'}
            </td>
            <td className="border-b border-border px-2 py-1.5 text-right tabular-nums">
              {row.simTime !== null ? row.simTime.toFixed(2) : '-'}
            </td>
            <td className="border-b border-border px-2 py-1.5">
              <span className="block max-w-[200px] truncate text-[10px] text-blue-500" title={row.log ?? ''}>
                {row.log ?? '-'}
              </span>
            </td>
            <td className="border-b border-border px-2 py-1.5">
              <span className="block max-w-[300px] truncate font-mono text-[10px] text-green-600" title={row.command}>
                {row.command}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Helper functions ───────────────────────────────────────────────

type RawData = Record<string, {
  pass: Record<string, Array<Record<string, unknown>>>;
  fail: Record<string, Array<Record<string, unknown>>>;
}>;

function buildOverview(data: RawData, specificTs?: string): OverviewRow[] {
  const aggregated: Record<string, OverviewRow & { simTimes: number[]; latestTimestamp: string }> = {};
  const isPostSim = checkPostSim(data, specificTs ? [specificTs] : Object.keys(data));

  const timestamps = specificTs ? [specificTs] : Object.keys(data).sort().reverse();

  for (const ts of timestamps) {
    if (!(ts in data)) continue;
    const tsData = data[ts];

    for (const resultType of ['pass', 'fail'] as const) {
      for (const cases of Object.values(tsData[resultType])) {
        for (const c of cases) {
          const caseName = c.case as string;
          const corner = (c.sdfCorner as string ?? '').trim();
          const key = isPostSim && corner ? `${caseName}_${corner}` : caseName;
          const tag = (c.tag as string ?? '').replace(/[\[\]]/g, '');

          if (!(key in aggregated)) {
            aggregated[key] = {
              caseName,
              corner: corner || '-',
              finalStatus: tag,
              executionCount: 1,
              avgSimTime: null,
              simTimes: c.simTime != null ? [c.simTime as number] : [],
              latestCompileTime: (c.compileTime as number | null) ?? null,
              seeds: [(c.seed as string ?? '').replace(/[\[\]]/g, '')],
              latestLog: (c.log as string | null) ?? null,
              latestCommand: (c.command as string) ?? '',
              latestTimestamp: ts,
              isPostSim: (c.isPostSim as boolean) ?? false,
            };
          } else {
            const agg = aggregated[key];
            agg.executionCount++;
            if (!specificTs && ts >= agg.latestTimestamp) {
              agg.finalStatus = tag;
              agg.latestCompileTime = (c.compileTime as number | null) ?? null;
              agg.latestLog = (c.log as string | null) ?? null;
              agg.latestCommand = (c.command as string) ?? '';
              agg.latestTimestamp = ts;
            } else if (specificTs && resultType === 'fail') {
              agg.finalStatus = tag;
              agg.latestLog = (c.log as string | null) ?? null;
              agg.latestCommand = (c.command as string) ?? '';
            }
            if (c.simTime != null) agg.simTimes.push(c.simTime as number);
            const seedVal = (c.seed as string ?? '').replace(/[\[\]]/g, '');
            if (!agg.seeds.includes(seedVal)) agg.seeds.push(seedVal);
          }
        }
      }
    }
  }

  // Calculate avg sim time
  for (const agg of Object.values(aggregated)) {
    if (agg.simTimes.length > 0) {
      if (agg.isPostSim) {
        agg.avgSimTime = agg.simTimes[agg.simTimes.length - 1];
      } else {
        agg.avgSimTime = agg.simTimes.reduce((a, b) => a + b, 0) / agg.simTimes.length;
      }
    }
  }

  return Object.values(aggregated).map(({ simTimes, ...rest }) => rest).sort((a, b) => a.caseName.localeCompare(b.caseName));
}

function checkPostSim(data: RawData, timestamps: string[]): boolean {
  for (const ts of timestamps) {
    if (!(ts in data)) continue;
    for (const resultType of ['pass', 'fail'] as const) {
      for (const cases of Object.values(data[ts][resultType])) {
        for (const c of cases) {
          if (c.isPostSim) return true;
        }
      }
    }
  }
  return false;
}

function buildAllCases(tsData: RawData[string]): { passCases: CaseRow[]; failCases: CaseRow[] } {
  const passCases: CaseRow[] = [];
  const failCases: CaseRow[] = [];

  for (const cases of Object.values(tsData.pass)) {
    for (const c of cases) {
      passCases.push(toCaseRow(c));
    }
  }
  for (const cases of Object.values(tsData.fail)) {
    for (const c of cases) {
      failCases.push(toCaseRow(c));
    }
  }

  return { passCases, failCases };
}

function buildGroupCases(tsData: RawData[string], group: string): { passCases: CaseRow[]; failCases: CaseRow[] } {
  const passCases: CaseRow[] = [];
  const failCases: CaseRow[] = [];

  for (const c of tsData.pass[group] ?? []) passCases.push(toCaseRow(c));
  for (const c of tsData.fail[group] ?? []) failCases.push(toCaseRow(c));

  return { passCases, failCases };
}

function toCaseRow(c: Record<string, unknown>): CaseRow {
  return {
    caseName: (c.case as string) ?? '',
    status: (c.tag as string ?? '').replace(/[\[\]]/g, ''),
    seed: (c.seed as string ?? '').replace(/[\[\]]/g, ''),
    corner: (c.sdfCorner as string ?? '').trim(),
    compileTime: (c.compileTime as number | null) ?? null,
    simTime: (c.simTime as number | null) ?? null,
    log: (c.log as string | null) ?? null,
    command: (c.command as string) ?? '',
  };
}
