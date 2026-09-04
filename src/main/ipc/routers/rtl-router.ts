/**
 * RTL 设计视图领域 router（ADR 0032）。
 *
 * S1（issue 01）仅提供三工具可用性状态查询（UI 降级提示数据源）；
 * Design Source 配置 / elaboration / 层级树查询在 S2+ 补充。
 */

import { t } from '../router-context';
import { getRtlToolsStatus } from '../../rtl/binary';

export const rtlRouter = t.router({
  /** 三工具（yosys / slang-server / verible）路径解析与可用性状态。 */
  toolsStatus: t.procedure.query(() => getRtlToolsStatus()),
});
