import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoverageData, CoverageNode, CoverageTriplet } from '../../src/shared/types';

type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
};

type CoverageParserModule = {
  parse: (
    projectRoot: string,
    sessionId: string,
    reportDir: string,
    options?: { summaryOnly?: boolean },
  ) => Promise<CoverageData>;
  parseXmlDocument: (text: string) => XmlNode;
  parseUrgSessionXml: (text: string, log?: (msg: string) => void) => { tree: CoverageNode; summary: CoverageNode['metrics'] };
};

const require = createRequire(import.meta.url);
const parser = require(resolve('plugins/builtin-coverage-parser/index.js')) as CoverageParserModule;

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/urg-xml', import.meta.url));
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'soc-verify-urg-xml-'));
  tempDirs.push(dir);
  return dir;
}

async function readFixture(rel: string): Promise<string> {
  return readFile(join(FIXTURES_DIR, rel), 'utf-8');
}

/** 构造 vcs-urg 报告目录（meta.json + 指定报告文件），避免污染 fixture 目录（parse 会写 parser-debug.log） */
async function makeUrgReportDir(files: Record<string, string>): Promise<{ projectRoot: string; reportDir: string }> {
  const projectRoot = await makeTempDir();
  const reportDir = join(projectRoot, 'reports');
  await mkdir(reportDir);
  await writeFile(join(reportDir, 'meta.json'), JSON.stringify({ covMergeDir: '', edaTool: 'vcs-urg' }), 'utf-8');
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(reportDir, name), content, 'utf-8');
  }
  return { projectRoot, reportDir };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ─── 最小 XML 解析器（插件内自研，无外部依赖）──────────────────────

describe('builtin coverage parser: 最小 XML 解析器', () => {
  it('解析嵌套元素与属性', () => {
    const doc = parser.parseXmlDocument('<a x="1" y="two"><b y="2">text-b</b><c><d/></c></a>');

    expect(doc.name).toBe('a');
    expect(doc.attrs).toEqual({ x: '1', y: 'two' });
    expect(doc.children).toHaveLength(2);
    expect(doc.children[0].name).toBe('b');
    expect(doc.children[0].attrs.y).toBe('2');
    expect(doc.children[0].text).toBe('text-b');
    expect(doc.children[1].name).toBe('c');
    expect(doc.children[1].children[0].name).toBe('d');
    expect(doc.children[1].children[0].children).toHaveLength(0);
  });

  it('解码五种命名实体与数字实体（属性值和文本）', () => {
    const doc = parser.parseXmlDocument(
      '<r a="&lt;tag&gt; &amp; &quot;q&quot; &apos;p&apos;">&lt;a&gt; &amp; &#65;&#x42;</r>',
    );

    expect(doc.attrs.a).toBe('<tag> & "q" \'p\'');
    expect(doc.text).toBe('<a> & AB');
  });

  it('解析自闭合标签（带属性）', () => {
    const doc = parser.parseXmlDocument('<root><item name="x" value="1"/><item name="y"/></root>');

    expect(doc.children).toHaveLength(2);
    expect(doc.children[0].attrs).toEqual({ name: 'x', value: '1' });
    expect(doc.children[1].attrs.name).toBe('y');
  });

  it('跳过 XML 声明、注释与处理指令', () => {
    const doc = parser.parseXmlDocument(
      '<?xml version="1.0" encoding="UTF-8"?>\n<!-- top comment --><?urg version="1"?><root><!-- inner -->leaf</root>',
    );

    expect(doc.name).toBe('root');
    expect(doc.text).toBe('leaf');
  });

  it('CDATA 段按原文跳过（不解析标记、不做实体解码）', () => {
    const doc = parser.parseXmlDocument('<r><![CDATA[<not-tag&nbsp;> & raw]]></r>');

    expect(doc.text).toBe('<not-tag&nbsp;> & raw');
    expect(doc.children).toHaveLength(0);
  });

  it('结构错误时抛出解析错误：闭合标签不匹配', () => {
    expect(() => parser.parseXmlDocument('<a><b></a></b>')).toThrow(/闭合标签不匹配/);
  });

  it('结构错误时抛出解析错误：元素未闭合', () => {
    expect(() => parser.parseXmlDocument('<a><b>text')).toThrow(/未闭合/);
  });

  it('结构错误时抛出解析错误：属性值未加引号', () => {
    expect(() => parser.parseXmlDocument('<a x=1/>')).toThrow(/引号/);
  });
});

