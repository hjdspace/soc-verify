import { useEffect, useState } from 'react';
import { Loader2, Plus, RefreshCw, Save, X } from 'lucide-react';
import { useProjectStore } from '@renderer/stores/project';
import { useTvDataStore } from '@renderer/stores/timing-violation';
import { cn } from '@renderer/lib/utils';

/**
 * 时序违例配置 Tab — 编辑 TV 数据目录、Corner 列表、子系统识别规则、复位时间等。
 */

export function TimingViolationConfigTab() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const tvConfig = useTvDataStore((s) => s.tvConfig);
  const loadingConfig = useTvDataStore((s) => s.loadingConfig);
  const savingConfig = useTvDataStore((s) => s.savingConfig);
  const loadTvConfig = useTvDataStore((s) => s.loadTvConfig);
  const saveTvConfig = useTvDataStore((s) => s.saveTvConfig);

  // Local editing state
  const [dataDir, setDataDir] = useState('');
  const [corners, setCorners] = useState<string[]>([]);
  const [subsysPatterns, setSubsysPatterns] = useState<string[]>([]);
  const [defaultResetTimeNs, setDefaultResetTimeNs] = useState(1000);
  const [resetIntervalStartNs, setResetIntervalStartNs] = useState<string>('');
  const [resetIntervalEndNs, setResetIntervalEndNs] = useState<string>('');
  const [autoBackup, setAutoBackup] = useState(true);
  const [backupInterval, setBackupInterval] = useState(100);
  const [newCorner, setNewCorner] = useState('');
  const [newPattern, setNewPattern] = useState('');

  useEffect(() => {
    if (currentProjectId) {
      void loadTvConfig(currentProjectId);
    }
  }, [currentProjectId, loadTvConfig]);

  // Sync loaded config into local state
  useEffect(() => {
    if (tvConfig) {
      setDataDir(tvConfig.dataDir);
      setCorners([...tvConfig.corners]);
      setSubsysPatterns([...tvConfig.subsysPatterns]);
      setDefaultResetTimeNs(tvConfig.defaultResetTimeNs);
      setResetIntervalStartNs(tvConfig.resetIntervalStartNs != null ? String(tvConfig.resetIntervalStartNs) : '');
      setResetIntervalEndNs(tvConfig.resetIntervalEndNs != null ? String(tvConfig.resetIntervalEndNs) : '');
      setAutoBackup(tvConfig.autoBackup);
      setBackupInterval(tvConfig.backupInterval);
    }
  }, [tvConfig]);

  if (!currentProjectId) {
    return <p className="text-xs text-muted-foreground">请先打开项目</p>;
  }

  if (loadingConfig && !tvConfig) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
        <RefreshCw className="h-3 w-3 animate-spin" />
        加载配置中...
      </div>
    );
  }

  const handleSave = () => {
    void saveTvConfig(currentProjectId, {
      dataDir,
      corners,
      subsysPatterns,
      defaultResetTimeNs,
      resetIntervalStartNs: resetIntervalStartNs.trim() !== '' ? Number(resetIntervalStartNs) : null,
      resetIntervalEndNs: resetIntervalEndNs.trim() !== '' ? Number(resetIntervalEndNs) : null,
      autoBackup,
      backupInterval,
    });
  };

  const handleAddCorner = () => {
    const trimmed = newCorner.trim();
    if (trimmed && !corners.includes(trimmed)) {
      setCorners([...corners, trimmed]);
      setNewCorner('');
    }
  };

  const handleRemoveCorner = (corner: string) => {
    setCorners(corners.filter((c) => c !== corner));
  };

  const handleAddPattern = () => {
    const trimmed = newPattern.trim();
    if (trimmed && !subsysPatterns.includes(trimmed)) {
      setSubsysPatterns([...subsysPatterns, trimmed]);
      setNewPattern('');
    }
  };

  const handleRemovePattern = (pattern: string) => {
    setSubsysPatterns(subsysPatterns.filter((p) => p !== pattern));
  };

  return (
    <div className="space-y-4">
      {/* 数据根目录 */}
      <div>
        <label className="mb-1 block text-[10px] font-semibold uppercase text-muted-foreground">数据根目录</label>
        <input
          type="text"
          value={dataDir}
          onChange={(e) => setDataDir(e.target.value)}
          placeholder=".socverify/timing-violation"
          className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-primary"
        />
        <p className="mt-0.5 text-[10px] text-muted-foreground/70">
          相对于项目根目录，所有 TV 数据（数据库/导出/备份）统一存储在此目录下
        </p>
        <div className="mt-1 rounded border border-border/50 bg-secondary/20 px-2 py-1.5 text-[10px] text-muted-foreground/70">
          <div>数据库: <span className="font-mono">{dataDir || '.socverify/timing-violation'}/tv.db</span></div>
          <div>导出: <span className="font-mono">{dataDir || '.socverify/timing-violation'}/exports/</span></div>
          <div>备份: <span className="font-mono">{dataDir || '.socverify/timing-violation'}/backups/</span></div>
        </div>
      </div>

      {/* Corner 列表 */}
      <div>
        <label className="mb-1 block text-[10px] font-semibold uppercase text-muted-foreground">Corner 列表</label>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={newCorner}
            onChange={(e) => setNewCorner(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddCorner(); } }}
            placeholder="添加 corner（如 npg_f1_ssg）"
            className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={handleAddCorner}
            disabled={!newCorner.trim()}
            className={cn(
              'flex items-center gap-0.5 rounded px-2 py-1 text-[10px] font-medium transition-colors',
              newCorner.trim()
                ? 'bg-primary/10 text-primary hover:bg-primary/20'
                : 'cursor-not-allowed bg-muted text-muted-foreground',
            )}
          >
            <Plus className="h-3 w-3" />
            添加
          </button>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {corners.map((corner) => (
            <span
              key={corner}
              className="flex items-center gap-1 rounded border border-border bg-secondary/30 px-1.5 py-0.5 font-mono text-[10px]"
            >
              {corner}
              <button
                onClick={() => handleRemoveCorner(corner)}
                className="text-muted-foreground hover:text-destructive"
                title="删除"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          {corners.length === 0 && (
            <span className="text-[10px] text-muted-foreground/50">暂无 corner</span>
          )}
        </div>
      </div>

      {/* 子系统识别规则 */}
      <div>
        <label className="mb-1 block text-[10px] font-semibold uppercase text-muted-foreground">子系统识别规则</label>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddPattern(); } }}
            placeholder="添加规则（如 *_sys$）"
            className="flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={handleAddPattern}
            disabled={!newPattern.trim()}
            className={cn(
              'flex items-center gap-0.5 rounded px-2 py-1 text-[10px] font-medium transition-colors',
              newPattern.trim()
                ? 'bg-primary/10 text-primary hover:bg-primary/20'
                : 'cursor-not-allowed bg-muted text-muted-foreground',
            )}
          >
            <Plus className="h-3 w-3" />
            添加
          </button>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {subsysPatterns.map((pattern) => (
            <span
              key={pattern}
              className="flex items-center gap-1 rounded border border-border bg-secondary/30 px-1.5 py-0.5 font-mono text-[10px]"
            >
              {pattern}
              <button
                onClick={() => handleRemovePattern(pattern)}
                className="text-muted-foreground hover:text-destructive"
                title="删除"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          {subsysPatterns.length === 0 && (
            <span className="text-[10px] text-muted-foreground/50">暂无规则</span>
          )}
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground/70">支持 glob 通配符（如 *_sys$、^top$）</p>
      </div>

      {/* 默认复位时间 */}
      <div>
        <label className="mb-1 block text-[10px] font-semibold uppercase text-muted-foreground">默认复位时间（纳秒）</label>
        <input
          type="number"
          value={defaultResetTimeNs}
          onChange={(e) => setDefaultResetTimeNs(Number(e.target.value))}
          min={0}
          className="w-32 rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
        />
        <p className="mt-0.5 text-[10px] text-muted-foreground/70">自动确认时使用的默认复位时间阈值</p>
      </div>

      {/* 复位区间 */}
      <div>
        <label className="mb-1 block text-[10px] font-semibold uppercase text-muted-foreground">复位区间（纳秒，可选）</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={resetIntervalStartNs}
            onChange={(e) => setResetIntervalStartNs(e.target.value)}
            placeholder="起始"
            min={0}
            className="w-32 rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <span className="text-xs text-muted-foreground">~</span>
          <input
            type="number"
            value={resetIntervalEndNs}
            onChange={(e) => setResetIntervalEndNs(e.target.value)}
            placeholder="结束"
            min={0}
            className="w-32 rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground/70">留空表示不使用复位区间，AI 分析时也会参考此配置</p>
      </div>

      {/* 自动备份 */}
      <div className="flex items-center gap-2">
        <label className="text-[10px] font-semibold uppercase text-muted-foreground">自动备份</label>
        <button
          onClick={() => setAutoBackup(!autoBackup)}
          className={cn(
            'relative h-5 w-9 shrink-0 rounded-full transition-colors',
            autoBackup ? 'bg-primary' : 'bg-muted',
          )}
        >
          <span
            className={cn(
              'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-background transition-transform',
              autoBackup ? 'translate-x-4' : 'translate-x-0',
            )}
          />
        </button>
        {autoBackup && (
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">每</span>
            <input
              type="number"
              value={backupInterval}
              onChange={(e) => setBackupInterval(Number(e.target.value))}
              min={1}
              className="w-16 rounded border border-border bg-background px-1.5 py-0.5 text-xs outline-none focus:ring-1 focus:ring-primary"
            />
            <span className="text-[10px] text-muted-foreground">次操作备份一次</span>
          </div>
        )}
      </div>

      {/* 保存按钮 */}
      <div className="flex justify-end border-t border-border/50 pt-3">
        <button
          onClick={handleSave}
          disabled={savingConfig}
          className={cn(
            'flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors',
            savingConfig
              ? 'cursor-not-allowed bg-muted text-muted-foreground'
              : 'bg-primary text-primary-foreground hover:bg-primary/90',
          )}
        >
          {savingConfig ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          {savingConfig ? '保存中...' : '保存配置'}
        </button>
      </div>
    </div>
  );
}
