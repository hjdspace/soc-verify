/**
 * KB Wiki Store — 只读浏览与写作规则编辑的前端状态（issue 04）。
 *
 * 数据链路：tRPC kb.wikiCatalog / kb.wikiPage / kb.wikiRules /
 * kb.saveWikiRules / kb.validateWikiSchema。链接跟随复用主进程统一
 * 解析结论（activePage.links），歧义/未命中显式提示，不猜第一个。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import type {
  WikiCatalog,
  WikiPageView,
  WikiRulesSaveError,
  WikiSchemaIssue,
} from '@shared/kb-types';

/** 规则编辑草稿的即时校验态 */
export type WikiRulesValidation =
  | { status: 'idle' }
  | { status: 'validating' }
  | { status: 'invalid'; issues: WikiSchemaIssue[] }
  | { status: 'valid' };

interface KbWikiStoreState {
  // ── 页面目录 ─────────────────────────────────────────────
  catalog: WikiCatalog | null;
  catalogLoading: boolean;
  catalogError: string | null;

  // ── 当前阅读页 ───────────────────────────────────────────
  activePageId: string | null;
  activePage: WikiPageView | null;
  pageLoading: boolean;

  // ── 规则编辑 ─────────────────────────────────────────────
  schemaRaw: string | null;
  purposeRaw: string | null;
  rulesLoading: boolean;
  schemaDraft: string | null;
  purposeDraft: string | null;
  validation: WikiRulesValidation;
  rulesSaving: boolean;

  // ── 操作 ─────────────────────────────────────────────────
  loadCatalog: () => Promise<void>;
  openPage: (pageId: string) => Promise<void>;
  followLink: (target: string) => Promise<void>;
  loadRules: () => Promise<void>;
  setSchemaDraft: (raw: string) => void;
  setPurposeDraft: (raw: string) => void;
  saveRules: () => Promise<boolean>;
  reset: () => void;
}

const VALIDATION_DEBOUNCE_MS = 300;
let validationTimer: ReturnType<typeof setTimeout> | null = null;

