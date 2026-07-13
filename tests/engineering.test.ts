import assert from 'node:assert/strict';
import test from 'node:test';
import { calculate, convert, solveEngineering } from '../src/main/engineering';

test('calculator honors precedence, parentheses, powers, and constants', () => {
  assert.equal(calculate('2 + 3 * 4'), 14);
  assert.equal(calculate('(2 + 3) * 4'), 20);
  assert.equal(calculate('2 ^ 3 ^ 2'), 512);
  assert.ok(Math.abs(calculate('pi * 2') - Math.PI * 2) < 1e-12);
});

test('calculator rejects execution syntax and invalid arithmetic', () => {
  assert.equal(solveEngineering({ kind: 'calculate', expression: 'process.exit()' }).ok, false);
  assert.equal(solveEngineering({ kind: 'calculate', expression: '10 / 0' }).ok, false);
});

test('unit converter handles linear and temperature families', () => {
  assert.equal(convert(1, 'km', 'm'), 1000);
  assert.ok(Math.abs(convert(1, 'mi', 'km') - 1.609344) < 1e-12);
  assert.ok(Math.abs(convert(32, 'F', 'C')) < 1e-12);
  assert.ok(Math.abs(convert(0, 'C', 'K') - 273.15) < 1e-12);
});

test('unit converter refuses cross-family conversion', () => {
  assert.equal(solveEngineering({ kind: 'convert', value: 1, from: 'kg', to: 'm' }).ok, false);
});
