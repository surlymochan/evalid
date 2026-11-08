import test from 'node:test';
import assert from 'node:assert/strict';
import { demoAdd } from '../src/demo-add.js';
test('demo adds', () => { assert.equal(demoAdd(2, 2), 4); });
