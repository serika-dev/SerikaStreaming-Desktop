/**
 * A/B tests (Admin → Experiments on serika.moe) for the desktop app's own pages.
 *
 * The site in the main window needs nothing from here: serika.moe recognises the desktop
 * app by its Electron user agent and assigns variants itself. The login and settings pages
 * are local files, so this asks serika.moe for their variants (with the signed-in session,
 * or the `serika_ab` device cookie when signed out, the same one the site uses) and relays
 * exposures and goals. Pages use it through `window.serikaExperiments` (experiments-ui.js).
 */

const crypto = require('crypto');

const DEVICE_COOKIE = 'serika_ab';
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const TWO_YEARS_SECONDS = 2 * 365 * 24 * 60 * 60;

function createExperimentsClient({ baseUrl, cookies, fetch, now = () => Date.now() }) {
  let deviceId = null;

  async function ensureDeviceId() {
    if (deviceId) return deviceId;
    const existing = (await cookies.get({ url: baseUrl, name: DEVICE_COOKIE }).catch(() => []))[0]?.value;
    if (existing && DEVICE_ID_PATTERN.test(existing)) {
      deviceId = existing;
      return deviceId;
    }
    deviceId = crypto.randomUUID();
    await cookies.set({
      url: baseUrl,
      name: DEVICE_COOKIE,
      value: deviceId,
      domain: `.${new URL(baseUrl).hostname.replace(/^www\./, '')}`,
      path: '/',
      secure: true,
      sameSite: 'lax',
      expirationDate: Math.floor(now() / 1000) + TWO_YEARS_SECONDS,
    }).catch(() => undefined);
    return deviceId;
  }

  async function headers(json) {
    const id = await ensureDeviceId();
    const jar = await cookies.get({ url: baseUrl }).catch(() => []);
    const cookieHeader = jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    return {
      Accept: 'application/json',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      'X-Serika-Client': 'desktop',
      'X-Serika-AB-Id': id,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    };
  }

  async function get() {
    try {
      const response = await fetch(`${baseUrl}/api/experiments?platform=desktop`, { headers: await headers(false) });
      if (!response.ok) return { platform: 'desktop', assignments: {}, previews: [] };
      const data = await response.json();
      return {
        platform: 'desktop',
        assignments: data && typeof data.assignments === 'object' && data.assignments ? data.assignments : {},
        previews: Array.isArray(data?.previews) ? data.previews : [],
      };
    } catch {
      return { platform: 'desktop', assignments: {}, previews: [] };
    }
  }

  async function post(path, body) {
    try {
      const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: await headers(true), body: JSON.stringify(body) });
      return response.ok;
    } catch {
      return false;
    }
  }

  return {
    ensureDeviceId,
    get,
    expose: (keys) => {
      const valid = Array.isArray(keys) ? keys.filter((key) => typeof key === 'string' && key.length <= 64).slice(0, 50) : [];
      return valid.length ? post('/api/experiments/exposures', { keys: valid, platform: 'desktop' }) : Promise.resolve(false);
    },
    track: (goal, value) => {
      if (typeof goal !== 'string' || goal.length > 64) return Promise.resolve(false);
      return post('/api/experiments/track', Number.isFinite(value) ? { goal, value } : { goal });
    },
  };
}

module.exports = { createExperimentsClient, DEVICE_COOKIE };
