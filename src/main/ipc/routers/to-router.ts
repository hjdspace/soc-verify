/**
 * TO (Tape-Out) checklist router — checklist CRUD and report export.
 */

import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { t, TRPCError, requireProject } from '../router-context';
import type { TOChecklistItem } from '@shared/types';

export const toRouter = t.router({
  getChecklist: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const checklistPath = join(project.rootPath, '.socverify', 'to-checklist.json');
      try {
        const data = await readFile(checklistPath, 'utf-8');
        return JSON.parse(data) as TOChecklistItem[];
      } catch {
        // Return default checklist
        return [
          { id: 'cov-line', category: 'coverage', name: '行覆盖率达标', description: '行覆盖率 >= 95%', status: 'pending', autoEvaluated: true, threshold: 95 },
          { id: 'cov-toggle', category: 'coverage', name: '翻转覆盖率达标', description: '翻转覆盖率 >= 90%', status: 'pending', autoEvaluated: true, threshold: 90 },
          { id: 'cov-func', category: 'coverage', name: '功能覆盖率达标', description: '功能覆盖率 >= 90%', status: 'pending', autoEvaluated: true, threshold: 90 },
          { id: 'reg-pass', category: 'regression', name: '回归测试全部通过', description: '最近回归运行无失败', status: 'pending', autoEvaluated: true, threshold: 100 },
          { id: 'signoff-1', category: 'signoff', name: '设计签核', description: '设计团队负责人签核', status: 'pending', autoEvaluated: false },
          { id: 'signoff-2', category: 'signoff', name: '验证签核', description: '验证团队负责人签核', status: 'pending', autoEvaluated: false },
        ] as TOChecklistItem[];
      }
    }),

  updateItem: t.procedure
    .input((raw): { projectId: string; itemId: string; updates: Partial<TOChecklistItem> } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.itemId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and itemId are required' });
      }
      return { projectId: r.projectId, itemId: r.itemId, updates: (r.updates as Partial<TOChecklistItem>) ?? {} };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const checklistPath = join(project.rootPath, '.socverify', 'to-checklist.json');
      let items: TOChecklistItem[] = [];
      try {
        const data = await readFile(checklistPath, 'utf-8');
        items = JSON.parse(data) as TOChecklistItem[];
      } catch {
        // Start with empty if no file
      }
      const updated = items.map((item) =>
        item.id === input.itemId ? { ...item, ...input.updates } : item,
      );
      await mkdir(join(project.rootPath, '.socverify'), { recursive: true });
      await writeFile(checklistPath, JSON.stringify(updated, null, 2), 'utf-8');
      return { ok: true };
    }),

  exportReport: t.procedure
    .input((raw): { projectId: string; outputPath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.outputPath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and outputPath are required' });
      }
      return { projectId: r.projectId, outputPath: r.outputPath };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const checklistPath = join(project.rootPath, '.socverify', 'to-checklist.json');
      let items: TOChecklistItem[] = [];
      try {
        const data = await readFile(checklistPath, 'utf-8');
        items = JSON.parse(data) as TOChecklistItem[];
      } catch {
        // No checklist
      }
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>TO Readiness Report</title></head><body><h1>TO Readiness Report</h1><table><tr><th>Item</th><th>Category</th><th>Status</th><th>Threshold</th><th>Actual</th></tr>${items.map((i) => `<tr><td>${i.name}</td><td>${i.category}</td><td>${i.status}</td><td>${i.threshold ?? '-'}</td><td>${i.actualValue ?? '-'}</td></tr>`).join('')}</table></body></html>`;
      await writeFile(input.outputPath, html, 'utf-8');
      return { path: input.outputPath };
    }),
});
