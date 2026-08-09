import { describe, it, expect } from 'vitest';
import { discoverAllSkills } from '../../src/main/agent/skill-discovery';

describe('built-in plugin development skill', () => {
  it('is discoverable from the packaged extension skills directory', async () => {
    const skills = await discoverAllSkills();
    const skill = skills.find((entry) => entry.name === 'socverify-plugin-dev');

    expect(skill).toBeDefined();
    expect(skill?.source).toBe('builtin');
    expect(skill?.description).toContain('SoC Verify');
  });
});
