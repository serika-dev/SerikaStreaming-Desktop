/**
 * A/B tests on the desktop app's own pages (login, settings): the same API as serika.moe.
 *
 *   <div class="ab--new-login--control">…</div>
 *   <div class="ab--new-login--qr-first">…</div>      only the assigned variant shows
 *
 *   serikaExperiments.variant('new-login')            'qr-first'
 *   serikaExperiments.track('signed-in-with-qr')      custom goal
 *
 * Every page starts on control (the other variants are hidden until the answer arrives,
 * which takes one request), then shows the assigned variant.
 */
(function () {
  const HIDDEN = 'data-ab-hidden';
  const CLASS = /^ab--([a-z0-9-]+?)--([a-z0-9-]+)$/;
  const style = document.createElement('style');
  style.textContent = `[${HIDDEN}]{display:none!important}`;
  document.head.appendChild(style);

  class SerikaExperiments {
    constructor() {
      this.assignments = {};
      this.exposed = new Set();
      this.loaded = false;
      this.ready = window.serika?.experiments
        ? window.serika.experiments.get().then((payload) => {
          this.assignments = (payload && payload.assignments) || {};
          this.loaded = true;
          this.apply();
        }).catch(() => { this.loaded = true; this.apply(); })
        : Promise.resolve();
    }

    variant(key) {
      return this.assignments[key]?.variant || 'control';
    }

    /** Feature rollouts: does this person have it? */
    isOn(key) {
      return this.variant(key) !== 'control';
    }

    config(key) {
      return this.assignments[key]?.config || {};
    }

    expose(key) {
      if (!this.assignments[key]?.tracked || this.exposed.has(key)) return;
      this.exposed.add(key);
      window.serika?.experiments?.expose([key]);
    }

    track(goal, value) {
      window.serika?.experiments?.track(goal, value);
    }

    /** Shows each `ab--key--variant` element only for the assigned variant. */
    apply(root = document) {
      const tokens = Object.entries(this.assignments).map(([key, a]) => `${key}:${a.variant}`);
      document.documentElement.dataset.ab = tokens.join(' ');
      root.querySelectorAll('[class*="ab--"]').forEach((element) => {
        let show = true;
        element.classList.forEach((name) => {
          const match = name.match(CLASS);
          if (!match) return;
          const [, key, variant] = match;
          if (this.variant(key) !== variant) show = false;
          else if (this.loaded) this.expose(key);
        });
        if (show) element.removeAttribute(HIDDEN);
        else element.setAttribute(HIDDEN, '');
      });
    }
  }

  const experiments = new SerikaExperiments();
  window.serikaExperiments = experiments;
  const start = () => {
    experiments.apply();
    new MutationObserver(() => experiments.apply()).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
