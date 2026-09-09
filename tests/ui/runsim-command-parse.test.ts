/**
 * parseRunsimCommand（runsim-command.ts Part 1c）单元测试：
 * 「解析回归指令」核心解析逻辑，复刻 Python GUI
 * `controllers/config_controller.py` 的
 * _preprocess_command_text / _parse_command_params 流程。
 */

import { describe, it, expect } from 'vitest';
import { parseRunsimCommand } from '@renderer/lib/runsim-command';

describe('parseRunsimCommand 预处理（网页复制文本）', () => {
  it('解析纯 runsim 命令', () => {
    const parsed = parseRunsimCommand(
      'runsim -base top -block udtb/usvp -case apcpu_hello_world',
    );
    expect(parsed).toEqual({
      base: 'top',
      block: 'udtb/usvp',
      case: 'apcpu_hello_world',
    });
  });

  it('剥离前后噪音文本，只保留 runsim 命令部分', () => {
    const parsed = parseRunsimCommand(
      '平台通知 [2026-09-09] 请执行以下回归： runsim -base top -case test_001 -seed 42 谢谢',
    );
    expect(parsed).toEqual({ base: 'top', case: 'test_001', seed: '42' });
  });

  it('多行文本合并为单行后解析', () => {
    const parsed = parseRunsimCommand(
      'runsim -base top\n  -block usvp\n  -case test_002',
    );
    expect(parsed).toEqual({ base: 'top', block: 'usvp', case: 'test_002' });
  });

  it('剥离 HTML 标签', () => {
    const parsed = parseRunsimCommand(
      '<a href="#">runsim -base top -case test_003</a>',
    );
    expect(parsed).toEqual({ base: 'top', case: 'test_003' });
  });

  it('无 runsim 前缀但以 - 开头时自动补全前缀', () => {
    const parsed = parseRunsimCommand('-base top -case test_004');
    expect(parsed).toEqual({ base: 'top', case: 'test_004' });
  });

  it('无有效 runsim 命令时返回空对象', () => {
    expect(parseRunsimCommand('这是一段普通文本，没有命令')).toEqual({});
    expect(parseRunsimCommand('')).toEqual({});
    expect(parseRunsimCommand('   ')).toEqual({});
  });
});

describe('parseRunsimCommand 参数映射', () => {
  it('boolean flag 映射到对应 option key', () => {
    const parsed = parseRunsimCommand(
      'runsim -base top -cl -dump_sva -cov -upf -dump_mem -fm -C',
    );
    expect(parsed).toEqual({
      base: 'top',
      cl: true,
      dump_sva: true,
      cov: true,
      upf: true,
      dump_mem: true,
      fm: true,
      compile_only: true,
    });
  });

  it('-R 映射为 sim_only', () => {
    const parsed = parseRunsimCommand('runsim -base top -R');
    expect(parsed).toEqual({ base: 'top', sim_only: true });
  });

  it('-fsdb 后跟 dump level 时提取 dump_level', () => {
    const parsed = parseRunsimCommand('runsim -fsdb medium -case test_005');
    expect(parsed).toEqual({ fsdb: true, dump_level: 'medium', case: 'test_005' });
  });

  it('-fsdb 后跟 .tcl 文件时不当作 dump level', () => {
    const parsed = parseRunsimCommand('runsim -fsdb dump.tcl -case test_006');
    expect(parsed).toEqual({ fsdb: true, case: 'test_006' });
  });

  it('回归参数映射：-regr/-regr_work/-tag/-nt/-m', () => {
    const parsed = parseRunsimCommand(
      'runsim -regr /proj/reg/list -regr_work /proj/work -tag nightly -nt 4 -m DE_TAG',
    );
    expect(parsed).toEqual({
      regr_file: '/proj/reg/list',
      regr_work: '/proj/work',
      tag: 'nightly',
      nt: '4',
      dashboard: 'DE_TAG',
    });
  });

  it('带引号的 -simarg 参数正确聚合', () => {
    const parsed = parseRunsimCommand(
      'runsim -case test_007 -simarg "+UVM_TESTNAME=hello +uvm_set_config=int,foo,1"',
    );
    expect(parsed).toEqual({
      case: 'test_007',
      simarg: '+UVM_TESTNAME=hello +uvm_set_config=int,foo,1',
    });
  });

  it('-cfg_def 后多个非选项参数全部聚合', () => {
    const parsed = parseRunsimCommand('runsim -cfg_def A B C -case test_008');
    expect(parsed).toEqual({ cfg_def: 'A B C', case: 'test_008' });
  });

  it('无法识别的 flag 跳过，不影响后续解析', () => {
    const parsed = parseRunsimCommand('runsim -br unknown_opt -base top -case test_009');
    expect(parsed).toEqual({ base: 'top', case: 'test_009' });
  });
});
