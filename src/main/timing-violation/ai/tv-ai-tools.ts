/**
 * TV AI Advisor — 自定义 Host Tool 定义
 *
 * 定义 AI Agent 可调用的工具，用于查询时序违例数据库。
 * 这些工具注册到会话的 HostToolsRegistry 中，AI 可在分析过程中调用。
 */

import type Database from 'better-sqlite3';
import type { AgentToolResult } from '../../host/types';
import type { CustomToolDefinition } from '../../agent/types';

/** 工具定义（名称 + 描述 + 参数 schema + handler） */
export type TVToolDefinition = {
  definition: CustomToolDefinition;
  handler: (args: Record<string, unknown>) => Promise<AgentToolResult | string>;
};

const TEXT = (text: string): AgentToolResult => ({ content: [{ type: 'text', text }] });

/**
 * 创建 TV AI 工具集。
 *
 * @param db 时序违例数据库实例
 * @returns 工具定义数组
 */
export function createTVTools(db: Database.Database): TVToolDefinition[] {
  return [
    // ─── 查询单条违例详情 ───────────────────────────────
    {
      definition: {
        name: 'get_violation_detail',
        description: '查询指定 ID 的时序违例详情，包括确认状态和历史确认信息。',
        parameters: {
          type: 'object',
          properties: {
            violationId: {
              type: 'number',
              description: '违例 ID',
            },
          },
          required: ['violationId'],
        },
      },
      handler: async (args) => {
        const violationId = args.violationId as number;
        const row = db.prepare(`
          SELECT
            v.id, v.case_name, v.corner, v.seed, v.subsys, v.num,
            v.hier, v.time_fs, v.time_display, v.check_info, v.file_path,
            v.created_at,
            COALESCE(c.status, 'pending') as status,
            c.confirmer, c.result, c.reason,
            COALESCE(c.is_auto_confirmed, 0) as is_auto_confirmed,
            c.confirmed_at
          FROM timing_violations v
          LEFT JOIN confirmation_records c ON v.id = c.violation_id
          WHERE v.id = ?
        `).get(violationId) as Record<string, unknown> | undefined;

        if (!row) {
          return TEXT(`未找到 ID 为 ${violationId} 的违例记录`);
        }

        return TEXT(JSON.stringify(row, null, 2));
      },
    },

    // ─── 按 Hier 查询历史 Pattern ───────────────────────
    {
      definition: {
        name: 'get_patterns_by_hier',
        description: '按层级路径 (hier) 查询历史确认 Pattern，返回相同 hier 的已确认模式。',
        parameters: {
          type: 'object',
          properties: {
            hier: {
              type: 'string',
              description: '层级路径',
            },
          },
          required: ['hier'],
        },
      },
      handler: async (args) => {
        const hier = args.hier as string;
        const rows = db.prepare(`
          SELECT id, hier_pattern, check_pattern,
                 default_confirmer, default_result, default_reason,
                 match_count, last_used
          FROM violation_patterns
          WHERE hier_pattern = ?
          ORDER BY last_used DESC
        `).all(hier) as Record<string, unknown>[];

        if (rows.length === 0) {
          return TEXT(`未找到 hier 为 "${hier}" 的历史 Pattern`);
        }

        return TEXT(JSON.stringify(rows, null, 2));
      },
    },

    // ─── 查询违例统计信息 ───────────────────────────────
    {
      definition: {
        name: 'get_violation_stats',
        description: '查询时序违例统计信息，可按 hier 或 corner 筛选。返回总数、已确认数、Pass/Issue 分布等。',
        parameters: {
          type: 'object',
          properties: {
            hier: {
              type: 'string',
              description: '可选：按层级路径筛选',
            },
            corner: {
              type: 'string',
              description: '可选：按 corner 筛选',
            },
          },
        },
      },
      handler: async (args) => {
        const conditions: string[] = [];
        const params: Record<string, unknown> = {};

        if (typeof args.hier === 'string' && args.hier) {
          conditions.push('v.hier = @hier');
          params.hier = args.hier;
        }
        if (typeof args.corner === 'string' && args.corner) {
          conditions.push('v.corner = @corner');
          params.corner = args.corner;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const totalRow = db.prepare(`
          SELECT COUNT(*) as total,
                 SUM(CASE WHEN COALESCE(c.status, 'pending') = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
                 SUM(CASE WHEN COALESCE(c.status, 'pending') = 'pending' THEN 1 ELSE 0 END) as pending,
                 SUM(CASE WHEN COALESCE(c.status, 'pending') = 'ignored' THEN 1 ELSE 0 END) as ignored,
                 SUM(CASE WHEN c.result = 'pass' THEN 1 ELSE 0 END) as pass_count,
                 SUM(CASE WHEN c.result = 'issue' THEN 1 ELSE 0 END) as issue_count
          FROM timing_violations v
          LEFT JOIN confirmation_records c ON v.id = c.violation_id
          ${whereClause}
        `).get(params) as Record<string, number>;

        return TEXT(JSON.stringify(totalRow, null, 2));
      },
    },

    // ─── 查询相似已确认违例 ─────────────────────────────
    {
      definition: {
        name: 'query_similar_violations',
        description: '查询同 hier 路径下已确认的违例记录，用于参考历史确认决策。',
        parameters: {
          type: 'object',
          properties: {
            hier: {
              type: 'string',
              description: '层级路径',
            },
            limit: {
              type: 'number',
              description: '返回条数上限，默认 10',
            },
          },
          required: ['hier'],
        },
      },
      handler: async (args) => {
        const hier = args.hier as string;
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 50) : 10;

        const rows = db.prepare(`
          SELECT
            v.id, v.case_name, v.corner, v.seed, v.num,
            v.hier, v.time_fs, v.time_display, v.check_info,
            c.status, c.confirmer, c.result, c.reason
          FROM timing_violations v
          JOIN confirmation_records c ON v.id = c.violation_id
          WHERE v.hier = ? AND c.status = 'confirmed'
          ORDER BY c.confirmed_at DESC
          LIMIT ?
        `).all(hier, limit) as Record<string, unknown>[];

        if (rows.length === 0) {
          return TEXT(`未找到 hier 为 "${hier}" 的已确认违例记录`);
        }

        return TEXT(JSON.stringify(rows, null, 2));
      },
    },
  ];
}
