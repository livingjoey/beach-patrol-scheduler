import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, effectiveCerts, evaluate, missing, parseRule, RuleError } from '../src/domain/criteria.ts';

const KNOWN = new Set(['BASIC', 'EMR', 'EMT', 'EMT2', 'PMD', 'PWC1', 'PWC2', 'PWC3', 'PWC4', 'PWC5', 'SUP']);
const pwcRescuer = parseRule({ all: [{ any: ['EMT', 'EMT2', 'PMD'] }, 'PWC3'] }, KNOWN);

test('ANY / ALL combinations evaluate correctly', () => {
  assert.equal(evaluate(pwcRescuer, new Set(['EMT', 'PWC3'])), true);
  assert.equal(evaluate(pwcRescuer, new Set(['PMD', 'PWC3'])), true);
  assert.equal(evaluate(pwcRescuer, new Set(['EMT', 'PWC2'])), false);
  assert.equal(evaluate(pwcRescuer, new Set(['PWC3'])), false);
  assert.equal(evaluate(null, new Set()), true);
});

test('no certification implies another unless an equivalency is enabled', () => {
  const emtSlot = parseRule('EMT', KNOWN);
  assert.equal(evaluate(emtSlot, effectiveCerts(['EMT2'], [])), false);
  assert.equal(evaluate(emtSlot, effectiveCerts(['EMT2'], [{ holder: 'EMT2', satisfies: 'EMT' }])), true);
  // transitive
  const certs = effectiveCerts(['PWC5'], [{ holder: 'PWC5', satisfies: 'PWC4' }, { holder: 'PWC4', satisfies: 'PWC3' }]);
  assert.ok(certs.has('PWC3'));
});

test('plain-language description and missing parts', () => {
  assert.equal(describe(pwcRescuer), '(EMT or EMT2 or PMD) and PWC3');
  assert.deepEqual(missing(pwcRescuer, new Set(['EMT'])), ['PWC3']);
  assert.deepEqual(missing(pwcRescuer, new Set(['PWC3'])), ['one of EMT, EMT2, PMD']);
  assert.equal(describe({ all: [] }), 'No requirement');
});

test('invalid rules are rejected with a path', () => {
  assert.throws(() => parseRule({ any: [] }, KNOWN), RuleError);
  assert.throws(() => parseRule({ all: ['EMT', 'NOPE'] }, KNOWN), /Unknown certification "NOPE".*all\[1\]/);
  assert.throws(() => parseRule({ cert: 'EMT', any: [] }, KNOWN), RuleError);
});
