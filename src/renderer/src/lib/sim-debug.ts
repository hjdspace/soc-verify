/**
 * 仿真 Debug 快捷按钮共享类型与工具（UI 方案 B 终端工具栏 + C 运行列表行内按钮）。
 *
 * DebugArtifacts 与主进程 simulation.resolveDebugArtifacts 的返回结构一致。
 */

/** Debug 产物解析结果（simulation.resolveDebugArtifacts 返回） */
export type DebugArtifacts = {
  /** 用例目录（$PROJ_WORK/<case_dir>） */
  caseDir: string | null;
  /** 仿真日志路径（log/irun_sim.log 等） */
  simLogPath: string | null;
  /** 编译日志路径（log/irun_compile.log 等） */
  compileLogPath: string | null;
  /** 反汇编文件（*_sw_build 下的 .asm） */
  asmFiles: string[];
  /** Verdi 启动模式：vcs（simv.daidir/vcdplus.vpd）或 xrun */
  verdiMode: 'vcs' | 'xrun' | null;
  /** 全部匹配的用例目录（有序） */
  matchedCaseDirs: string[];
};

/** 路径取文件名（渲染进程不可用 node:path） */
export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
