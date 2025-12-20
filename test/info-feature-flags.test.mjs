import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveInfoFeatureFlags } from '../built/modules/info/feature-flags.js';

test('info: default-enabled features show enabled when unset', () => {
  const flags = resolveInfoFeatureFlags({
    // unset/legacy configs commonly omit these keys
    chartEnabled: undefined,
    notingEnabled: undefined,
    timeSignalEnabled: undefined,
  });

  assert.equal(flags.chart, true);
  assert.equal(flags.autoWord, true);
  assert.equal(flags.timeSignal, true);
});

test('info: default-enabled features can be disabled explicitly', () => {
  const flags = resolveInfoFeatureFlags({
    chartEnabled: false,
    notingEnabled: false,
    timeSignalEnabled: false,
  });

  assert.equal(flags.chart, false);
  assert.equal(flags.autoWord, false);
  assert.equal(flags.timeSignal, false);
});

test('info: opt-in features are disabled when unset', () => {
  const flags = resolveInfoFeatureFlags({
    keywordEnabled: undefined,
    reversiEnabled: undefined,
    serverMonitoring: undefined,
    checkEmojisEnabled: undefined,
    mazeEnable: undefined,
    pollEnable: undefined,
  });

  assert.equal(flags.keywordSearch, false);
  assert.equal(flags.reversi, false);
  assert.equal(flags.serverMonitoring, false);
  assert.equal(flags.emojiCheck, false);
  assert.equal(flags.maze, false);
  assert.equal(flags.poll, false);
});
