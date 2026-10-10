// Smoke test for the partners.html earn-and-save calculator.
// Dependency-free: run with `node tests/partners-calculator.test.js`.
//
// It loads the page's calculator script (the <script id="partners-app"> block)
// into a bare VM context with a minimal fake DOM and checks the published
// calculation policy: defaults, presets, rounding, clamping, payback, manual
// edits, keyboard typing, slider stepping and back/forward-cache recovery.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'partners.html'), 'utf8');
const match = html.match(/<script id="partners-app">([\s\S]*?)<\/script>/);
assert(match, 'partners.html must contain <script id="partners-app">');
const js = match[1];

// ── minimal fake DOM ───────────────────────────────────────────────────────
const ids = new Map();
const ev = {};
const RANGE_BOUNDS = {
  audienceRange: [0, 1000], activationRange: [1, 40], fillsRange: [0.5, 3], savingsRange: [5, 60],
};
const fake = (id) => {
  if (!ids.has(id)) {
    const classes = new Set();
    const node = {
      id, value: '', textContent: '', innerHTML: '', innerText: '', dataset: {}, disabled: false, className: '',
      min: RANGE_BOUNDS[id] ? String(RANGE_BOUNDS[id][0]) : undefined,
      max: RANGE_BOUNDS[id] ? String(RANGE_BOUNDS[id][1]) : undefined,
      style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
      classList: {
        add(k) { classes.add(k); },
        remove(k) { classes.delete(k); },
        contains(k) { return classes.has(k); },
        toggle(k, flag) {
          if (flag === undefined) { if (classes.has(k)) { classes.delete(k); return false; } classes.add(k); return true; }
          if (flag) classes.add(k); else classes.delete(k);
          return !!flag;
        },
      },
      setAttribute(k, v) { node['attr:' + k] = v; },
      getAttribute(k) { return node['attr:' + k] ?? null; },
      append() {}, appendChild() {},
      addEventListener(type, fn) { (ev[id + ':' + type] ??= []).push(fn); },
    };
    ids.set(id, node);
  }
  return ids.get(id);
};
const presetBtns = ['conservative', 'typical', 'strong'].map((x) => {
  const o = fake('preset-' + x);
  o.dataset = { preset: x };
  return o;
});
const doc = {
  getElementById: fake,
  querySelectorAll(q) { return q === '.preset' ? presetBtns : []; },
  createElement() { return fake('anon' + ids.size); },
  createTextNode(t) { return { textContent: t }; },
  addEventListener() {},
};
const ctx = {
  document: doc,
  window: { location: { href: '' }, addEventListener(type, fn) { (ev['window:' + type] ??= []).push(fn); } },
  console, Date, setTimeout, clearTimeout,
  FormData: class {},
  FileReader: class {},
  alert(msg) { throw new Error('unexpected alert: ' + msg); },
};
vm.runInNewContext(js, ctx);

const fire = (id, type, arg) => { for (const fn of ev[id + ':' + type] || []) fn(arg); };
const text = (id) => fake(id).textContent;
const type = (id, keys) => { for (const k of keys) { fake(id).value = k; fire(id, 'input'); } };

// ── 1. defaults (Typical preset: 20,000 × 10% × 1.0 fill × $25) ────────────
assert.equal(text('monthlyPatients'), '2,000');
assert.equal(text('annualPatients'), '24,000 patient-months/year');
assert.equal(text('monthlyClaims'), '2,000');
assert.equal(text('annualClaims'), '24,000 claims/year');
assert.equal(text('monthlyEarnings'), '$1,300');
assert.equal(text('annualEarnings'), '$15,600 per year');
assert.equal(text('monthlySavings'), '$50,000');
assert.equal(text('annualSavings'), '$600,000 per year');
assert(!fake('payback').classList.contains('show'), 'payback hidden until a fee is entered');
assert.equal(fake('audienceNum').value, '20000');
assert.equal(fake('fillsNum').value, '1.0');
assert.equal(fake('audienceRange').getAttribute('aria-valuetext'), '20,000 people');
assert.equal(fake('savingsRange').getAttribute('aria-valuetext'), '$25 per fill');

// ── 2. Strong preset: 20% activation, 1.5 fills ────────────────────────────
fire('preset-strong', 'click');
assert.equal(text('monthlyPatients'), '4,000');
assert.equal(text('monthlyClaims'), '6,000');
assert.equal(text('monthlyEarnings'), '$3,900');
assert.equal(text('annualEarnings'), '$46,800 per year');
assert.equal(fake('preset-strong').getAttribute('aria-pressed'), 'true');
assert.equal(fake('preset-typical').getAttribute('aria-pressed'), 'false');
assert(text('presetDescription').includes('20% activation'));
assert.equal(fake('activationRange').getAttribute('aria-valuetext'), '20 percent');

// ── 3. Implementation fee → payback to one decimal ─────────────────────────
fake('feeNum').value = '2500';
fire('feeNum', 'input', { target: fake('feeNum') });
assert(fake('payback').classList.contains('show'));
assert.equal(text('paybackMonths'), '0.6 months');
assert(!fake('feeHint').classList.contains('show'), 'no cap hint for an in-range fee');

// Over the $10,000 cap: modeled at the cap, typed value left alone, hint shown; blur reconciles.
fake('feeNum').value = '50000';
fire('feeNum', 'input', { target: fake('feeNum') });
assert.equal(fake('feeNum').value, '50000', 'typed fee is not rewritten mid-entry');
assert.equal(text('paybackMonths'), '2.6 months', '10,000 / 3,900');
assert(fake('feeHint').classList.contains('show'), 'cap hint shown while over the cap');
fire('feeNum', 'blur');
assert.equal(fake('feeNum').value, '10000');
assert(!fake('feeHint').classList.contains('show'));

