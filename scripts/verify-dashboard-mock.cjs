/**
 * Verify dashboard queries work with the mock data.
 */
const Database = require('better-sqlite3');
const { resolve } = require('node:path');

const DB_PATH = resolve(__dirname, '..', '.socverify', 'cases.db');
const db = new Database(DB_PATH, { readonly: true });

console.log('=== Dashboard Summary ===');
const subsysCount = db.prepare('SELECT COUNT(*) as c FROM subsystems').get().c;
const caseCount = db.prepare('SELECT COUNT(*) as c FROM cases').get().c;
const statusRows = db.prepare('SELECT status, COUNT(*) as c FROM simulation_runs GROUP BY status').all();
let total = 0, pass = 0, fail = 0;
for (const r of statusRows) { total += r.c; if (r.status === 'pass') pass = r.c; if (r.status === 'fail') fail = r.c; }
console.log(`subsysCount: ${subsysCount}, caseCount: ${caseCount}, passRate: ${(pass/total*100).toFixed(1)}%, failCount: ${fail}`);

console.log('\n=== Trend 7d ===');
const trendRows = db.prepare(`
  SELECT date(start_time) as dt,
    SUM(CASE WHEN status='pass' THEN 1 ELSE 0 END) as pass,
    SUM(CASE WHEN status='fail' THEN 1 ELSE 0 END) as fail,
    SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as error
  FROM simulation_runs
  WHERE date(start_time) >= date('now','-6 days')
  GROUP BY date(start_time) ORDER BY dt
`).all();
for (const r of trendRows) console.log(`  ${r.dt}: pass=${r.pass} fail=${r.fail} error=${r.error}`);

console.log('\n=== Subsys Status ===');
const ssRows = db.prepare(`
  SELECT s.name, COUNT(c.id) as caseCount,
    (SELECT SUM(CASE WHEN status='pass' THEN 1 ELSE 0 END) FROM simulation_runs WHERE subsys=s.name) as pass,
    (SELECT SUM(CASE WHEN status='fail' THEN 1 ELSE 0 END) FROM simulation_runs WHERE subsys=s.name) as fail
  FROM subsystems s LEFT JOIN cases c ON c.subsys=s.name
  GROUP BY s.name ORDER BY s.name
`).all();
for (const r of ssRows) console.log(`  ${r.name}: cases=${r.caseCount} pass=${r.pass} fail=${r.fail}`);

console.log('\n=== Duration Histogram ===');
const durRows = db.prepare(`
  SELECT CASE
    WHEN duration_ms < 60000 THEN '0-1min'
    WHEN duration_ms < 300000 THEN '1-5min'
    WHEN duration_ms < 900000 THEN '5-15min'
    WHEN duration_ms < 1800000 THEN '15-30min'
    ELSE '30min+' END as bucket, COUNT(*) as c
  FROM simulation_runs WHERE duration_ms IS NOT NULL GROUP BY bucket
`).all();
for (const r of durRows) console.log(`  ${r.bucket}: ${r.c}`);

console.log('\n=== Unstable Cases (top 5) ===');
const unstableRows = db.prepare(`
  WITH agg AS (
    SELECT case_name, subsys,
      SUM(CASE WHEN status='pass' THEN 1 ELSE 0 END) as p,
      SUM(CASE WHEN status='fail' THEN 1 ELSE 0 END) as f
    FROM simulation_runs GROUP BY case_name, subsys HAVING p>0 AND f>0
  )
  SELECT * FROM agg ORDER BY (CAST(f AS REAL)/(p+f)) DESC LIMIT 5
`).all();
for (const r of unstableRows) console.log(`  ${r.case_name} (${r.subsys}): pass=${r.p} fail=${r.f}`);

console.log('\n=== Phase Pass Rate ===');
const phaseRows = db.prepare(`
  SELECT COALESCE(c.phase,'null') as phase, COUNT(*) as total,
    SUM(CASE WHEN r.status='pass' THEN 1 ELSE 0 END) as pass,
    SUM(CASE WHEN r.status='fail' THEN 1 ELSE 0 END) as fail
  FROM simulation_runs r JOIN cases c ON c.name=r.case_name AND c.subsys=r.subsys
  GROUP BY COALESCE(c.phase,'null') ORDER BY phase
`).all();
for (const r of phaseRows) console.log(`  ${r.phase}: total=${r.total} pass=${r.pass} fail=${r.fail} passRate=${(r.pass/r.total*100).toFixed(1)}%`);

console.log('\n=== Regression Progress ===');
const totalCases = db.prepare('SELECT COUNT(*) as c FROM cases').get().c;
const runCases = db.prepare("SELECT COUNT(DISTINCT case_name) as c FROM simulation_runs WHERE status IN ('pass','fail','error','aborted')").get().c;
const passedCases = db.prepare("SELECT COUNT(DISTINCT case_name) as c FROM (SELECT case_name FROM simulation_runs WHERE status='pass' GROUP BY case_name)").get().c;
console.log(`  totalCases: ${totalCases}, runCases: ${runCases}, passedCases: ${passedCases}, notRunCases: ${totalCases-runCases}`);

console.log('\n=== Debug Difficulty (top 5) ===');
const debugRows = db.prepare(`
  WITH filtered AS (SELECT case_name, subsys, status, start_time FROM simulation_runs),
  first_run AS (
    SELECT case_name, subsys, start_time as frt FROM (
      SELECT case_name, subsys, start_time,
        ROW_NUMBER() OVER (PARTITION BY case_name, subsys ORDER BY start_time ASC) as rn
      FROM filtered
    ) WHERE rn=1
  ),
  first_pass AS (
    SELECT case_name, subsys, start_time as fpt FROM (
      SELECT case_name, subsys, start_time,
        ROW_NUMBER() OVER (PARTITION BY case_name, subsys ORDER BY start_time ASC) as rn
      FROM filtered WHERE status='pass'
    ) WHERE rn=1
  ),
  fail_count AS (
    SELECT f.case_name, f.subsys, COUNT(*) as fcfp
    FROM first_pass f JOIN filtered fr
      ON fr.case_name=f.case_name AND fr.subsys=f.subsys AND fr.status='fail' AND fr.start_time < f.fpt
    GROUP BY f.case_name, f.subsys
  )
  SELECT fp.case_name, fp.subsys,
    CAST(julianday(fp.fpt)-julianday(fr.frt) AS INTEGER) as days,
    COALESCE(fc.fcfp,0) as fails
  FROM first_pass fp JOIN first_run fr ON fr.case_name=fp.case_name AND fr.subsys=fp.subsys
  LEFT JOIN fail_count fc ON fc.case_name=fp.case_name AND fc.subsys=fp.subsys
  ORDER BY (CAST(julianday(fp.fpt)-julianday(fr.frt) AS INTEGER) * COALESCE(fc.fcfp,0)) DESC LIMIT 5
`).all();
for (const r of debugRows) console.log(`  ${r.case_name} (${r.subsys}): daysToFirstPass=${r.days} failsBeforePass=${r.fails}`);

console.log('\n=== Recent Failures (top 5) ===');
const failRows = db.prepare(`
  SELECT case_name, subsys, start_time, duration_ms
  FROM simulation_runs WHERE status='fail'
  ORDER BY start_time DESC LIMIT 5
`).all();
for (const r of failRows) console.log(`  ${r.case_name} (${r.subsys}): ${r.start_time} duration=${r.duration_ms}ms`);

db.close();
console.log('\n✅ All dashboard queries verified successfully!');
