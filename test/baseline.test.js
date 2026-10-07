'use strict';
/* The page carries its own copy of the schedule for use without a server. It must match baseline.js. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const BASELINE = require('../baseline');

test('the page and baseline.js carry the same schedule', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const m = html.match(/var EVENTS = (\[[\s\S]*?\])\.map\(/);
  assert.ok(m, 'EVENTS array found in the page');
  const embedded = new Function('return ' + m[1])();
  assert.deepStrictEqual(embedded, BASELINE.events);
});