export const useKbWikiStore = create<KbWikiStoreState>((set, get) => ({
  catalog: null,
  catalogLoading: false,
  catalogError: null,
  activePageId: null,
  activePage: null,
  pageLoading: false,
  schemaRaw: null,
  purposeRaw: null,
  rulesLoading: false,
  schemaDraft: null,
  purposeDraft: null,
  validation: { status: 'idle' },
  rulesSaving: false,

  loadCatalog: async () => {
    set({ catalogLoading: true, catalogError: null });
    try {
      const res = await trpc.kb.wikiCatalog.query({});
      if (res.ok) {
        set({ catalog: res.catalog, catalogLoading: false });
      } else {
        set({
          catalog: null,
          catalogLoading: false,
          catalogError: res.schemaIssues.map((i) => i.message).join('\n') || 'schema 无法解析',
        });
      }
    } catch (err) {
      set({ catalog: null, catalogLoading: false, catalogError: err instanceof Error ? err.message : String(err) });
    }
  },

  openPage: async (pageId) => {
    set({ activePageId: pageId, pageLoading: true });
    try {
      const page = await trpc.kb.wikiPage.query({ pageId });
      set({ activePage: page, pageLoading: false });
    } catch (err) {
      set({ activePage: null, pageLoading: false });
      useToastStore.getState().error('打开页面失败', err instanceof Error ? err.message : String(err));
    }
  },

  /** 跟随规范链接：复用主进程解析结论，歧义列出候选，不猜第一个 */
  followLink: async (target) => {
    const page = get().activePage;
    const link = page?.links.find((l) => l.kind === 'link' && l.target === target);
    const resolution = link?.resolution;
    if (resolution?.status === 'resolved') {
      await get().openPage(resolution.pageId);
      return;
    }
    if (resolution?.status === 'ambiguous') {
      useToastStore.getState().warning(
        `链接「${target}」存在歧义，请从以下页面中选择`,
        resolution.candidates.map((c) => `• ${c}`).join('\n'),
      );
      return;
    }
    useToastStore.getState().warning(`链接「${target}」未解析到已发布页面`, '目标页面不存在或尚未发布。');
  },

  loadRules: async () => {
    set({ rulesLoading: true });
    try {
      const rules = await trpc.kb.wikiRules.query({});
      set({
        schemaRaw: rules.schemaRaw,
        purposeRaw: rules.purposeRaw,
        schemaDraft: rules.schemaRaw,
        purposeDraft: rules.purposeRaw,
        validation: { status: 'idle' },
        rulesLoading: false,
      });
    } catch (err) {
      set({ rulesLoading: false });
      useToastStore.getState().error('读取写作规则失败', err instanceof Error ? err.message : String(err));
    }
  },

  setSchemaDraft: (raw) => {
    set({ schemaDraft: raw, validation: { status: 'validating' } });
    if (validationTimer !== null) clearTimeout(validationTimer);
    validationTimer = setTimeout(() => {
      validationTimer = null;
      void (async () => {
        const draft = get().schemaDraft;
        if (draft === null) return;
        try {
          const res = await trpc.kb.validateWikiSchema.mutate({ schemaRaw: draft });
          // 丢弃过期响应：用户可能已继续输入
          if (get().schemaDraft !== draft) return;
          set({ validation: res.ok ? { status: 'valid' } : { status: 'invalid', issues: res.issues } });
        } catch {
          set({ validation: { status: 'idle' } });
        }
      })();
    }, VALIDATION_DEBOUNCE_MS);
  },

  setPurposeDraft: (raw) => {
    set({ purposeDraft: raw });
  },

  saveRules: async () => {
    const { schemaDraft, purposeDraft, schemaRaw, purposeRaw, validation } = get();
    if (validation.status === 'invalid' || validation.status === 'validating') {
      useToastStore.getState().error('无法保存：schema 存在校验问题');
      return false;
    }
    const schemaChanged = schemaDraft !== null && schemaDraft !== schemaRaw;
    const purposeChanged = purposeDraft !== null && purposeDraft !== purposeRaw;
    if (!schemaChanged && !purposeChanged) return true;

    set({ rulesSaving: true });
    try {
      const res = await trpc.kb.saveWikiRules.mutate({
        ...(schemaChanged ? { schemaRaw: schemaDraft ?? undefined } : {}),
        ...(purposeChanged ? { purposeRaw: purposeDraft ?? undefined } : {}),
      });
      if (res.ok) {
        set({ schemaRaw: schemaDraft, purposeRaw: purposeDraft, rulesSaving: false, validation: { status: 'idle' } });
        useToastStore.getState().success('写作规则已保存');
        // 目录路由可能变化（空库允许改目录），刷新编目
        await get().loadCatalog();
        return true;
      }
      set({ rulesSaving: false });
      const err: WikiRulesSaveError = res.error;
      if (err.code === 'schemaInvalid') {
        set({ validation: { status: 'invalid', issues: err.issues } });
      }
      useToastStore.getState().error('保存写作规则失败', err.message);
      return false;
    } catch (err) {
      set({ rulesSaving: false });
      useToastStore.getState().error('保存写作规则失败', err instanceof Error ? err.message : String(err));
      return false;
    }
  },

  reset: () => {
    if (validationTimer !== null) {
      clearTimeout(validationTimer);
      validationTimer = null;
    }
    set({
      catalog: null,
      catalogLoading: false,
      catalogError: null,
      activePageId: null,
      activePage: null,
      pageLoading: false,
      schemaRaw: null,
      purposeRaw: null,
      rulesLoading: false,
      schemaDraft: null,
      purposeDraft: null,
      validation: { status: 'idle' },
      rulesSaving: false,
    });
  },
}));
