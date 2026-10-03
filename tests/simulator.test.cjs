// Dependency-free regression tests. Run: node --test tests/*.test.cjs
// Executes the page's actual core and simulator scripts with a small DOM fixture;
// these checks do not replace browser layout or assistive-technology testing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
const core = script.slice(0, script.indexOf('/* ================== SOUND'));
const simulator = script.slice(script.indexOf('const KB_ROWS='), script.indexOf('/* ================== CRIB SLIDER'));

function fixture() {
  const nodes = new Map();
  function element(tagName = 'DIV') {
    const classes = new Set();
    return {
      tagName, children: [], attributes: {}, listeners: {}, style: {}, dataset: {},
      textContent: '', innerHTML: '', value: '', selectedIndex: 0,
      classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) },
      setAttribute(k, v) { this.attributes[k] = String(v); },
      addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); },
      dispatch(k, event = {}) { for (const fn of this.listeners[k] || []) fn(event); },
      appendChild(child) { this.children.push(child); if (child.id) nodes.set(child.id, child); }
    };
  }
  for (const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) nodes.set(match[2], element(match[1].toUpperCase()));
  for (const [id, value] of Object.entries({selL: 'II', selM: 'I', selR: 'III', plugInput: 'AM TC'})) nodes.get(id).value = value;
  const document = element();
  document.activeElement = null;
  document.getElementById = id => { assert.ok(nodes.has(id), `Missing fixture element ${id}`); return nodes.get(id); };
  document.createElement = tag => element(tag.toUpperCase());
  document.querySelectorAll = selector => selector === '.lamp.on' ? [...nodes.values()].filter(n => n.classList.contains('on')) : [];
  let soundCount = 0;
  const context = vm.createContext({document, sndKey: () => soundCount++, setTimeout: () => 1, clearTimeout: () => {}});
  vm.runInContext(core + simulator + '\n globalThis.api={Machine,sim,pressKey,simSettings,parsePlugs};', context);
  const {api} = context;
  const get = id => nodes.get(id);
  function configure(order = ['I', 'II', 'III'], plugs = '', rings = [0, 0, 0]) {
    ['selL', 'selM', 'selR'].forEach((id, i) => get(id).value = order[i]);
    ['ringL', 'ringM', 'ringR'].forEach((id, i) => get(id).selectedIndex = rings[i]);
    get('plugInput').value = plugs;
    return api.simSettings();
  }
  function snapshot() {
    return JSON.stringify({sim: api.sim, display: ['winL', 'winM', 'winR', 'nameL', 'nameM', 'nameR', 'tapeIn', 'tapeOut', 'trace'].map(id => [get(id).textContent, get(id).innerHTML]), lamps: [...nodes.values()].filter(n => n.classList.contains('on')).map(n => n.id), soundCount});
  }
  const clickKey = ch => get('keyboard').children.flatMap(row => row.children).find(k => k.textContent === ch).dispatch('click');
  const typeKey = ch => document.dispatch('keydown', {key: ch, preventDefault() {}});
  return {...api, get, configure, snapshot, clickKey, typeKey};
}

function encrypt(Machine, text, order = ['I', 'II', 'III'], rings = 'AAA', pos = 'AAA', plugs = []) {
  const m = new Machine(order, rings, pos, plugs);
  return [...text].map(c => m.enc(c)).join('');
}

test('known Enigma I vector, trace parity, and reciprocal decryption', () => {
  const f = fixture();
  assert.equal(encrypt(f.Machine, 'AAAAA'), 'BDZGO');
  assert.equal(encrypt(f.Machine, 'BDZGO'), 'AAAAA');
  const m = new f.Machine(['I','II','III'], 'AAA', 'AAA', []);
  assert.equal([...('AAAAA')].map(c => m.encTrace(c).at(-1)).join(''), 'BDZGO');
  f.configure();
  for (const c of 'AAAAA') f.clickKey(c);
  assert.equal(f.sim.out, 'BDZGO');
});

test('double stepping follows ADT → ADU → ADV → AEW → BFX', () => {
  const {Machine} = fixture();
  const m = new Machine(['I','II','III'], 'AAA', 'ADT', []);
  const positions = () => m.rot.map(r => String.fromCharCode(65 + r.pos)).join('');
  for (const expected of ['ADU','ADV','AEW','BFX']) { m.step(); assert.equal(positions(), expected); }
});

test('round trips preserve all distinct rotor orders, nonzero rings, and plug pairs', () => {
  const {Machine} = fixture();
  const rotors = ['I','II','III','IV','V'];
  const text = 'THEQUICKBROWNFOXJUMPSOVERTHELAZYDOG';
  for (const a of rotors) for (const b of rotors) for (const c of rotors) {
    if (new Set([a,b,c]).size !== 3) continue;
    const args = [[a,b,c], 'BDF', 'XYZ', [['A','M'],['T','C'],['Q','X']]];
    const cipher = encrypt(Machine, text, ...args);
    assert.equal(encrypt(Machine, cipher, ...args), text);
    assert.ok([...text].every((ch,i) => ch !== cipher[i]));
  }
});

