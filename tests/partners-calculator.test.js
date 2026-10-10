// Smoke test for the partners.html earn-and-save calculator.
// Dependency-free: run with `node tests/partners-calculator.test.js`.
//
// It loads the page's calculator script (the <script id="partners-app"> block)
// into a bare VM context with a minimal fake DOM and checks the published
// calculation policy: defaults, presets, rounding, clamping, payback and
// manual edits.
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
      id, value: '', textContent: '', innerHTML: '', innerText: '', dataset: {},
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
  window: { location: { href: '' } },
  console, Date,
  FormData: class {},
  FileReader: class {},
  alert(msg) { throw new Error('unexpected alert: ' + msg); },
};
vm.runInNewContext(js, ctx);

const fire = (id, type, arg) => { for (const fn of ev[id + ':' + type] || []) fn(arg); };
const text = (id) => fake(id).textContent;

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
assert.equal(fake('preset-typical').getAttribute('aria-pressed'), undefined, 'typical starts pressed via markup, untouched');
assert.equal(fake('audienceNum').value, '20000');
assert.equal(fake('fillsNum').value, '1.0');

// ── 2. Strong preset: 20% activation, 1.5 fills ────────────────────────────
fire('preset-strong', 'click');
assert.equal(text('monthlyPatients'), '4,000');
assert.equal(text('monthlyClaims'), '6,000');
assert.equal(text('monthlyEarnings'), '$3,900');
assert.equal(text('annualEarnings'), '$46,800 per year');
assert.equal(fake('preset-strong').getAttribute('aria-pressed'), 'true');
assert.equal(fake('preset-typical').getAttribute('aria-pressed'), 'false');
assert(text('presetDescription').includes('20% activation'));

// ── 3. Implementation fee → payback to one decimal ─────────────────────────
fake('feeNum').value = '2500';
fire('feeNum', 'input', { target: fake('feeNum') });
assert(fake('payback').classList.contains('show'));
assert.equal(text('paybackMonths'), '0.6 months');

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

// ── 6. Clamping to published bounds ────────────────────────────────────────
fake('audienceNum').value = '5000000';
fire('audienceNum', 'input');
assert.equal(fake('audienceNum').value, '1000000', 'audience clamps to 1,000,000');
fake('activationNum').value = '95';
fire('activationNum', 'input');
assert.equal(fake('activationNum').value, '40', 'activation clamps to 40%');
fake('savingsNum').value = '1';
fire('savingsNum', 'input');
assert.equal(fake('savingsNum').value, '5', 'savings clamps to $5');
fake('fillsNum').value = '2.26';
fire('fillsNum', 'input');
assert.equal(fake('fillsNum').value, '2.3', 'fills rounds to one decimal');
// 1,000,000 × 40% = 400,000 patients × 2.3 = 920,000 claims × $0.65 = $598,000
assert.equal(text('monthlyClaims'), '920,000');
assert.equal(text('monthlyEarnings'), '$598,000');

// ── 7. Log-scale audience slider round-trips through the published range ──
fake('audienceRange').value = '0';
fire('audienceRange', 'input');
assert.equal(fake('audienceNum').value, '500');
fake('audienceRange').value = '1000';
fire('audienceRange', 'input');
assert.equal(fake('audienceNum').value, '1000000');

// ── 8. Empty / junk numeric input is ignored rather than crashing ──────────
fake('activationNum').value = '';
fire('activationNum', 'input');
assert.equal(text('monthlyPatients'), '400,000', 'empty input leaves the last valid value');
fake('activationNum').value = 'abc';
fire('activationNum', 'input');
assert.equal(text('monthlyPatients'), '400,000', 'non-numeric input leaves the last valid value');

console.log('PASS: defaults, presets, rounding, payback, manual edits, clamping, log slider, bad input');
