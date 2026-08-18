import { describe, it, expect } from 'vitest';
import { buildSysbaseCommand } from '../src/main/tools/sysbase-gen/command-builder';
import type { SysbaseGenConfig } from '../src/shared/types/sysbase-gen';

const DEFAULT_SCRIPT = '/pri/project/tools/sprd/dv/sysbase/r3p4/bin/sysbase_gen.py';

function makeFullConfig(): SysbaseGenConfig {
  return {
    genLevel: 'subsys',
    subsys: 'apcpu_sys',
    instanceName: 'u_sys_apcpu',
    rtlFile: '$PROJ_RTL/apcpu_sys/design/rtl/top/apcpu_top_pwr_wrap.v',
    moduleName: 'apcpu_top_pwr_wrap',
    dutSpecPath: './materials/apcpu_sys_dut_spec.xlsx',
    miniExcelPath: './materials/sysbase_mini_case_apcpu.xlsx',
    csvPath: '',
    ralDirs: [
      '$PROJ_RTL/apcpu_sys/design/spec/autoreg',
      '$PROJ_RTL/apcpu_sys/design/rtl/slv_fw_apcpu',
    ],
    clkDir: '$PROJ_RTL/apcpu_sys/design/rtl/clk',
    clk2Dir: '',
    modIoPath: './materials/getModIO.log',
    filelistPath: './filelist.f',
    moduleListPath: '',
    targetScope: '',
    pinlistPath: '',
    dmalistPath: '',
    outputDir: './',
  };
}

/** Create a top-level config for testing. */
function makeTopConfig(): SysbaseGenConfig {
  return {
    genLevel: 'top',
    subsys: 'top',
    instanceName: 'dut',
    rtlFile: '$PROJ_RTL/top/design/rtl/top/kunlunn02_top.v',
    moduleName: 'kunlunn02_top',
    dutSpecPath: '',
    miniExcelPath: '',
    csvPath: './materials/top.csv',
    ralDirs: [
      '$PROJ_RTL/top/design/rtl/lp_sys/dvfs',
      '$PROJ_RTL/top/design/rtl/lp_sys/pmu/reg',
    ],
    clkDir: '',
    clk2Dir: '',
    modIoPath: '',
    filelistPath: '',
    moduleListPath: '',
    targetScope: '',
    pinlistPath: '',
    dmalistPath: '',
    outputDir: './',
  };
}

