import assert from 'node:assert/strict';
import { test } from 'node:test';

test('runs on Node 24 or newer', () => {
  const major = Number(process.versions.node.split('.')[0]);
  assert.ok(major >= 24, `Node ${process.versions.node} is older than 24`);
});
