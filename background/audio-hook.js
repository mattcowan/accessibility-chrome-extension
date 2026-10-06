// Page-world audio recorder for the audio checker's "Reload and record".
// The service worker installs it with Page.addScriptToEvaluateOnNewDocument
// (see debugger-manager.js) and reloads the tab, so it runs in the page's
// main world before any page script. It records:
//   - every HTMLMediaElement.prototype.play() call and its outcome
//     ('played', or the rejection name, e.g. 'NotAllowedError' when the
//     autoplay policy blocked it);
//   - attribute autoplay that started (seen as a 'playing' event);
//   - every AudioContext created, and its final state.
// Each record notes whether the page had transient user activation at that
// moment (navigator.userActivation.isActive), which separates user-started
// audio from autoplay.
//
// The checker (checkers/audio-check.js) runs in the isolated world and cannot
// read main-world variables. It dispatches '__a11y-audio-query' on document;
// the hook answers synchronously with one '__a11y-audio-rec' event per record,
// dispatched on the media element when it is in the page (so the checker gets
// the element as the event target) and on document otherwise.
//
// This function is serialized with toString(): it must stay self-contained.
function audioHook() {
  if (window.__a11yAudioHook) return;
  Object.defineProperty(window, '__a11yAudioHook', { value: true });

  const t0 = performance.now();
  const records = [];
  const elementOf = new Map(); // record -> media element
  const userActive = () => !!(navigator.userActivation && navigator.userActivation.isActive);
  const now = () => Math.round(performance.now() - t0);

  function mediaRecord(el, via) {
    const rec = {
      kind: 'media',
      via,
      tag: el.tagName.toLowerCase(),
      src: String(el.currentSrc || el.src || '').slice(0, 200),
      muted: el.muted,
      volume: el.volume,
      user: userActive(),
      t: now(),
      outcome: 'pending',
    };
    records.push(rec);
    elementOf.set(rec, el);
    return rec;
  }

  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    const rec = mediaRecord(this, 'play()');
    let p;
    try {
      p = play.apply(this, args);
    } catch (e) {
      rec.outcome = (e && e.name) || 'error';
      throw e;
    }
    if (p && typeof p.then === 'function') {
      p.then(
        () => {
          rec.outcome = 'played';
          rec.muted = this.muted;
          rec.volume = this.volume;
        },
        (e) => {
          rec.outcome = (e && e.name) || 'error';
        }
      );
    }
    return p;
  };

  // Attribute autoplay never calls play(); catch it when it starts.
  document.addEventListener(
    'playing',
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLMediaElement)) return;
      for (const [, known] of elementOf) if (known === el) return;
      const rec = mediaRecord(el, 'autoplay');
      rec.outcome = 'played';
    },
    true
  );

  const Base = window.AudioContext;
  if (typeof Base === 'function') {
    window.AudioContext = class AudioContext extends Base {
      constructor(...args) {
        super(...args);
        const rec = {
          kind: 'webaudio',
          via: 'new AudioContext()',
          user: userActive(),
          runningUser: false,
          t: now(),
          outcome: this.state,
        };
        records.push(rec);
        this.addEventListener('statechange', () => {
          rec.outcome = this.state;
          if (this.state === 'running' && userActive()) rec.runningUser = true;
        });
      }
    };
  }

  document.addEventListener('__a11y-audio-query', () => {
    for (const rec of records) {
      const el = elementOf.get(rec);
      const target = el && el.isConnected ? el : document;
      target.dispatchEvent(
        new CustomEvent('__a11y-audio-rec', {
          detail: JSON.stringify(rec),
          bubbles: true,
          composed: true,
        })
      );
    }
  });
}

export const AUDIO_HOOK_SOURCE = `(${audioHook.toString()})();`;