for (const invalid of ['AB AC','AA','A','ABC','AB BA','AB,CD','AB1','12','あ']) {
  test(`invalid plugs ${JSON.stringify(invalid)} block repeated mouse/keyboard actions atomically and recover`, () => {
    const f = fixture();
    f.configure(['I','II','III'], 'AM TC');
    f.clickKey('A');
    const before = f.snapshot();
    f.get('plugInput').value = invalid;
    f.get('plugInput').dispatch('input');
    for (let i=0;i<3;i++) { f.clickKey('B'); f.typeKey('c'); }
    assert.equal(f.snapshot(), before);
    assert.equal(f.get('plugErr').style.display, 'block');
    assert.match(f.get('plugErr').textContent, /修正するまで暗号化できません/);
    assert.equal(f.get('plugInput').attributes['aria-invalid'], 'true');
    f.get('plugInput').value = 'AM TC';
    f.get('plugInput').dispatch('input');
    assert.equal(f.get('plugErr').style.display, 'none');
    assert.equal(f.get('plugInput').attributes['aria-invalid'], 'false');
    f.clickKey('B');
    assert.equal(f.sim.in, 'AB');
    assert.equal(f.sim.out, encrypt(f.Machine, 'AB', ['I','II','III'], 'AAA', 'AAA', [['A','M'],['T','C']]));
  });
}

for (const order of [['I','I','III'],['I','II','I'],['I','II','II'],['I','I','I']]) {
  test(`duplicate rotors ${order.join('-')} block state changes and recover`, () => {
    const f = fixture();
    f.configure(); f.clickKey('A');
    const before = f.snapshot();
    assert.equal(f.configure(order, 'AB', [1,2,3]), false);
    for (let i=0;i<3;i++) { f.clickKey('B'); f.typeKey('C'); }
    assert.equal(f.snapshot(), before);
    assert.equal(f.get('rotorErr').style.display, 'block');
    for (const id of ['selL','selM','selR']) assert.equal(f.get(id).attributes['aria-invalid'], 'true');
    assert.equal(f.configure(), true);
    assert.equal(f.get('rotorErr').style.display, 'none');
    f.typeKey('A');
    assert.equal(f.sim.out, 'BD');
  });
}

test('both errors stay independent; empty/lowercase/13-pair plugs remain valid', () => {
  const f = fixture();
  assert.equal(f.configure(['I','I','III'], 'AB AC'), false);
  assert.equal(f.configure(['I','II','III'], 'AB AC'), false);
  assert.equal(f.get('rotorErr').style.display, 'none');
  assert.equal(f.get('plugErr').style.display, 'block');
  assert.equal(f.configure(['I','II','III'], '  ab\tcd  '), true);
  assert.equal(JSON.stringify(f.sim.plugs), JSON.stringify([['A','B'],['C','D']]));
  assert.equal(f.configure(['I','II','III'], 'AB CD EF GH IJ KL MN OP QR ST UV WX YZ'), true);
  assert.equal(f.sim.plugs.length, 13);
  assert.equal(f.configure(), true);
  assert.equal(f.sim.plugs.length, 0);
});

test('all nine specified controls have explicit, nonempty accessible labels', () => {
  const ids = ['caesarIn','caesarShift','selL','selM','selR','ringL','ringM','ringR','plugInput'];
  for (const id of ids) {
    const tag = html.match(new RegExp(`<(?:input|select)\\b[^>]*\\bid="${id}"[^>]*>`))[0];
    assert.ok(/aria-label="[^"]+"/.test(tag) || new RegExp(`<label\\b[^>]*for="${id}"[^>]*>[^<]+`).test(html), id);
  }
  for (const id of ['plugErr','rotorErr']) assert.match(html, new RegExp(`id="${id}" role="alert"`));
});

test('numeric labels match 26! and the ten-pair plugboard count', () => {
  const factorial = n => { let value = 1n; for (let i=2n;i<=n;i++) value *= i; return value; };
  assert.equal(factorial(26n), 403291461126605635584000000n);
  assert.equal(factorial(26n)/(factorial(6n)*factorial(10n)*2n**10n), 150738274937250n);
  assert.match(html, /鍵は約4×10²⁶通り\(26の階乗\)/);
  assert.match(html, /<div class="v">約150兆<\/div><div class="k">プラグボード<\/div>/);
  assert.doesNotMatch(html, /約40京|約150兆×10⁶/);
});