// Clearing the fee hides payback again.
fake('feeNum').value = '';
fire('feeNum', 'input', { target: fake('feeNum') });
assert(!fake('payback').classList.contains('show'));

// ── 4. Manual edit clears the preset and recalculates ──────────────────────
fake('audienceNum').value = '10000';
fire('audienceNum', 'input');
assert.equal(text('monthlyClaims'), '3,000');
assert.equal(text('monthlyEarnings'), '$1,950');
assert.equal(fake('preset-strong').getAttribute('aria-pressed'), 'false');
assert(text('presetDescription').startsWith('Custom scenario'));

// ── 5. Conservative preset: 5% activation, 0.8 fills, claims rounded to 10 ─
fire('preset-conservative', 'click');
// 10,000 × 5% = 500 patients; 500 × 0.8 = 400 claims; × $0.65 = $260
assert.equal(text('monthlyPatients'), '500');
assert.equal(text('monthlyClaims'), '400');
assert.equal(text('monthlyEarnings'), '$260');
assert.equal(text('monthlySavings'), '$10,000');

// ── 6. Keystroke-by-keystroke typing is never rewritten mid-entry ──────────
type('audienceNum', ['2', '20', '200', '2000']);
assert.equal(fake('audienceNum').value, '2000', 'field keeps what was typed');
assert.equal(text('monthlyPatients'), '100', '2,000 × 5%');
fire('audienceNum', 'blur');
assert.equal(fake('audienceNum').value, '2000');
type('fillsNum', ['1', '1.', '1.5']);
assert.equal(fake('fillsNum').value, '1.5');
assert.equal(text('monthlyClaims'), '150', '100 patients × 1.5 fills');
fire('fillsNum', 'blur');
assert.equal(fake('fillsNum').value, '1.5');
type('savingsNum', ['2', '25']);
assert.equal(fake('savingsNum').value, '25');
assert.equal(text('monthlySavings'), '$3,750', '150 claims × $25');

// ── 7. Clamping to published bounds happens in the model and on blur ───────
fake('audienceNum').value = '5000000';
fire('audienceNum', 'input');
assert.equal(fake('audienceNum').value, '5000000', 'not rewritten while focused');
fire('audienceNum', 'blur');
assert.equal(fake('audienceNum').value, '1000000', 'audience clamps to 1,000,000 on blur');
fake('activationNum').value = '95';
fire('activationNum', 'input'); fire('activationNum', 'blur');
assert.equal(fake('activationNum').value, '40', 'activation clamps to 40%');
fake('savingsNum').value = '1';
fire('savingsNum', 'input'); fire('savingsNum', 'blur');
assert.equal(fake('savingsNum').value, '5', 'savings clamps to $5');
fake('fillsNum').value = '2.26';
fire('fillsNum', 'input'); fire('fillsNum', 'blur');
assert.equal(fake('fillsNum').value, '2.3', 'fills rounds to one decimal');
// 1,000,000 × 40% = 400,000 patients × 2.3 = 920,000 claims × $0.65 = $598,000
assert.equal(text('monthlyClaims'), '920,000');
assert.equal(text('monthlyEarnings'), '$598,000');

// ── 8. Log-scale audience slider round-trips and steps by keyboard ─────────
fake('audienceRange').value = '0';
fire('audienceRange', 'input');
assert.equal(fake('audienceNum').value, '500');
fake('audienceRange').value = '1';            // one ArrowRight at the bottom
fire('audienceRange', 'input');
assert.equal(fake('audienceNum').value, '1000', 'a single step always moves the audience');
fake('audienceRange').value = '1000';
fire('audienceRange', 'input');
assert.equal(fake('audienceNum').value, '1000000');
fire('preset-typical', 'click');
fake('audienceRange').value = String(Number(fake('audienceRange').value) - 1); // ArrowLeft from 1,000,000
fire('audienceRange', 'input');
assert.equal(fake('audienceNum').value, '992500', 'steps down from the top');

// ── 9. Empty / junk numeric input is ignored rather than crashing ──────────
const before = text('monthlyPatients');
fake('activationNum').value = '';
fire('activationNum', 'input');
assert.equal(text('monthlyPatients'), before, 'empty input leaves the last valid value');
fake('activationNum').value = 'abc';
fire('activationNum', 'input');
assert.equal(text('monthlyPatients'), before, 'non-numeric input leaves the last valid value');

// ── 10. Back/forward-cache restore re-enables a form left at "Sending…" ────
fake('intakeBtn').disabled = true; fake('intakeBtn').textContent = 'Sending…';
fake('calcEmailBtn').disabled = true; fake('calcEmailBtn').textContent = 'Sending…';
fire('window', 'pageshow', { persisted: true });
assert.equal(fake('intakeBtn').disabled, false);
assert.equal(fake('intakeBtn').textContent, 'Request your 20-minute discovery call →');
assert.equal(fake('calcEmailBtn').disabled, false);
assert.equal(fake('calcEmailBtn').textContent, 'Email me these numbers →');

// ── 11. The debounced live region gets one sentence, not eight numbers ─────
setTimeout(() => {
  assert.match(text('calcLive'), /^Estimated partner earnings \$[\d,]+ per month and patient savings \$[\d,]+ per month, from [\d,]+ claims\.$/);
  console.log('PASS: defaults, presets, payback cap, manual edits, typing, clamping, log slider stepping, bad input, bfcache, live region');
}, 800);
