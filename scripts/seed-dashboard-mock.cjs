/**
 * Seed mock simulation_runs data into cases.db for dashboard testing.
 *
 * Usage:
 *   node scripts/seed-dashboard-mock.cjs          # insert mock data
 *   node scripts/seed-dashboard-mock.cjs --clean   # delete all simulation_runs + reset phase
 *
 * Generates:
 * - phase values on existing cases (V1, V2, V3, regression, soak)
 * - ~200 simulation_runs spread over the last 30 days with:
 *   - statuses: pass / fail / error / aborted
 *   - varied durations (0-1min, 1-5min, 5-15min, 15-30min, 30min+)
 *   - corner + seed for some runs
 *   - unstable cases (same case with both pass and fail)
 *   - debug difficulty cases (multiple fails before first pass over several days)
 */

const Database = require('better-sqlite3');
const { resolve } = require('node:path');

const DB_PATH = resolve(__dirname, '..', '.socverify', 'cases.db');

// ─── helpers ─────────────────────────────────────────────

/** Format a Date as 'YYYY-MM-DD HH:MM:SS' (localtime, matching DB convention) */
function fmtDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Random integer in [min, max] */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Pick a random element from an array */
function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}

// ─── main ────────────────────────────────────────────────

function main() {
  const cleanMode = process.argv.includes('--clean');
  const db = new Database(DB_PATH);

  // ─── clean mode ───
  if (cleanMode) {
    db.prepare('DELETE FROM simulation_runs').run();
    db.prepare('UPDATE cases SET phase = NULL').run();
    console.log('✓ Cleared all simulation_runs and reset phase to NULL');
    db.close();
    return;
  }

  // ─── 1. Assign phase to cases ───
  const phases = ['V1', 'V2', 'V3', 'regression', 'soak'];
  const cases = db.prepare('SELECT id, name, subsys FROM cases ORDER BY subsys, name').all();

  const updatePhase = db.prepare('UPDATE cases SET phase = @phase WHERE id = @id');
  const phaseTx = db.transaction(() => {
    for (const c of cases) {
      // Assign phase based on case name pattern
      let phase;
      if (c.name.includes('base') || c.name.includes('hello')) {
        phase = 'V1';
      } else if (c.name.includes('memtest')) {
        phase = 'soak';
      } else if (c.name.includes('test_00') || c.name.includes('test_0')) {
        const idx = parseInt(c.name.match(/(\d+)/)?.[1] ?? '0', 10);
        phase = phases[Math.min(idx % phases.length, phases.length - 1)];
      } else {
        phase = pick(phases);
      }
      updatePhase.run({ id: c.id, phase });
    }
  });
  phaseTx();
  console.log(`✓ Assigned phase to ${cases.length} cases`);

  // ─── 2. Generate simulation_runs ───
  const insertRun = db.prepare(`
    INSERT INTO simulation_runs
      (case_name, subsys, status, start_time, end_time, duration_ms, corner, seed, options_json)
    VALUES
      (@caseName, @subsys, @status, @startTime, @endTime, @durationMs, @corner, @seed, @optionsJson)
  `);

  const corners = ['TT', 'SS', 'FF', 'FS', 'SF'];
  const now = new Date();
  const runs = [];

  // Helper to create a run record
  function makeRun(caseName, subsys, status, daysAgo, hoursOffset, durationMs) {
    const start = new Date(now);
    start.setDate(start.getDate() - daysAgo);
    start.setHours(randInt(9, 18), randInt(0, 59), randInt(0, 59));
    if (hoursOffset) start.setHours(start.getHours() + hoursOffset);

    const end = new Date(start.getTime() + durationMs);
    const corner = pick(corners);
    const seed = String(randInt(1, 999999));

    return {
      caseName,
      subsys,
      status,
      startTime: fmtDateTime(start),
      endTime: fmtDateTime(end),
      durationMs,
      corner,
      seed,
      optionsJson: null,
    };
  }

  // Group cases by subsys
  const casesBySubsys = new Map();
  for (const c of cases) {
    if (!casesBySubsys.has(c.subsys)) casesBySubsys.set(c.subsys, []);
    casesBySubsys.get(c.subsys).push(c);
  }

  // ─── 2a. For each case, generate 1-8 runs over the last 30 days ───
  for (const c of cases) {
    const numRuns = randInt(2, 8);
    const runDays = new Set();

    for (let i = 0; i < numRuns; i++) {
      // Spread over last 30 days, but bias towards recent days
      const daysAgo = randInt(0, 29);
      runDays.add(daysAgo);

      // Determine status: 60% pass, 25% fail, 10% error, 5% aborted
      const roll = Math.random();
      let status;
      if (roll < 0.60) status = 'pass';
      else if (roll < 0.85) status = 'fail';
      else if (roll < 0.95) status = 'error';
      else status = 'aborted';

      // Duration: varied across buckets
      const durRoll = Math.random();
      let durationMs;
      if (durRoll < 0.30) durationMs = randInt(5_000, 55_000);           // 0-1min
      else if (durRoll < 0.60) durationMs = randInt(65_000, 280_000);     // 1-5min
      else if (durRoll < 0.80) durationMs = randInt(310_000, 850_000);    // 5-15min
      else if (durRoll < 0.92) durationMs = randInt(920_000, 1_750_000);  // 15-30min
      else durationMs = randInt(1_850_000, 3_600_000);                    // 30min+

      // aborted runs have no duration
      if (status === 'aborted') durationMs = null;

      runs.push(makeRun(c.name, c.subsys, status, daysAgo, 0, durationMs));
    }
  }

  // ─── 2b. Create specific unstable cases (both pass and fail) ───
  // Pick 5 cases to be explicitly unstable
  const unstableCandidates = cases.filter(c => !c.name.includes('base') && !c.name.includes('hello'));
  for (let i = 0; i < Math.min(5, unstableCandidates.length); i++) {
    const c = unstableCandidates[i * 3 % unstableCandidates.length];
    // Add 2 passes and 2 fails over the last 7 days
    runs.push(makeRun(c.name, c.subsys, 'pass', randInt(0, 6), 0, randInt(30_000, 120_000)));
    runs.push(makeRun(c.name, c.subsys, 'fail', randInt(0, 6), 0, randInt(30_000, 120_000)));
    runs.push(makeRun(c.name, c.subsys, 'pass', randInt(0, 6), 0, randInt(30_000, 120_000)));
    runs.push(makeRun(c.name, c.subsys, 'fail', randInt(0, 6), 0, randInt(30_000, 120_000)));
  }

  // ─── 2c. Create debug difficulty cases (multiple fails before first pass over days) ───
  // Pick 3 cases to have a pattern: fail, fail, fail, ..., pass (spread over several days)
  const debugCandidates = cases.filter(c => c.name.includes('test_00'));
  for (let i = 0; i < Math.min(3, debugCandidates.length); i++) {
    const c = debugCandidates[i * 2 % debugCandidates.length];
    const failDays = randInt(3, 6);
    for (let d = failDays; d >= 1; d--) {
      runs.push(makeRun(c.name, c.subsys, 'fail', d + 2, 0, randInt(60_000, 300_000)));
    }
    // First pass after all the fails
    runs.push(makeRun(c.name, c.subsys, 'pass', 1, 0, randInt(60_000, 300_000)));
  }

  // ─── 2d. Add some runs from today and yesterday for trend7d ───
  for (const c of cases.slice(0, 15)) {
    const status = Math.random() < 0.7 ? 'pass' : 'fail';
    runs.push(makeRun(c.name, c.subsys, status, 0, 0, randInt(10_000, 200_000)));
  }
  for (const c of cases.slice(0, 12)) {
    const status = Math.random() < 0.6 ? 'pass' : (Math.random() < 0.7 ? 'fail' : 'error');
    runs.push(makeRun(c.name, c.subsys, status, 1, 0, randInt(10_000, 200_000)));
  }

  // ─── 3. Insert all runs ───
  const insertTx = db.transaction(() => {
    for (const r of runs) {
      insertRun.run(r);
    }
  });
  insertTx();

  console.log(`✓ Inserted ${runs.length} simulation_runs`);

  // ─── 4. Print summary ───
  const statusCounts = db.prepare(`
    SELECT status, COUNT(*) as c FROM simulation_runs GROUP BY status ORDER BY status
  `).all();
  console.log('\n=== Status distribution ===');
  for (const row of statusCounts) {
    console.log(`  ${row.status}: ${row.c}`);
  }

  const dateRange = db.prepare(`
    SELECT MIN(date(start_time)) as minDate, MAX(date(start_time)) as maxDate FROM simulation_runs
  `).get();
  console.log(`\n=== Date range: ${dateRange.minDate} → ${dateRange.maxDate} ===`);

  const phaseDist = db.prepare(`
    SELECT COALESCE(phase, 'null') as phase, COUNT(*) as c FROM cases GROUP BY phase ORDER BY phase
  `).all();
  console.log('\n=== Phase distribution (cases) ===');
  for (const row of phaseDist) {
    console.log(`  ${row.phase}: ${row.c}`);
  }

  const subsysStats = db.prepare(`
    SELECT subsys,
      SUM(CASE WHEN status='pass' THEN 1 ELSE 0 END) as pass,
      SUM(CASE WHEN status='fail' THEN 1 ELSE 0 END) as fail,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as error,
      COUNT(*) as total
    FROM simulation_runs GROUP BY subsys ORDER BY subsys
  `).all();
  console.log('\n=== Per-subsystem run stats ===');
  for (const row of subsysStats) {
    const pr = (row.pass / row.total * 100).toFixed(1);
    console.log(`  ${row.subsys}: pass=${row.pass} fail=${row.fail} error=${row.error} total=${row.total} passRate=${pr}%`);
  }

  db.close();
  console.log('\n✅ Mock data inserted successfully. You can now test the dashboard!');
}

main();
