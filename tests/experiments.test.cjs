const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createExperimentsClient } = require('../src/experiments');

function fakeCookies(initial = []) {
  const jar = [...initial];
  return {
    jar,
    get: async ({ name } = {}) => jar.filter((cookie) => !name || cookie.name === name),
    set: async (cookie) => { jar.push({ name: cookie.name, value: cookie.value, domain: cookie.domain }); },
  };
}

test('a signed-out install gets one device cookie, shared with the site in the main window', async () => {
  const cookies = fakeCookies();
  const client = createExperimentsClient({ baseUrl: 'https://serika.moe', cookies, fetch: async () => ({ ok: false }) });
  const id = await client.ensureDeviceId();
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(cookies.jar, [{ name: 'serika_ab', value: id, domain: '.serika.moe' }]);
  assert.equal(await client.ensureDeviceId(), id);

  const existing = fakeCookies([{ name: 'serika_ab', value: 'site-made-device-id-123' }]);
  const adopt = createExperimentsClient({ baseUrl: 'https://serika.moe', cookies: existing, fetch: async () => ({ ok: false }) });
  assert.equal(await adopt.ensureDeviceId(), 'site-made-device-id-123');
  assert.equal(existing.jar.length, 1);
});

test('requests identify the desktop app and carry the session, and failures fall back to control', async () => {
  const requests = [];
  const cookies = fakeCookies([{ name: 'serika_session', value: 'sess' }, { name: 'serika_ab', value: 'device-id-0123456789' }]);
  const responses = [
    { ok: true, json: async () => ({ assignments: { 'new-login': { variant: 'qr-first', config: {}, tracked: true } }, previews: [] }) },
    { ok: true },
  ];
  const client = createExperimentsClient({
    baseUrl: 'https://serika.moe',
    cookies,
    fetch: async (url, init) => { requests.push({ url, ...init }); return responses.shift() ?? { ok: false }; },
  });
  const payload = await client.get();
  assert.equal(payload.assignments['new-login'].variant, 'qr-first');
  assert.equal(requests[0].url, 'https://serika.moe/api/experiments?platform=desktop');
  assert.equal(requests[0].headers['X-Serika-Client'], 'desktop');
  assert.equal(requests[0].headers['X-Serika-AB-Id'], 'device-id-0123456789');
  assert.match(requests[0].headers.Cookie, /serika_session=sess/);

  assert.equal(await client.expose(['new-login', 42]), true);
  assert.deepEqual(JSON.parse(requests[1].body), { keys: ['new-login'], platform: 'desktop' });
  assert.equal(await client.expose([]), false);

  const offline = createExperimentsClient({ baseUrl: 'https://serika.moe', cookies, fetch: async () => { throw new Error('offline'); } });
  assert.deepEqual(await offline.get(), { platform: 'desktop', assignments: {}, previews: [] });
});

function element(classes) {
  const attributes = new Map();
  return {
    classes,
    classList: { forEach: (fn) => classes.forEach(fn) },
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    hidden: () => attributes.has('data-ab-hidden'),
  };
}

test('pages show only the assigned variant of each ab-- class and report what was shown', async () => {
  const elements = [element(['ab--new-login--control']), element(['card', 'ab--new-login--qr-first']), element(['ab--unknown--b']), element(['ab--unknown--control'])];
  const exposed = [];
  const document = {
    readyState: 'complete',
    head: { appendChild: () => {} },
    body: {},
    documentElement: { dataset: {} },
    createElement: () => ({}),
    querySelectorAll: () => elements,
    addEventListener: () => {},
  };
  const window = {
    serika: {
      experiments: {
        get: async () => ({ assignments: { 'new-login': { variant: 'qr-first', config: {}, tracked: true } } }),
        expose: (keys) => exposed.push(...keys),
        track: () => {},
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/experiments-ui.js'), 'utf8'), {
    window, document, MutationObserver: class { observe() {} },
  });
  // Before the answer arrives, every page is on control.
  assert.deepEqual(elements.map((el) => el.hidden()), [false, true, true, false]);
  await window.serikaExperiments.ready;
  assert.deepEqual(elements.map((el) => el.hidden()), [true, false, true, false]);
  assert.equal(window.serikaExperiments.variant('new-login'), 'qr-first');
  assert.equal(document.documentElement.dataset.ab, 'new-login:qr-first');
  assert.deepEqual(exposed, ['new-login']);
});
