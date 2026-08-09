'use strict';

/* global module */

function matchNumber(text, key) {
  const match = text.match(new RegExp(`^\\[EDA\\] ${key}:\\s*(\\d+(?:\\.\\d+)?)$`, 'mi'));
  return match ? Number(match[1]) : undefined;
}

function matchStatus(text, key) {
  const match = text.match(new RegExp(`^\\[EDA\\] ${key}:\\s*(pass|fail)$`, 'mi'));
  return match ? match[1] : undefined;
}

function summarize(text) {
  const compile = matchStatus(text, 'compile');
  const simulation = matchStatus(text, 'simulation');
  const tests = matchNumber(text, 'tests');
  const passed = matchNumber(text, 'passed');
  const failed = matchNumber(text, 'failed');
  const elapsedSeconds = matchNumber(text, 'elapsed_s');
  const status = compile === 'fail' || simulation === 'fail'
    ? 'fail'
    : tests === undefined || passed === undefined || failed === undefined
      ? 'incomplete'
      : failed === 0 ? 'pass' : 'fail';
  return { status, tests, passed, failed, elapsedSeconds };
}

module.exports = {
  manifest: {
    apiVersion: '1.0',
    id: 'eda-log-summary',
    name: 'EDA Log Summary',
    version: '0.1.0',
    kind: 'ui',
    activationEvents: ['onCommand:eda-log-summary.analyze'],
    contributes: {
      commands: [{ command: 'eda-log-summary.analyze', title: 'Analyze EDA Log' }],
      views: [{ id: 'summary', name: 'EDA Log Summary', location: 'center', entry: 'view.html' }]
    }
  },

  activate(context) {
    context.registerCommand('eda-log-summary.analyze', async (relativePath = 'logs/eda-run.log') => {
      const text = await context.readFile(String(relativePath));
      return summarize(text);
    });
  }
};
