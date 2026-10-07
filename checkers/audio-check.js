// Audio autoplay checker (WCAG 1.4.2 Audio Control / Trusted Tester 2.A).
// Injected (classic script) after selector.js, findings.js, accname.js and
// mechanism.js via chrome.scripting.executeScript files[]. Registers itself
// on globalThis.__a11yCheckers; does no scanning at injection time.
//
// Reports audio that starts without user action and can play for more than
// 3 seconds, and whether a control to pause, stop, or change its volume is
// within the first three elements. Three cases:
//   - plays now: an unmuted media element that is playing;
//   - played: an element that started on its own and has stopped or ended
//     (graded on how long it actually played, from el.played);
//   - would play: an unmuted autoplay element the browser's autoplay policy
//     kept paused. Whether it plays depends on the browser profile (user
//     interaction, Media Engagement Index), so these are always `review`.
// After "Reload and record", the page-world hook (background/audio-hook.js)
// also reports script calls to play() and Web Audio starts, including calls
// the browser blocked. Returns { findings, playing, hooked } — `playing` lets
// the popup tell whether Chrome's tab-level "audible" flag is already
// explained; `hooked` says whether the recorder answered in this frame.
globalThis.__a11yCheckers = globalThis.__a11yCheckers || {};

globalThis.__a11yCheckers.audio = function audio() {
  const { makeFinding, collectMatching } = globalThis.__a11yFindings;
  const { find, describe } = globalThis.__a11yMechanism;
  const findings = [];
  let playing = 0;

  const RULE = 'WCAG 1.4.2 / Trusted Tester 2.A';

  // Records from the Reload-and-record hook. The hook lives in the page's
  // main world; this checker runs in the isolated world, so they talk through
  // DOM events. Each record is dispatched on its media element (the event
  // target crosses worlds; only the string detail is read). Synchronous: the
  // hook answers inside dispatchEvent. The hook always answers first with a
  // { kind: 'hook' } sentinel, so "no hook" (hooked: false) is distinct from
  // "hook ran and recorded nothing".
  function readRecords() {
    const out = [];
    let hooked = false;
    const onRecord = (e) => {
      try {
        const rec = JSON.parse(e.detail);
        if (rec.kind === 'hook') {
          hooked = true;
          return;
        }
        const target = e.composedPath()[0];
        rec.el = target && target.nodeType === Node.ELEMENT_NODE ? target : null;
        out.push(rec);
      } catch {
        // malformed record; skip
      }
    };
    document.addEventListener('__a11y-audio-rec', onRecord, true);
    try {
      document.dispatchEvent(new CustomEvent('__a11y-audio-query'));
    } finally {
      document.removeEventListener('__a11y-audio-rec', onRecord, true);
    }
    return { hooked, records: out };
  }

  const { hooked, records } = readRecords();
  const recordFor = new Map(); // element -> latest media record
  for (const rec of records) {
    if (rec.kind === 'media' && rec.el) recordFor.set(rec.el, rec);
  }

  function hasSource(el) {
    if (el.srcObject) return true;
    return !!el.currentSrc && el.networkState !== HTMLMediaElement.NETWORK_NO_SOURCE;
  }

  const audibleSettings = (el) => !el.muted && el.volume > 0;

  // More than 3 seconds, or unknown (no metadata yet, or a live stream).
  function longEnough(el) {
    const d = el.duration;
    if (Number.isFinite(d)) return d > 3 || el.loop;
    return true;
  }

  // Chrome-only counter: a video that has played for a while but decoded no
  // audio bytes has no audio track. Not usable for MediaStream sources.
  function silentVideo(el) {
    return (
      el.tagName === 'VIDEO' &&
      !el.srcObject &&
      typeof el.webkitAudioDecodedByteCount === 'number' &&
      el.currentTime > 1 &&
      el.webkitAudioDecodedByteCount === 0
    );
  }

  function mechanismSentence(m) {
    if (!m) return 'No control to pause, stop, or change the volume of this audio was found.';
    if (m.where === 'first3') return `A candidate control is within the first three elements. ${describe(m)}`;
    return `A candidate control was found, but not within the first three elements. ${describe(m)}`;
  }

  // Severity for audio known to have started without user action.
  function autoFinding(el, m, lead) {
    let severity;
    let details;
    if (m && m.where === 'first3') {
      severity = 'review';
      details = `${lead} ${mechanismSentence(m)} Activate it and confirm it pauses, stops, or changes the volume of only this audio (${RULE}).`;
    } else if (m) {
      severity = 'warn';
      details = `${lead} ${mechanismSentence(m)} ${RULE} requires the control within the first three elements a user encounters.`;
    } else {
      severity = 'fail';
      details = `${lead} ${mechanismSentence(m)} ${RULE} requires a way to pause, stop, or control its volume within the first three elements.`;
    }
    findings.push(makeFinding({ tool: 'audio', wcag: '1.4.2', severity, el, details }));
  }

  // Total seconds the element has actually played (all played ranges).
  function playedSeconds(el) {
    let total = 0;
    for (let i = 0; i < el.played.length; i++) total += el.played.end(i) - el.played.start(i);
    return total;
  }

  function wouldPlay(el, how) {
    const m = find(el, '2.A');
    findings.push(
      makeFinding({
        tool: 'audio',
        wcag: '1.4.2',
        severity: 'review',
        el,
        details:
          `${how} The browser's autoplay policy kept it silent here, but on a profile that allows autoplay for this site (after user interaction, or with a high Media Engagement Index) it plays with sound. ` +
          `Test ${RULE} as if it plays: ${mechanismSentence(m)} Confirm the control pauses, stops, or changes the volume of only this audio.`,
      })
    );
  }

  const media = [];
  collectMatching(document, 'audio, video', media);
  for (const el of media) {
    if (!hasSource(el) || !audibleSettings(el) || !longEnough(el)) continue;
    const rec = recordFor.get(el);

    if (!el.paused && !el.ended) {
      if (silentVideo(el)) continue;
      playing++;
      const startedByUser = rec ? rec.user : null;
      if (startedByUser === true) continue; // the user started it: not auto-playing
      const m = find(el, '2.A');
      // navigator.userActivation cannot settle this: chrome.scripting carries
      // the popup click's user gesture into the page, so every checker run
      // gives the page sticky activation. Only the autoplay attribute or a
      // Reload-and-record entry (made with no gesture) proves autoplay.
      const certain = el.autoplay || startedByUser === false;
      if (certain) {
        autoFinding(el, m, 'Audio plays automatically for more than 3 seconds.');
      } else {
        findings.push(
          makeFinding({
            tool: 'audio',
            wcag: '1.4.2',
            severity: 'review',
            el,
            details:
              'Audio is playing without the autoplay attribute, so a script or the user started it. ' +
              `Use Reload and record to find out whether it starts on its own. If it does, ${RULE} needs a control within the first three elements. ${mechanismSentence(m)}`,
          })
        );
      }
      continue;
    }

    // Stopped or ended after playing. Audio that started on its own and ran
    // more than 3 seconds broke 1.4.2 even if it is quiet by the time a
    // checker runs (a 3.5 s clip has always ended by then). Only a recorded
    // start (user: false) proves that; the autoplay attribute alone gives
    // review, because a user restart after blocked autoplay looks the same.
    const startedAuto = rec ? rec.outcome === 'played' && rec.user === false : el.autoplay;
    if (startedAuto && (el.ended || el.currentTime > 0)) {
      const secs = playedSeconds(el);
      const shown = secs.toFixed(1);
      const m = find(el, '2.A');
      if (secs > 3 && !rec) {
        // No recording: the autoplay attribute is not proof here. If Chrome
        // blocked the autoplay and the user pressed play (and maybe paused),
        // the element looks the same. Graded honestly as review.
        findings.push(
          makeFinding({
            tool: 'audio',
            wcag: '1.4.2',
            severity: 'review',
            el,
            details:
              `This autoplay element played for ${shown} seconds and has ${el.ended ? 'ended' : 'stopped'}, but this check cannot tell whether it started on its own or the user started it after the browser blocked autoplay. ` +
              `Use Reload and record to confirm. If it starts on its own, ${RULE} needs a control within the first three elements. ${mechanismSentence(m)}`,
          })
        );
      } else if (secs > 3) {
        autoFinding(el, m, `Audio played automatically for ${shown} seconds and has ${el.ended ? 'ended' : 'stopped'}.`);
      } else {
        findings.push(
          makeFinding({
            tool: 'audio',
            wcag: '1.4.2',
            severity: 'review',
            el,
            details:
              `Audio started automatically and stopped after ${shown} seconds, before the 3-second threshold. Check what stopped it. ` +
              `If it can play for more than 3 seconds, ${RULE} needs a control within the first three elements. ${mechanismSentence(m)}`,
          })
        );
      }
      continue;
    }

    if (el.autoplay && el.paused && el.currentTime === 0) {
      wouldPlay(el, 'This element has autoplay and is not muted, but it is paused.');
    } else if (rec && rec.outcome === 'NotAllowedError' && !rec.user) {
      wouldPlay(el, 'A script called play() on this unmuted element without user action, and the browser blocked it.');
    }
  }

  // Embedded players (YouTube, Vimeo, …) that ask for autoplay with sound.
  // Their controls are inside the frame, out of this checker's reach.
  const frames = [];
  collectMatching(document, 'iframe', frames);
  for (const el of frames) {
    const allow = (el.getAttribute('allow') || '').toLowerCase();
    const src = el.getAttribute('src') || '';
    if (!/\bautoplay\b/.test(allow)) continue;
    if (!/[?&]autoplay=(1|true)\b/i.test(src)) continue;
    if (/[?&](mute|muted)=(1|true)\b/i.test(src)) continue;
    findings.push(
      makeFinding({
        tool: 'audio',
        wcag: '1.4.2',
        severity: 'review',
        el,
        details:
          `Embedded player requests autoplay (allow="autoplay" and autoplay=1 in its URL) and is not muted by its URL. ` +
          `Load the page and check whether it plays sound for more than 3 seconds. If it does, ${RULE} needs a control within the first three elements; this checker cannot see controls inside the embed.`,
      })
    );
  }

  // Recorded audio with no page element: `new Audio()` never inserted into
  // the page, and Web Audio. One page-level finding keeps the diff
  // fingerprint (tool|wcag|selector) unique.
  const loose = [];
  for (const rec of records) {
    if (rec.kind === 'media' && !rec.el && !rec.user && !rec.muted && rec.volume > 0) {
      if (rec.outcome === 'played') loose.push(`a script played audio from an element that is not in the page (${rec.src || 'no src'})`);
      else if (rec.outcome === 'NotAllowedError') loose.push(`a script tried to play audio from an element that is not in the page (${rec.src || 'no src'}) and the browser blocked it`);
    } else if (rec.kind === 'webaudio' && !rec.user && !rec.runningUser) {
      if (rec.outcome === 'running') loose.push('a script started Web Audio (AudioContext) without user action');
      else if (rec.outcome === 'suspended') loose.push('a script created a Web Audio context (AudioContext) without user action and the browser kept it suspended, so it plays on a profile that allows autoplay');
    }
  }
  if (loose.length) {
    findings.push(
      makeFinding({
        tool: 'audio',
        wcag: '1.4.2',
        severity: 'review',
        el: null,
        details:
          `Reload and record found audio that is not tied to a page element: ${loose.join('; ')}. ` +
          `Check whether it plays for more than 3 seconds. If it does, ${RULE} needs a control within the first three elements to pause, stop, or change its volume.`,
      })
    );
  }

  return { findings, playing, hooked };
};
