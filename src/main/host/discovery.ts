/**
 * SoC 验证项目子系统/用例发现接口
 *
 * M1 阶段仅定义接口 + NoopDiscovery 空实现。
 * M2 将提供基于文件系统扫描的具体实现，并支持插件替换。
 */

export type CaseStatus = 'pass' | 'fail' | 'running' | 'pending' | 'all';

export interface SubsysInfo {
  name: string;
  path: string;
  caseCount?: number;
  description?: string;
}

export interface CaseInfo {
  id?: string;
  name: string;
  subsys: string;
  path: string;
  status?: CaseStatus;
  duration?: number;
  description?: string;
  /** Base case name — set when this case inherits from another case (child case) */
  baseCase?: string;
  /** Config file path where this case was defined */
  filePath?: string;
  /** Simulation -base parameter parsed from config file path */
  base?: string;
  /** Simulation -block parameter parsed from config file path */
  block?: string;
}

export interface SimOptionsSchema {
  [key: string]: unknown;
}

/**
 * 子系统/用例发现接口
 *
 * 宿主通过此接口向 agent 提供项目结构信息。
 * 实现可以是文件系统扫描、数据库查询、远程 API 调用等。
 */
export interface SubsysDiscovery {
  listSubsys(filter?: string): Promise<SubsysInfo[]>;
  listCases(subsys?: string, status?: CaseStatus): Promise<CaseInfo[]>;
  getSimOptionsSchema(): Promise<SimOptionsSchema>;
}

/**
 * 默认空实现（M1 骨架）
 *
 * 所有方法返回空结果。M2 替换为基于文件系统扫描的具体实现。
 */
export class NoopDiscovery implements SubsysDiscovery {
  async listSubsys(_filter?: string): Promise<SubsysInfo[]> {
    return [];
  }

  async listCases(_subsys?: string, _status?: CaseStatus): Promise<CaseInfo[]> {
    return [];
  }

  async getSimOptionsSchema(): Promise<SimOptionsSchema> {
    return {};
  }
}
