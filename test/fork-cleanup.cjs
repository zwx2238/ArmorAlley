// Fork cleanup regression test for the self-hosted Armor Alley source build.
//
//   node test/fork-cleanup.cjs
//
// Zero dependencies. Three layers:
//   1. Static assertions: the Google Analytics loader removed by this fork
//      stays removed from every source file, and the boot script no longer
//      schedules analytics on a timer.
//   2. The exported `aaLoader.loadGA` call surface is kept and is a total
//      no-op: exercised in a VM on a public host with timer, network and DOM
//      traps, it must produce zero events and throw nothing.
//   3. Functional and attribution surfaces this fork must keep are present.
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var SRC = path.join(ROOT, 'src');

var failures = 0;
function check(desc, ok) {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + desc);
  if (!ok) failures++;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
var loader = read('src/js/core/aa-loader.js');
var boot = read('src/js/aa-boot.js');
var modal = read('src/html/game-prefs-modal.html');
var index = read('index.html');

function scanSources(needle) {
  var hits = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
      var full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (!/\.(js|html|css|json)$/.test(entry.name)) return;
      if (fs.readFileSync(full, 'utf8').indexOf(needle) !== -1) {
        hits.push(path.relative(ROOT, full));
      }
    });
  })(SRC);
  return hits;
}

// --- tracking surfaces removed ---------------------------------------------
[
  'G-XGW2TDDC6V',
  'googletagmanager.com',
  'window.dataLayer',
  "gtag('config'",
  'google analytics'
].forEach(function (needle) {
  var hits = scanSources(needle);
  check('tracker reference removed from every source file (' + needle + ')', hits.length === 0);
  if (hits.length) console.log('   found in: ' + hits.join(', '));
});

check('boot script no longer schedules analytics on a timer',
  boot.indexOf('window.setTimeout(aaLoader.loadGA') === -1);

// --- loadGA call surface kept and is a total no-op -------------------------
check('aaLoader.loadGA export kept', loader.indexOf('loadGA,') !== -1 && /function loadGA\(\)/.test(loader));
check('boot script still calls aaLoader.loadGA()', boot.indexOf('aaLoader.loadGA()') !== -1);

var calls = { timers: 0, network: 0, dom: 0 };
function trap() { calls.timers++; return 0; }

var windowTrap = {
  location: {
    host: 'play.armor-alley.net',
    href: 'https://play.armor-alley.net/index.html',
    search: ''
  },
  _aaMissingDist: false
};
var documentTrap = new Proxy({}, {
  get: function (target, prop) {
    calls.dom++;
    return function () { calls.dom++; };
  },
  set: function () { calls.dom++; return true; }
});

var sandbox = {
  window: windowTrap,
  document: documentTrap,
  URLSearchParams: URLSearchParams,
  setTimeout: trap,
  setInterval: trap,
  clearTimeout: trap,
  clearInterval: trap,
  fetch: function () { calls.network++; return Promise.reject(new Error('network trap')); },
  XMLHttpRequest: function () { calls.network++; },
  console: { log: function () {}, warn: function () {}, error: function () {} }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

var body = loader.replace(/export\s*\{\s*aaLoader\s*\}\s*;?\s*$/, 'globalThis.__aaLoader = aaLoader;');
var threw = null;
try {
  vm.runInContext(body, sandbox, { filename: 'aa-loader.js' });
} catch (e) {
  threw = e;
}
check('aa-loader.js evaluates on a public host without throwing', threw === null);
if (threw) console.log('   ' + threw.message);

var api = sandbox.__aaLoader;
check('aaLoader object exposed', !!api && typeof api === 'object');
check('aaLoader.loadGA is callable', !!api && typeof api.loadGA === 'function');

if (api && typeof api.loadGA === 'function') {
  var before = { timers: calls.timers, network: calls.network, dom: calls.dom };
  var gaThrew = null;
  try {
    api.loadGA();
    api.loadGA();
  } catch (e) {
    gaThrew = e;
  }
  check('loadGA throws nothing', gaThrew === null);
  if (gaThrew) console.log('   ' + gaThrew.message);
  check('loadGA schedules zero timers', calls.timers === before.timers);
  check('loadGA performs zero network calls', calls.network === before.network);
  check('loadGA touches the DOM zero times', calls.dom === before.dom);
  check('loadGA leaves window.dataLayer undefined', windowTrap.dataLayer === undefined);
  check('loadGA leaves window.gtag undefined', windowTrap.gtag === undefined);
}

// --- functional and attribution surfaces preserved -------------------------
check('Discord/Slack webhook integration kept',
  modal.indexOf('Discord / Slack Integration') !== -1 && modal.indexOf('id="webhook-url"') !== -1);
check('Slack webhook docs link kept (functional, not an ad)',
  modal.indexOf('https://api.slack.com/messaging/webhooks') !== -1);
check('gameplay tutorial video kept (help)',
  modal.indexOf('https://youtu.be/6wEMcssFJ-E') !== -1);
check('strategy video kept (help)', modal.indexOf('https://youtu.be/9BQ62c7u2JM') !== -1);
check('source code link kept', modal.indexOf('https://github.com/scottschiller/ArmorAlley') !== -1);
check('development history attribution kept',
  modal.indexOf('https://www.schillmania.com/content/entries/2013/armor-alley-web-prototype/') !== -1);
check('original copyright notice kept',
  index.indexOf('Original game Copyright (C) 1989 - 1991 Information Access Technologies.') !== -1);
check('CC BY-NC 3.0 license reference kept',
  index.indexOf('https://creativecommons.org/licenses/by-nc/3.0/') !== -1);
check('game menu source retained', fs.existsSync(path.join(SRC, 'js', 'UI', 'game-menu.js')));

if (failures > 0) {
  console.error(failures + ' check(s) failed');
  process.exit(1);
}
console.log('fork cleanup checks passed');
