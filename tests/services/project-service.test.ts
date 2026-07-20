import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireProject, ensurePluginsLoaded } from '../../src/main/services/project-service';

// Mock dependencies
vi.mock('../../src/main/project/project-manager', () => ({
  projectManager: {
    getProject: vi.fn(),
  },
}));

vi.mock('../../src/main/plugins/loader', () => ({
  pluginLoader: {
    getLoadResults: vi.fn(),
    loadPlugins: vi.fn(),
  },
}));

import { projectManager } from '../../src/main/project/project-manager';
import { pluginLoader } from '../../src/main/plugins/loader';

describe('project-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('requireProject', () => {
    it('returns the project when found', () => {
      const mockProject = { id: 'p1', name: 'Test', rootPath: '/tmp', createdAt: 0, lastOpenedAt: 0 };
      vi.mocked(projectManager.getProject).mockReturnValue(mockProject);
      expect(requireProject('p1')).toBe(mockProject);
    });

    it('throws TRPCError NOT_FOUND when project does not exist', () => {
      vi.mocked(projectManager.getProject).mockReturnValue(null);
      expect(() => requireProject('missing')).toThrow(/Project not found: missing/);
    });
  });

  describe('ensurePluginsLoaded', () => {
    it('skips loading when plugins are already loaded', async () => {
      vi.mocked(pluginLoader.getLoadResults).mockReturnValue([
        { manifest: { id: 'p1', name: 'P1', version: '1.0.0', kind: 'case-parser' }, plugin: {} as never, source: 'local', path: '/tmp' },
      ]);
      await ensurePluginsLoaded('/tmp/proj');
      expect(pluginLoader.loadPlugins).not.toHaveBeenCalled();
    });

    it('lazy-loads plugins when none are loaded', async () => {
      vi.mocked(pluginLoader.getLoadResults).mockReturnValue([]);
      vi.mocked(pluginLoader.loadPlugins).mockResolvedValue([]);
      await ensurePluginsLoaded('/tmp/proj');
      expect(pluginLoader.loadPlugins).toHaveBeenCalledWith('/tmp/proj');
    });
  });
});