describe('buildSysbaseCommand', () => {
  it('builds full command with all required params (no optional)', () => {
    const config = makeFullConfig();
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);

    // First line: python script gen
    expect(cmd).toContain(`python3 ${DEFAULT_SCRIPT} gen`);
    // Required flags present
    expect(cmd).toContain('-rtl');
    expect(cmd).toContain('-n');
    expect(cmd).toContain('-i');
    expect(cmd).toContain('-x');
    expect(cmd).toContain('-mini');
    expect(cmd).toContain('-ral');
    expect(cmd).toContain('-clk');
    expect(cmd).toContain('-mod_io');
    expect(cmd).toContain('-o');
    // Optional flags absent when empty
    expect(cmd).not.toContain('-clk2');
    expect(cmd).not.toContain('-pinlist');
    expect(cmd).not.toContain('-dmalist');
  });

  it('includes optional -clk2 when clk2Dir is set (and -clk also present)', () => {
    const config = makeFullConfig();
    config.clk2Dir = '$PROJ_RTL/apcpu_sys/design/rtl/clk2,clk2_prefix';
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    expect(cmd).toContain('-clk2');
    expect(cmd).toContain('$PROJ_RTL/apcpu_sys/design/rtl/clk2,clk2_prefix');
    // -clk should also be present since makeFullConfig sets clkDir
    expect(cmd).toContain('-clk ');
  });

  it('includes optional -pinlist when pinlistPath is set', () => {
    const config = makeFullConfig();
    config.pinlistPath = './materials/pinlist.xlsx';
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    expect(cmd).toContain('-pinlist');
    expect(cmd).toContain('./materials/pinlist.xlsx');
  });

  it('includes optional -dmalist when dmalistPath is set', () => {
    const config = makeFullConfig();
    config.dmalistPath = './materials/dmalist.xlsx';
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    expect(cmd).toContain('-dmalist');
    expect(cmd).toContain('./materials/dmalist.xlsx');
  });

  it('joins multiple ralDirs with spaces', () => {
    const config = makeFullConfig();
    config.ralDirs = [
      '/path/to/ral1',
      '/path/to/ral2',
      '/path/to/ral3',
    ];
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    expect(cmd).toContain('-ral          /path/to/ral1 /path/to/ral2 /path/to/ral3');
  });

  it('uses custom script path in the command', () => {
    const config = makeFullConfig();
    const customScript = '/custom/path/sysbase_gen.py';
    const cmd = buildSysbaseCommand(config, customScript);
    expect(cmd).toContain(`python3 ${customScript} gen`);
    expect(cmd).not.toContain(DEFAULT_SCRIPT);
  });

  it('uses backslash line continuation for multi-line format', () => {
    const config = makeFullConfig();
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    // Each line except the last should end with backslash
    const lines = cmd.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    // All lines except the last should end with backslash (after trimming trailing whitespace)
    for (let i = 0; i < lines.length - 1; i++) {
      expect(lines[i].trimEnd().endsWith('\\')).toBe(true);
    }
  });

  it('aligns flags with consistent padding', () => {
    const config = makeFullConfig();
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    const lines = cmd.split('\n').slice(1); // skip first line (python script gen)

    // Extract flag column start positions (find the flag token in each line)
    const flagPositions: number[] = [];
    for (const line of lines) {
      const match = line.match(/\s+(-\S+)/);
      if (match) {
        flagPositions.push(line.indexOf(match[1]));
      }
    }

    // All flags should start at the same column
    const firstPos = flagPositions[0];
    expect(firstPos).toBeGreaterThan(0);
    for (const pos of flagPositions) {
      expect(pos).toBe(firstPos);
    }
  });

  it('includes all optional params when all are set', () => {
    const config = makeFullConfig();
    config.clk2Dir = '/clk2/path,prefix';
    config.pinlistPath = './pinlist.xlsx';
    config.dmalistPath = './dmalist.xlsx';
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    expect(cmd).toContain('-clk2');
    expect(cmd).toContain('-pinlist');
    expect(cmd).toContain('-dmalist');
  });

  it('omits -clk when clkDir is empty (optional)', () => {
    const config = makeFullConfig();
    config.clkDir = '';
    config.clk2Dir = '';
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    // -clk flag should not appear (neither -clk nor -clk2)
    expect(cmd).not.toContain('-clk');
  });

  it('includes -module_list when moduleListPath is set', () => {
    const config = makeFullConfig();
    config.moduleListPath = '/path/to/module_list.txt';
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    expect(cmd).toContain('-module_list');
    expect(cmd).toContain('/path/to/module_list.txt');
  });

  it('includes -target_scope when targetScope is set', () => {
    const config = makeFullConfig();
    config.targetScope = 'tb_top.chip.dut.u_sys_cpu';
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    expect(cmd).toContain('-target_scope');
    expect(cmd).toContain('tb_top.chip.dut.u_sys_cpu');
  });

  it('omits -module_list and -target_scope when empty', () => {
    const config = makeFullConfig();
    config.moduleListPath = '';
    config.targetScope = '';
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    expect(cmd).not.toContain('-module_list');
    expect(cmd).not.toContain('-target_scope');
  });

  it('includes -clk when clkDir is set', () => {
    const config = makeFullConfig();
    config.clkDir = '/path/to/clk';
    config.clk2Dir = '';
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    expect(cmd).toContain('-clk          /path/to/clk');
    expect(cmd).not.toContain('-clk2');
  });

  it('handles single ralDir', () => {
    const config = makeFullConfig();
    config.ralDirs = ['/single/ral/dir'];
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    expect(cmd).toContain('-ral          /single/ral/dir');
  });

  it('places -o as the last flag', () => {
    const config = makeFullConfig();
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    const lines = cmd.split('\n');
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain('-o');
    expect(lastLine).toContain(config.outputDir);
  });
});

describe('buildSysbaseCommand — top level', () => {
  it('builds top command with only 6 params (-rtl -n -i -c -ral -o)', () => {
    const config = makeTopConfig();
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);

    // First line: python script gen
    expect(cmd).toContain(`python3 ${DEFAULT_SCRIPT} gen`);
    // Required top flags present
    expect(cmd).toContain('-rtl');
    expect(cmd).toContain('-n');
    expect(cmd).toContain('-i');
    expect(cmd).toContain('-c');
    expect(cmd).toContain('-ral');
    expect(cmd).toContain('-o');
    // Subsys-only flags absent
    expect(cmd).not.toContain('-x');
    expect(cmd).not.toContain('-mini');
    expect(cmd).not.toContain('-clk');
    expect(cmd).not.toContain('-mod_io');
  });

  it('top command uses -c with csvPath', () => {
    const config = makeTopConfig();
    config.csvPath = './materials/top.csv';
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    expect(cmd).toContain('-c');
    expect(cmd).toContain('./materials/top.csv');
  });

  it('top command uses default instance name dut', () => {
    const config = makeTopConfig();
    expect(config.instanceName).toBe('dut');
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    expect(cmd).toContain('-i');
    expect(cmd).toContain('dut');
  });

  it('top command joins multiple ralDirs with spaces', () => {
    const config = makeTopConfig();
    config.ralDirs = ['/path/to/ral1', '/path/to/ral2'];
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    expect(cmd).toContain('/path/to/ral1 /path/to/ral2');
  });

  it('top command uses backslash line continuation', () => {
    const config = makeTopConfig();
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    const lines = cmd.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (let i = 0; i < lines.length - 1; i++) {
      expect(lines[i].trimEnd().endsWith('\\')).toBe(true);
    }
  });

  it('top command places -o as the last flag', () => {
    const config = makeTopConfig();
    const cmd = buildSysbaseCommand(config, DEFAULT_SCRIPT);
    const lines = cmd.split('\n');
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain('-o');
    expect(lastLine).toContain(config.outputDir);
  });
});