// ─── urg session.xml 优先解析（ADR 0024）─────────────────────────

describe('builtin coverage parser: urg session.xml 优先解析', () => {
  it('session.xml 解析出正确的层级树与 triplet 数值', async () => {
    const sessionXml = await readFixture('session.xml');
    const { tree, summary } = parser.parseUrgSessionXml(sessionXml);

    // 层级树：tb_top(0) → u_core(1) → u_alu/u_decoder(2)，兄弟 u_mem(1)
    expect(tree.name).toBe('tb_top');
    expect(tree.depth).toBe(0);
    expect(tree.path).toBe('top/tb_top');
    const uCore = tree.children.find((c) => c.name === 'u_core');
    const uMem = tree.children.find((c) => c.name === 'u_mem');
    expect(uCore?.depth).toBe(1);
    expect(uCore?.path).toBe('top/tb_top/u_core');
    expect(uCore?.children.map((c) => c.name)).toEqual(['u_alu', 'u_decoder']);
    expect(uCore?.children[0].depth).toBe(2);
    expect(uMem).toBeDefined();

    // triplet 数值直接取自 XML
    expect(tree.metrics.line).toEqual({ percentage: 90, covered: 900, total: 1000 });
    expect(uCore?.metrics.line).toEqual({ percentage: 95, covered: 190, total: 200 });
    expect(uCore?.children[0].metrics.functional).toEqual({ percentage: 70, covered: 14, total: 20 });
    expect(uMem?.metrics.condition).toEqual({ percentage: 83.33, covered: 70, total: 84 });

    // 摘要 = 根 scope 的 metrics
    expect(summary.line).toEqual({ percentage: 90, covered: 900, total: 1000 });
  });

  it('不适用 metric 的三元组为 null（percentage/covered/total 均为 null）', async () => {
    const sessionXml = await readFixture('session.xml');
    const { tree } = parser.parseUrgSessionXml(sessionXml);

    // fixture 中 tb_top 与 u_mem 的 functional coverage 元素缺失
    const naTriplet: CoverageTriplet = { percentage: null, covered: null, total: null };
    expect(tree.metrics.functional).toEqual(naTriplet);
    expect(tree.children.find((c) => c.name === 'u_mem')?.metrics.functional).toEqual(naTriplet);
  });

  it('XML 单一 fsm type 整体映射到 fsm_state，fsm_transition 不单独产出', async () => {
    const sessionXml = await readFixture('session.xml');
    const { tree } = parser.parseUrgSessionXml(sessionXml);

    expect(tree.metrics.fsm_state).toEqual({ percentage: 90, covered: 90, total: 100 });
    expect(tree.metrics.fsm_transition).toEqual({ percentage: null, covered: null, total: null });
  });

  it('父 scope 分数直接取 XML 值，不累加 descendants（URG SCORE 语义）', async () => {
    const sessionXml = await readFixture('session.xml');
    const { tree } = parser.parseUrgSessionXml(sessionXml);

    // fixture：tb_top line = 900/1000；子 scope 合计 = 190 + 640 = 830/1000
    // 若实现错误地累加 descendants，会得到 830 / 83% 而非 XML 中的 900 / 90%
    expect(tree.metrics.line.covered).toBe(900);
    expect(tree.metrics.line.total).toBe(1000);
    expect(tree.metrics.line.percentage).toBe(90);
  });

  it('违规数据 covered > total 抛出解析错误（fail-closed）', async () => {
    const sessionXml = await readFixture('invalid/covered-gt-total.xml');

    expect(() => parser.parseUrgSessionXml(sessionXml)).toThrow(/covered.*>.*total|covered > total/);
  });

  it('违规数据负值 sentinel（-1）抛出解析错误（fail-closed）', async () => {
    const sessionXml = await readFixture('invalid/negative-sentinel.xml');

    expect(() => parser.parseUrgSessionXml(sessionXml)).toThrow(/负值|sentinel|-1/);
  });

  it('parse() 对 session.xml 报告目录产出层级树与摘要', async () => {
    const sessionXml = await readFixture('session.xml');
    const { projectRoot, reportDir } = await makeUrgReportDir({ 'session.xml': sessionXml });

    const result = await parser.parse(projectRoot, 'urg_xml', reportDir);

    expect(result.source.edaTool).toBe('vcs-urg');
    expect(result.root.name).toBe('tb_top');
    expect(result.root.metrics.line).toEqual({ percentage: 90, covered: 900, total: 1000 });
    const uCore = result.root.children.find((c) => c.name === 'u_core');
    expect(uCore?.metrics.toggle).toEqual({ percentage: 82, covered: 410, total: 500 });
    expect(uCore?.children.find((c) => c.name === 'u_alu')?.metrics.line.percentage).toBe(100);
  });

  it('session.xml 与 text 报告同时存在时 XML 优先（错误的 dashboard/hierarchy 不被采用）', async () => {
    const sessionXml = await readFixture('session.xml');
    const [wrongDashboard, wrongHierarchy, lineDat] = await Promise.all([
      readFixture('priority/dashboard.txt'),
      readFixture('priority/hierarchy.txt'),
      readFixture('priority/line.dat'),
    ]);
    const { projectRoot, reportDir } = await makeUrgReportDir({
      'session.xml': sessionXml,
      'dashboard.txt': wrongDashboard,
      'hierarchy.txt': wrongHierarchy,
      'line.dat': lineDat,
    });

    const result = await parser.parse(projectRoot, 'urg_priority', reportDir);

    // 数值来自 session.xml，而非故意写错的 dashboard（1.11%）/ hierarchy（1.00）
    expect(result.root.metrics.line).toEqual({ percentage: 90, covered: 900, total: 1000 });
    expect(result.root.metrics.branch).toEqual({ percentage: 87.2, covered: 436, total: 500 });
    const uCore = result.root.children.find((c) => c.name === 'u_core');
    expect(uCore?.metrics.line.percentage).toBe(95);

    // XML 路径下 .dat 未覆盖项仍被解析（detail 数据不受影响）
    expect(result.uncovered?.line).toBeDefined();
    expect(result.uncovered?.line?.length).toBeGreaterThan(0);
    expect(result.uncovered?.line?.[0].file).toBe('alu_op.v');
  });

  it('仅 text 报告的旧目录降级解析成功（向后兼容）', async () => {
    const [dashboard, hierarchy] = await Promise.all([
      readFixture('text/dashboard.txt'),
      readFixture('text/hierarchy.txt'),
    ]);
    const { projectRoot, reportDir } = await makeUrgReportDir({
      'dashboard.txt': dashboard,
      'hierarchy.txt': hierarchy,
    });

    const result = await parser.parse(projectRoot, 'urg_text_fallback', reportDir);

    // dashboard 摘要
    expect(result.root.metrics.line).toEqual({ percentage: 95.3, covered: 9530, total: 10000 });
    expect(result.root.metrics.fsm_state?.percentage).toBe(90);
    // hierarchy 层级树
    expect(result.root.name).toBe('tb_top');
    const uCore = result.root.children.find((c) => c.name === 'u_core');
    expect(uCore?.metrics.line.percentage).toBe(96);
    expect(uCore?.children.find((c) => c.name === 'u_alu')?.metrics.line.percentage).toBe(100);
    expect(result.root.children.find((c) => c.name === 'u_mem')?.metrics.line.percentage).toBe(80);
  });

  it('parse() 对违规 session.xml 数据报错而非静默错算', async () => {
    const coveredGtTotal = await readFixture('invalid/covered-gt-total.xml');
    const negative = await readFixture('invalid/negative-sentinel.xml');

    const dir1 = await makeUrgReportDir({ 'session.xml': coveredGtTotal });
    await expect(parser.parse(dir1.projectRoot, 'urg_bad_1', dir1.reportDir)).rejects.toThrow();

    const dir2 = await makeUrgReportDir({ 'session.xml': negative });
    await expect(parser.parse(dir2.projectRoot, 'urg_bad_2', dir2.reportDir)).rejects.toThrow();
  });

  it('session.xml 与 text 报告全部缺失时报错', async () => {
    const { projectRoot, reportDir } = await makeUrgReportDir({});

    await expect(parser.parse(projectRoot, 'urg_missing', reportDir)).rejects.toThrow(/session\.xml/);
  });

  it('summaryOnly 模式下 XML 路径跳过 .dat 未覆盖项解析', async () => {
    const sessionXml = await readFixture('session.xml');
    const lineDat = await readFixture('priority/line.dat');
    const { projectRoot, reportDir } = await makeUrgReportDir({
      'session.xml': sessionXml,
      'line.dat': lineDat,
    });

    const result = await parser.parse(projectRoot, 'urg_summary_only', reportDir, { summaryOnly: true });

    expect(result.summaryOnly).toBe(true);
    expect(result.root.metrics.line.percentage).toBe(90);
    expect(result.uncovered).toBeUndefined();
  });
});
