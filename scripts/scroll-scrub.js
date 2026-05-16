    const idleVid  = document.getElementById('idle-video');
    const scrubVid = document.getElementById('scrub-video');
    const endVid   = document.getElementById('end-video');

    // Desktop (mouse pointer) gets the high-res 1080p originals from videos_hd/.
    // Mobile / touch devices get the smaller 720p files from the project root.
    const isDesktop = matchMedia('(pointer: fine)').matches;
    const VIDEO_DIR = isDesktop ? 'videos_hd/' : '';

    // Set idle video src now that we know which directory to use. Autoplay
    // attribute on the element kicks in once the src is set + load() runs.
    idleVid.src = VIDEO_DIR + 'static%20intro.mp4';
    try { idleVid.load(); } catch (_) {}

    // Fetch each non-autoplay video to a Blob and hand iOS an in-memory URL —
    // sidesteps iOS Safari's quirky lazy-load behavior for non-autoplay videos.
    function preloadAsBlob(videoEl, url) {
      fetch(url, { cache: 'force-cache' })
        .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.blob(); })
        .then(blob => {
          videoEl.src = URL.createObjectURL(blob);
          // load() forces the element to pick up the new src
          try { videoEl.load(); } catch (_) {}
        })
        .catch(() => {
          // Fallback: hand iOS the URL directly
          videoEl.src = url;
          try { videoEl.load(); } catch (_) {}
        });
    }
    // NOTE: scrub + end video preloads are NOT kicked off here. They're heavy
    // (4 MB + 600 KB) and parallel fetches on mobile starve the tiny VHS frame
    // images of connection slots. We trigger preloadAsBlob below, only after
    // all VHS frames have finished loading. By the time the user scrolls (a
    // few seconds later) the scrub video is ready.
    let scrubPreloaded = false;
    function preloadVideosOnce() {
      if (scrubPreloaded) return;
      scrubPreloaded = true;
      preloadAsBlob(scrubVid, VIDEO_DIR + 'brain%20zoom%201.mp4');
      preloadAsBlob(endVid,   VIDEO_DIR + 'outro.mp4');
    }

    // ---- State machine: idle -> scrubbing -> ended ----
    let state = 'idle';
    function setState(next) {
      if (state === next) return;
      state = next;
      document.body.dataset.state = next;
      // Lower layers stay active as backdrops so the new layer fades in over
      // a fully-opaque previous frame (no black flash through transparency).
      setActive(idleVid,  true);
      setActive(scrubVid, next === 'scrubbing' || next === 'ended');
      setActive(endVid,   next === 'ended');

      if (next === 'idle') {
        idleVid.play().catch(() => {});
        scrubVid.pause();
        endVid.pause(); endVid.currentTime = 0;
      } else if (next === 'scrubbing') {
        idleVid.pause();
        endVid.pause(); endVid.currentTime = 0;
      } else if (next === 'ended') {
        scrubVid.pause();
        endVid.currentTime = 0;
        endVid.play().catch(() => {});
      }
    }
    function setActive(el, on) {
      el.classList.toggle('active', on);
    }
    setActive(idleVid, true); // initial paint

    // iOS Safari frequently ignores the `autoplay` HTML attribute. Force the
    // idle video to play once it has data, and on visibility return.
    function playIdle() {
      idleVid.muted = true;
      const p = idleVid.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
    if (idleVid.readyState >= 2) playIdle();
    else idleVid.addEventListener('loadeddata', playIdle);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state === 'idle') playIdle();
    });

    // iOS Safari blocks playback until a video has been play()'d inside a user
    // gesture. The Start click unlocks scrubVid by itself (we play() it directly).
    // We still need to prime endVid here so its later auto-play in setState('ended')
    // succeeds — the Start click is also our gesture window for that.
    let primed = false;
    function primeOnFirstGesture() {
      if (primed) return;
      primed = true;
      const p = endVid.play();
      if (p && typeof p.then === 'function') {
        p.then(() => endVid.pause()).catch(() => {});
      } else {
        try { endVid.pause(); } catch (_) {}
      }
    }

    // Gate the preloader's fade-out until the page can transition seamlessly:
    //   - idle video has enough data to play (rs>=3 = HAVE_FUTURE_DATA)
    //   - scrub video has metadata so the first scroll can seek
    //   - custom wordmark font is loaded so "quentin." doesn't flash a fallback
    // The toggle phase keeps cycling 04↔03 until all three are true (or the
    // 6-second hard cap fires).
    let videosReady = false;
    function markReady(reason) {
      if (videosReady) return;
      videosReady = true;
      document.body.classList.add('videos-ready');
    }
    function checkReady() {
      if (videosReady) return;
      const idleOk  = idleVid.readyState  >= 3;
      const scrubOk = scrubVid.readyState >= 1;
      let fontOk = true;
      try { fontOk = document.fonts.check('1em LowerResolution'); } catch (_) {}
      if (idleOk && scrubOk && fontOk) markReady('all-ready');
    }
    idleVid.addEventListener('canplay',         checkReady);
    idleVid.addEventListener('canplaythrough',  checkReady);
    scrubVid.addEventListener('loadedmetadata', checkReady);
    scrubVid.addEventListener('loadeddata',     checkReady);
    scrubVid.addEventListener('canplay',        checkReady);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(checkReady);
    }
    setTimeout(() => markReady('timeout'), 6000);  // hard cap — never get stuck
    checkReady();


    // ---- Button-driven playback (with future checkpoint support) ----
    // Add timestamps (in seconds) when overlays exist for those moments.
    // Empty = play through start to end without stopping.
    const CHECKPOINTS = [];
    let nextCheckpointIdx = 0;
    let watchRaf = 0;

    const startBtn = document.getElementById('start-btn');
    function startPlayback() {
      if (!videosReady) return;
      // Trigger the press-flash animation. Force reflow so re-presses (Continue
      // after a checkpoint) restart the animation cleanly.
      startBtn.classList.remove('pressed');
      void startBtn.offsetWidth;
      startBtn.classList.add('pressed');
      primeOnFirstGesture();
      setState('scrubbing');
      document.body.classList.remove('paused-at-checkpoint');
      const p = scrubVid.play();
      if (p && p.catch) p.catch(() => {});
      watchPlayback();
    }
    startBtn.addEventListener('click', startPlayback);
    // After the press animation finishes, drop the class so the next press
    // (Continue) can re-trigger it. Button is invisible by then anyway.
    startBtn.addEventListener('animationend', (e) => {
      if (e.animationName === 'vhs-press') startBtn.classList.remove('pressed');
    });

    function watchPlayback() {
      cancelAnimationFrame(watchRaf);
      const stopAt = CHECKPOINTS[nextCheckpointIdx];   // undefined = play to end
      const tick = () => {
        if (scrubVid.paused || scrubVid.ended) return;
        if (stopAt !== undefined && scrubVid.currentTime >= stopAt) {
          scrubVid.pause();
          nextCheckpointIdx++;
          document.body.classList.add('paused-at-checkpoint');
          return;
        }
        watchRaf = requestAnimationFrame(tick);
      };
      watchRaf = requestAnimationFrame(tick);
    }

    scrubVid.addEventListener('ended', () => {
      cancelAnimationFrame(watchRaf);
      document.body.classList.remove('paused-at-checkpoint');
      setState('ended');
    });

    // Paint first frame of scrub video so it's primed
    function primeScrub() { scrubVid.currentTime = 0; }
    if (scrubVid.readyState >= 2) primeScrub();
    else scrubVid.addEventListener('loadeddata', primeScrub);

    // ------- VHS intro layer (now a static backdrop for the preloader) -------
    // The intro is no longer a flicker sequence — frame_04 is .active from
    // page load and just sits there as the plain blue backdrop while the
    // preloader + password gate are on screen. fadeOutVHS() fires only on
    // unlock, handing the surface over to the idle video.
    const VHS_FADE_MS = 1800;   // matches CSS opacity transition

    const vhsLayer  = document.getElementById('vhs-intro');
    const vhsFrames = Array.from(vhsLayer.querySelectorAll('.vhs-frame'));

    function waitForImg(im) {
      return im.complete && im.naturalWidth > 0
        ? Promise.resolve()
        : new Promise(resolve => {
            im.addEventListener('load',  resolve, { once: true });
            im.addEventListener('error', resolve, { once: true });
          });
    }
    const allFramesPromise = Promise.all(vhsFrames.map(waitForImg));
    // Once all frames are in, kick off the heavy video preloads. Network is
    // free at this point, so the videos get full bandwidth.
    allFramesPromise.then(preloadVideosOnce);
    // 3s safety net in case something stalls — start preloading regardless.
    setTimeout(preloadVideosOnce, 3000);

    function fadeOutVHS() {
      vhsLayer.classList.add('fading');
      // Brand fades in synchronized with the VHS layer fading out. Both
      // transitions run at 1.8s so they finish at the same moment.
      document.body.classList.add('brand-ready');
      // Kick the idle video before the fade starts so it's already moving by the
      // time the VHS layer goes transparent. Try again on completion as a backup.
      try { playIdle(); } catch (_) {}
      // iOS Safari often skips loading a video that's been covered by another
      // element. Force-trigger the scrub video's download now that VHS is going.
      try { if (scrubVid.readyState < 2) scrubVid.load(); } catch (_) {}
      setTimeout(() => {
        vhsLayer.style.display = 'none';
        document.body.classList.remove('vhs-running');
        try { playIdle(); } catch (_) {}
      }, VHS_FADE_MS);
    }

    // ------- Preloader + password gate -------
    // Flow: preloader (bouncing wordmark on frame_04 backdrop) → click → gate
    // (password prompt) → submit "play" → fadeOutVHS() hands off to idle state.
    const PASSWORD = 'play';

    const gate      = document.getElementById('gate');
    const gateInput = document.getElementById('gate-input');
    const gateError = document.getElementById('gate-error');

    // iOS Safari: position:fixed elements still cover the full layout viewport
    // when the soft keyboard is up, which can push the submit button behind
    // the keyboard. Bind gate height/top to the visual viewport.
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const fitGate = () => {
        gate.style.height = vv.height + 'px';
        gate.style.top    = vv.offsetTop + 'px';
      };
      vv.addEventListener('resize', fitGate);
      vv.addEventListener('scroll', fitGate);
      fitGate();
    }

    let unlocked = false;
    function tryUnlock(value) {
      // Lowercase — iOS predictive text can sneak a capital past `autocapitalize="off"`.
      if (value.toLowerCase() === PASSWORD) unlock();
      else showError();
    }
    function unlock() {
      if (unlocked) return;
      unlocked = true;
      document.body.classList.add('unlocked');
      try { gateInput.blur(); } catch (_) {}
      try { playUnlockChime(); } catch (_) {}
      // Hand the surface over to the idle state — fades vhs-intro out, fades
      // static idle brand in, plays idle video, drops vhs-running.
      fadeOutVHS();
    }
    function showError() {
      gateError.classList.add('visible');
      gate.classList.add('shaking');
      gateInput.value = '';
      syncInputWidth();
      setTimeout(() => gate.classList.remove('shaking'), 500);
      setTimeout(() => gateError.classList.remove('visible'), 1100);
    }

    // Grow/shrink the input to fit its text so the block cursor sits right
    // after the last character.
    const gateMeasure = document.createElement('span');
    gateMeasure.className = 'gate-input gate-measure';
    gateMeasure.setAttribute('aria-hidden', 'true');
    gateInput.parentElement.appendChild(gateMeasure);
    function syncInputWidth() {
      gateMeasure.textContent = gateInput.value || '';
      gateInput.style.width = (gateMeasure.offsetWidth + 2) + 'px';
      gateInput.scrollLeft = 0;
    }
    gateInput.addEventListener('input', syncInputWidth);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(syncInputWidth);
    } else {
      syncInputWidth();
    }

    gate.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = gateInput.value.trim();
      if (!v) return;
      tryUnlock(v);
    });

    // iOS submit-button fix: tapping the button blurs the input, keyboard
    // collapses, layout shifts, the click misses. mousedown preventDefault
    // keeps the input focused; pointerup runs unlock directly.
    const gateSubmit = gate.querySelector('.gate-submit');
    gateSubmit.addEventListener('mousedown', (e) => { e.preventDefault(); });
    gateSubmit.addEventListener('pointerup', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      const v = gateInput.value.trim();
      if (v) tryUnlock(v);
    });

    // Tapping anywhere on the gate (except the submit button) focuses the
    // input — the input has width:0 when empty so it has no tap target.
    gate.addEventListener('click', (e) => {
      if (e.target === gateInput) return;
      if (e.target.closest('.gate-submit')) return;
      gateInput.focus();
    });

    // Preloader: full-screen click target. Tap to advance to the gate. The
    // click also doubles as the iOS user-gesture window — prime idle/end
    // video playback AND start the background audio fade-in here so the later
    // auto-plays / audio.play() succeed.
    document.getElementById('preloader').addEventListener('click', () => {
      document.body.classList.add('preloader-passed');
      try { playIdle(); } catch (_) {}
      primeOnFirstGesture();
      startAudio();
      // Focus the input after the gate's fade-in has started — premature focus
      // on iOS can pop the keyboard while the gate is still transparent.
      setTimeout(() => { try { gateInput.focus(); } catch (_) {} }, 550);
    });

    // ------- Background audio -------
    // Plays on first user gesture (preloader click), loops, fades in to 50%.
    // Mute toggle bottom-right lets the user kill it whenever.
    const bgAudio = new Audio('youtube-audio-compressed.mp3');
    bgAudio.loop = true;
    bgAudio.volume = 0;
    bgAudio.preload = 'auto';

    let audioStarted = false;
    let audioFadeInId = null;
    function startAudio() {
      if (audioStarted) return;
      audioStarted = true;
      bgAudio.play().then(() => {
        const target = 0.5;
        const stepMs = 80;
        const steps  = 20;
        let i = 0;
        audioFadeInId = setInterval(() => {
          i += 1;
          bgAudio.volume = Math.min(target, (i / steps) * target);
          if (i >= steps) {
            clearInterval(audioFadeInId);
            audioFadeInId = null;
          }
        }, stepMs);
      }).catch(() => {
        // Autoplay blocked — leave the flag false-equivalent so the next
        // gesture (e.g. mute-toggle click) can retry.
        audioStarted = false;
      });
    }

    // ------- Unlock chime -------
    // Short synthesized arpeggio (C5-E5-G5) on Web Audio — no asset to ship.
    // Fires from unlock() so both the password and the minesweeper win path
    // get the same sting. Skipped if the user has muted the soundtrack.
    let unlockAudioCtx = null;
    function playUnlockChime() {
      if (bgAudio.muted) return;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!unlockAudioCtx) unlockAudioCtx = new Ctx();
        const ctx = unlockAudioCtx;
        // Some browsers suspend the context until a user gesture; unlock() is
        // always called from a click/keystroke, so resume() is safe here.
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});

        const NOTES   = [523.25, 659.25, 783.99];   // C5, E5, G5
        const NOTE_MS = 130;                         // stagger between attacks
        const TAIL_MS = 360;                         // single-note decay length

        NOTES.forEach((freq, i) => {
          const t0 = ctx.currentTime + (i * NOTE_MS) / 1000;
          const osc  = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';                     // warmer than sine, less harsh than saw
          osc.frequency.value = freq;
          // Envelope: 12ms attack, exponential decay.
          gain.gain.setValueAtTime(0, t0);
          gain.gain.linearRampToValueAtTime(0.22, t0 + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + TAIL_MS / 1000);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t0);
          osc.stop(t0 + TAIL_MS / 1000 + 0.02);
        });
      } catch (_) {}
    }

    const muteBtn = document.getElementById('mute-toggle');
    function syncMuteUi() {
      muteBtn.textContent = bgAudio.muted ? 'sound: off' : 'sound: on';
    }
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      bgAudio.muted = !bgAudio.muted;
      // First click also counts as a user gesture — start audio if a prior
      // attempt was blocked (e.g. user tapped the mute toggle before ENTER).
      if (!audioStarted && !bgAudio.muted) startAudio();
      syncMuteUi();
    });
    syncMuteUi();

    // Back button — in-page back to the preloader. Wipes the post-gate state
    // so the next ENTER tap re-runs the full entry (audio fade-in, video
    // gesture prime, gate prompt). Mute preference is preserved across re-entry.
    document.getElementById('back-btn').addEventListener('click', (e) => {
      e.stopPropagation();

      // Exit any open bypass panel.
      if (typeof msStopTimer === 'function') msStopTimer();
      document.body.classList.remove('minesweeper-on', 'poker-on', 'tk-on');

      // Reset the video state machine to idle and rewind everything.
      setState('idle');
      scrubVid.pause();
      scrubVid.currentTime = 0;
      endVid.pause();
      endVid.currentTime = 0;
      nextCheckpointIdx = 0;
      cancelAnimationFrame(watchRaf);

      // Restore the vhs-intro layer as the preloader backdrop. fadeOutVHS()
      // hides it with display:none + .fading; undo both so the bouncing
      // wordmark has something blue to sit on.
      vhsLayer.style.display = '';
      vhsLayer.classList.remove('fading');

      // Body classes: back to vhs-running, drop the unlock/pass/brand-ready
      // chain. brand-bounce-ready stays — the wordmark keeps bouncing.
      document.body.classList.remove('unlocked', 'preloader-passed', 'brand-ready', 'paused-at-checkpoint');
      document.body.classList.add('vhs-running');
      unlocked = false;

      // Clear the gate input so the next entry sees an empty prompt.
      gateInput.value = '';
      syncInputWidth();

      // Stop and reset audio. Cancel any in-flight fade-in so a stale
      // interval doesn't keep ticking volume on a paused element. Mute state
      // is left alone — the user's sound preference persists across re-entry.
      if (audioFadeInId) {
        clearInterval(audioFadeInId);
        audioFadeInId = null;
      }
      bgAudio.pause();
      bgAudio.currentTime = 0;
      bgAudio.volume = 0;
      audioStarted = false;
    });

    // ------- Minesweeper -------
    // 7×7 board, 9 mines. First click is always safe AND opens a chunk via
    // flood-reveal — mines are placed AFTER the first click, avoiding both
    // the clicked cell and its neighbors. Win = all non-mine cells revealed.
    const MS_ROWS  = 9;
    const MS_COLS  = 9;
    const MS_MINES = 12;
    // Number colors — borrowed from the DVD-bounce palette so the board
    // reads as part of the same VHS world.
    const MS_NUM_COLORS = [
      '',         // 0 unused (zero-neighbor cells flood-reveal blank)
      '#4de0ff',  // 1 cyan
      '#4dff7a',  // 2 green
      '#ff4d4d',  // 3 red
      '#b366ff',  // 4 purple
      '#ff9933',  // 5 orange
      '#ffea00',  // 6 yellow
      '#ff66d4',  // 7 pink
      '#fff5c4',  // 8 cream
    ];

    const MS_TIME = 120;   // seconds — 2 min countdown, starts on first click

    const msGridEl      = document.getElementById('ms-grid');
    const msMinesLeftEl = document.getElementById('ms-mines-left');
    const msStatusEl    = document.getElementById('ms-status');
    const msTimerEl     = document.getElementById('ms-timer');

    let msCells = [];        // index = r * COLS + c
    let msFirstClick = true;
    let msGameOver  = false;
    let msFlagCount = 0;
    let msSecondsLeft  = MS_TIME;
    let msTimerInterval = null;

    function msFormatTime(s) {
      const m = Math.floor(s / 60);
      const r = s % 60;
      return m + ':' + String(r).padStart(2, '0');
    }
    function msUpdateTimerUi() {
      msTimerEl.textContent = msFormatTime(msSecondsLeft);
      msTimerEl.classList.toggle('low', msSecondsLeft <= 10 && msSecondsLeft > 0);
    }
    function msStartTimer() {
      if (msTimerInterval) return;
      msTimerInterval = setInterval(() => {
        msSecondsLeft -= 1;
        msUpdateTimerUi();
        if (msSecondsLeft <= 0) {
          msStopTimer();
          msTimeUp();
        }
      }, 1000);
    }
    function msStopTimer() {
      if (msTimerInterval) {
        clearInterval(msTimerInterval);
        msTimerInterval = null;
      }
    }
    function msTimeUp() {
      msGameOver = true;
      // Same "reveal all mines" treatment as the boom path, minus the
      // exploded-cell highlight (no specific cell killed you — time did).
      for (const c of msCells) {
        if (c.mine && !c.flagged) {
          c.el.classList.add('mine');
          c.el.textContent = '✱';
        }
      }
      msStatusEl.textContent = 'time up';
      msStatusEl.style.color = '#ff4d4d';
    }

    function msCellAt(r, c) {
      if (r < 0 || r >= MS_ROWS || c < 0 || c >= MS_COLS) return null;
      return msCells[r * MS_COLS + c];
    }
    function msNeighbors(cell) {
      const out = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const n = msCellAt(cell.r + dr, cell.c + dc);
          if (n) out.push(n);
        }
      }
      return out;
    }

    function msInit() {
      msStopTimer();
      msSecondsLeft = MS_TIME;
      msUpdateTimerUi();
      msCells = [];
      msFirstClick = true;
      msGameOver = false;
      msFlagCount = 0;
      msGridEl.innerHTML = '';
      for (let r = 0; r < MS_ROWS; r++) {
        for (let c = 0; c < MS_COLS; c++) {
          const el = document.createElement('button');
          el.type = 'button';
          el.className = 'ms-cell';
          const cell = { r, c, mine: false, n: 0, revealed: false, flagged: false, el };
          // Left click = reveal; right click = flag.
          el.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); msReveal(cell); });
          el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); msFlag(cell); });
          // Long-press to flag on touch — pointer events cover both touch and
          // pen. Mouse uses contextmenu, so skip the timer for mouse input.
          let pressTimer = null;
          let pressFired = false;
          el.addEventListener('pointerdown', (ev) => {
            if (ev.pointerType === 'mouse') return;
            pressFired = false;
            pressTimer = setTimeout(() => {
              pressTimer = null;
              pressFired = true;
              msFlag(cell);
            }, 350);
          });
          const cancelPress = () => {
            if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
          };
          el.addEventListener('pointerup',     cancelPress);
          el.addEventListener('pointercancel', cancelPress);
          el.addEventListener('pointermove',   cancelPress);
          el.addEventListener('pointerleave',  cancelPress);
          // Swallow the click that follows a long-press so we don't flag-then-reveal.
          el.addEventListener('click', (ev) => {
            if (pressFired) { ev.preventDefault(); ev.stopImmediatePropagation(); pressFired = false; }
          }, true);
          msGridEl.appendChild(el);
          msCells.push(cell);
        }
      }
      msStatusEl.textContent = 'clear the board';
      msStatusEl.style.color = '';
      msMinesLeftEl.textContent = String(MS_MINES).padStart(2, '0');
    }

    function msPlaceMines(safe) {
      // First click is safe — but only the clicked cell, not its neighbors.
      // The clicked cell can have a non-zero count so no flood-reveal chunk
      // appears for free. Player has to chip away from a single number.
      const forbidden = new Set([safe]);
      const pool = msCells.filter(c => !forbidden.has(c));
      // Partial Fisher-Yates: pick MS_MINES cells uniformly without replacement.
      for (let i = 0; i < MS_MINES; i++) {
        const j = i + Math.floor(Math.random() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
        pool[i].mine = true;
      }
      // Compute neighbor counts.
      for (const c of msCells) {
        if (c.mine) continue;
        c.n = msNeighbors(c).filter(n => n.mine).length;
      }
    }

    function msReveal(cell) {
      if (msGameOver || cell.revealed || cell.flagged) return;
      if (msFirstClick) {
        msFirstClick = false;
        msPlaceMines(cell);
        msStartTimer();                              // clock starts on first click
      }
      if (cell.mine) { msExplode(cell); return; }
      msFlood(cell);
      msCheckWin();
    }

    function msFlood(start) {
      const stack = [start];
      while (stack.length) {
        const c = stack.pop();
        if (c.revealed || c.flagged) continue;
        c.revealed = true;
        c.el.classList.add('revealed');
        c.el.classList.remove('flagged');
        if (c.n > 0) {
          c.el.textContent = c.n;
          c.el.style.color = MS_NUM_COLORS[c.n];
        } else {
          // Zero-neighbor — cascade through neighbors so the user gets a chunk.
          for (const n of msNeighbors(c)) {
            if (!n.revealed && !n.mine) stack.push(n);
          }
        }
      }
    }

    function msFlag(cell) {
      if (msGameOver || cell.revealed) return;
      cell.flagged = !cell.flagged;
      cell.el.classList.toggle('flagged', cell.flagged);
      cell.el.textContent = cell.flagged ? '⚑' : '';
      msFlagCount += cell.flagged ? 1 : -1;
      msMinesLeftEl.textContent = String(Math.max(0, MS_MINES - msFlagCount)).padStart(2, '0');
    }

    function msExplode(triggered) {
      msGameOver = true;
      msStopTimer();
      triggered.el.classList.add('exploded');
      // Reveal all unflagged mines so the player sees the field.
      for (const c of msCells) {
        if (c.mine && !c.flagged) {
          c.el.classList.add('mine');
          c.el.textContent = '✱';
        }
      }
      msStatusEl.textContent = 'boom';
      msStatusEl.style.color = '#ff4d4d';
    }

    function msCheckWin() {
      // Win when every non-mine cell is revealed.
      for (const c of msCells) {
        if (!c.mine && !c.revealed) return;
      }
      msGameOver = true;
      msStopTimer();
      msStatusEl.textContent = 'unlocked';
      msStatusEl.style.color = '#4dff7a';
      // Brief beat so the player sees the win state before the unlock fade.
      setTimeout(unlock, 700);
    }

    document.getElementById('ms-retry').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      msInit();
    });
    // Don't let right-click bring up the browser menu inside the grid.
    msGridEl.addEventListener('contextmenu', (e) => e.preventDefault());

    // ------- Video poker -------
    // Real 5-card draw mechanics — deal 5, hold any, redraw the rest. Only
    // a royal flush triggers unlock(); everything else (including a straight
    // flush) is labeled and the player has to deal again. Natural RF on the
    // deal alone is 1 in 649,740; with one redraw and optimal play it's
    // ~1 in 40,000. The impossibility is the joke.
    const PK_SUITS = ['♠', '♥', '♦', '♣'];
    const PK_RANK_NAMES = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const PK_RED = new Set(['♥', '♦']);

    const pkCardsEl  = document.getElementById('pk-cards');
    const pkStatusEl = document.getElementById('pk-status');
    const pkActionBtn = document.getElementById('pk-action');
    const pkCountEl  = document.getElementById('pk-count');

    let pkDeck = [];
    let pkHand = [];                    // [{rank, suit, value, held}]
    let pkPhase = 'fresh';              // 'fresh' (no hand) | 'held' (deal done, awaiting draw) | 'shown' (post-draw)
    let pkHandCount = 0;
    let pkCardEls = [];                 // stable per-slot element refs

    function pkBuildDeck() {
      const out = [];
      for (const s of PK_SUITS) {
        for (let v = 0; v < PK_RANK_NAMES.length; v++) {
          out.push({ rank: PK_RANK_NAMES[v], suit: s, value: v });
        }
      }
      return out;
    }
    function pkShuffle(deck) {
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      return deck;
    }

    function pkClassify(hand) {
      const ranks = hand.map(c => c.value).sort((a,b) => a - b);
      const suits = hand.map(c => c.suit);
      const counts = {};
      for (const v of ranks) counts[v] = (counts[v] || 0) + 1;
      const countVals = Object.values(counts).sort((a,b) => b - a);
      const flush = suits.every(s => s === suits[0]);
      let straight = false;
      if (new Set(ranks).size === 5) {
        if (ranks[4] - ranks[0] === 4) straight = true;
        // Wheel: A-2-3-4-5 (A treated as low).
        else if (ranks[0] === 0 && ranks[1] === 1 && ranks[2] === 2 && ranks[3] === 3 && ranks[4] === 12) straight = true;
      }
      // Royal: T(8) J(9) Q(10) K(11) A(12) all same suit.
      const royal = flush && ranks[0] === 8 && ranks[4] === 12;
      if (royal) return 'royal flush';
      if (flush && straight) return 'straight flush';
      if (countVals[0] === 4) return 'four of a kind';
      if (countVals[0] === 3 && countVals[1] === 2) return 'full house';
      if (flush) return 'flush';
      if (straight) return 'straight';
      if (countVals[0] === 3) return 'three of a kind';
      if (countVals[0] === 2 && countVals[1] === 2) return 'two pair';
      if (countVals[0] === 2) {
        const pairRank = +Object.keys(counts).find(k => counts[k] === 2);
        return pairRank >= 9 ? 'jacks or better' : 'low pair';   // J=9
      }
      return 'high card';
    }

    // Build the 5 card slot elements once and reuse them across deals/draws.
    // Stable elements let held cards stay put during a redraw while only the
    // replaced cards re-run the deal animation. Idempotent — safe to call
    // every reset; later calls are a no-op.
    function pkInitCardSlots() {
      if (pkCardEls.length) return;
      pkCardsEl.innerHTML = '';
      for (let i = 0; i < 5; i++) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'pk-card facedown';
        el.innerHTML = '<div class="pk-card-rank">?</div><div class="pk-card-suit">?</div>';
        // Closure over `i` so the handler always reads the current pkHand[i].
        el.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (pkPhase !== 'held') return;
          const c = pkHand[i];
          if (!c) return;
          c.held = !c.held;
          pkPaintCard(i);
        });
        pkCardsEl.appendChild(el);
        pkCardEls.push(el);
      }
    }

    // Repaint a single slot. If opts.staggerIndex is set, the slot also runs
    // the deal animation with a delay of (staggerIndex * 120ms).
    function pkPaintCard(i, opts) {
      const el = pkCardEls[i];
      if (!el) return;
      // Strip any in-flight animation state so re-triggering actually replays.
      el.classList.remove('pk-deal-anim');
      el.style.animationDelay = '';
      const card = pkHand[i];
      if (!card) {
        el.className = 'pk-card facedown';
        el.innerHTML = '<div class="pk-card-rank">?</div><div class="pk-card-suit">?</div>';
        return;
      }
      let cls = 'pk-card';
      if (PK_RED.has(card.suit)) cls += ' red';
      if (card.held)             cls += ' held';
      el.className = cls;
      el.innerHTML = `<div class="pk-card-rank">${card.rank}</div><div class="pk-card-suit">${card.suit}</div>`;
      if (card.held) {
        const tag = document.createElement('div');
        tag.className = 'pk-hold-label';
        tag.textContent = 'hold';
        el.appendChild(tag);
      }
      if (opts && opts.staggerIndex !== undefined) {
        // Force a reflow before adding the animation class so the keyframe
        // restarts from its "from" state.
        void el.offsetWidth;
        el.style.animationDelay = (opts.staggerIndex * 0.12) + 's';
        el.classList.add('pk-deal-anim');
      }
    }

    // Repaint all slots. If animateIndices is provided, those slots run the
    // deal animation in order (stagger 0, 1, 2, ...); other slots paint instantly.
    function pkPaintAll(animateIndices) {
      if (!animateIndices) {
        for (let i = 0; i < 5; i++) pkPaintCard(i);
        return;
      }
      let stagger = 0;
      for (let i = 0; i < 5; i++) {
        if (animateIndices.indexOf(i) !== -1) {
          pkPaintCard(i, { staggerIndex: stagger++ });
        } else {
          pkPaintCard(i);
        }
      }
    }

    // Indices of cards that make up the recognized scoring hand. Low pair
    // and high card are not paying hands in standard video poker, so they
    // return empty — only "scoring" cards get the winner outline.
    function pkWinningIndices(hand, result) {
      if (result === 'high card' || result === 'low pair') return [];
      // Hands that use all 5 cards.
      if (result === 'royal flush' || result === 'straight flush' ||
          result === 'straight'     || result === 'flush'          ||
          result === 'full house') {
        return [0, 1, 2, 3, 4];
      }
      // Group card indices by rank value so we can find the matching set(s).
      const byRank = {};
      hand.forEach((c, i) => {
        if (!byRank[c.value]) byRank[c.value] = [];
        byRank[c.value].push(i);
      });
      const groups = Object.values(byRank);
      if (result === 'four of a kind')  return groups.find(g => g.length === 4) || [];
      if (result === 'three of a kind') return groups.find(g => g.length === 3) || [];
      if (result === 'two pair')        return groups.filter(g => g.length === 2).flat();
      if (result === 'jacks or better') return groups.find(g => g.length === 2) || [];
      return [];
    }

    function pkReset() {
      pkInitCardSlots();
      pkDeck = pkShuffle(pkBuildDeck());
      pkHand = [];
      pkPhase = 'fresh';
      pkPaintAll();                                  // all slots face-down
      pkStatusEl.textContent = 'deal to begin';
      pkActionBtn.textContent = 'deal';
      pkActionBtn.disabled = false;
    }

    function pkDeal() {
      pkDeck = pkShuffle(pkBuildDeck());
      pkHand = pkDeck.splice(0, 5).map(c => ({ ...c, held: false }));
      pkPhase = 'held';
      pkPaintAll([0, 1, 2, 3, 4]);                   // all 5 deal in, staggered
      pkStatusEl.textContent = 'hold any · then draw';
      pkActionBtn.textContent = 'draw';
    }

    function pkDraw() {
      // Replace each non-held card from the top of the deck. Track which
      // indices got new cards so we can animate only those in.
      const replacedIndices = [];
      pkHand = pkHand.map((c, i) => {
        if (c.held) return c;
        replacedIndices.push(i);
        return { ...pkDeck.shift(), held: false };
      });
      pkHandCount++;
      pkCountEl.textContent = pkHandCount;
      const result = pkClassify(pkHand);
      pkPaintAll(replacedIndices);                   // held cards stay put
      pkPhase = 'shown';
      // Highlight the cards that make up the recognized scoring hand. The
      // class outlines green over the deal animation; the held outline (if
      // any) gets overridden by the source-order win.
      for (const i of pkWinningIndices(pkHand, result)) {
        pkCardEls[i].classList.add('pk-winner');
      }
      // Win bar: four of a kind or better (≈ 1 in 400 with optimal play).
      // Royal/straight flush still count — they're strictly better.
      if (result === 'royal flush' || result === 'straight flush' || result === 'four of a kind') {
        pkStatusEl.textContent = result + ' · unlocked';
        pkActionBtn.disabled = true;
        // Wait for the deal animation to land (5 cards × 120ms stagger +
        // 360ms anim = ~960ms worst case) plus a beat so the player reads
        // the win before the fade kicks in.
        setTimeout(unlock, 1400);
        return;
      }
      pkStatusEl.textContent = result + ' · not enough';
      pkActionBtn.textContent = 'deal again';
    }

    pkActionBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (pkPhase === 'held') pkDraw();
      else pkDeal();        // 'fresh' or 'shown' — deal a new hand
    });

    // Pay table modal: open/close. Backdrop click and Esc both close.
    const pkInfoBtn   = document.getElementById('pk-info-btn');
    const pkPaytable  = document.getElementById('pk-paytable');
    const pkPtCloseBtn = document.getElementById('pk-pt-close');
    function pkOpenPaytable(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      pkPaytable.classList.add('on');
      pkPaytable.setAttribute('aria-hidden', 'false');
    }
    function pkClosePaytable(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      pkPaytable.classList.remove('on');
      pkPaytable.setAttribute('aria-hidden', 'true');
    }
    pkInfoBtn.addEventListener('click', pkOpenPaytable);
    pkPtCloseBtn.addEventListener('click', pkClosePaytable);
    pkPaytable.addEventListener('click', (e) => {
      if (e.target === pkPaytable) pkClosePaytable(e);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pkPaytable.classList.contains('on')) pkClosePaytable(e);
    });

    // ------- 2048 -------
    // 4x4 slide-and-merge. Reach the 2048 tile to unlock. Standard rules:
    // each move slides all tiles toward the direction, adjacent equal pairs
    // merge into their sum, then a new tile (90% chance 2, 10% chance 4)
    // spawns at a random empty cell. Lose when the board is full and no
    // merges are possible.
    const TK_SIZE = 4;
    const TK_WIN  = 2048;

    const tkGridEl   = document.getElementById('tk-grid');
    const tkStatusEl = document.getElementById('tk-status');
    const tkScoreEl  = document.getElementById('tk-score');

    let tkBoard = [];           // TK_SIZE x TK_SIZE of numbers, 0 = empty
    let tkScore = 0;
    let tkGameOver = false;
    let tkWon = false;
    let tkCellEls = [];         // 2D array of cell elements, stable per slot

    function tkBuildGridOnce() {
      if (tkCellEls.length) return;
      tkGridEl.innerHTML = '';
      for (let r = 0; r < TK_SIZE; r++) {
        const row = [];
        for (let c = 0; c < TK_SIZE; c++) {
          const el = document.createElement('div');
          el.className = 'tk-cell';
          tkGridEl.appendChild(el);
          row.push(el);
        }
        tkCellEls.push(row);
      }
    }

    function tkSpawn() {
      const empty = [];
      for (let r = 0; r < TK_SIZE; r++) {
        for (let c = 0; c < TK_SIZE; c++) {
          if (tkBoard[r][c] === 0) empty.push([r, c]);
        }
      }
      if (empty.length === 0) return false;
      const [r, c] = empty[Math.floor(Math.random() * empty.length)];
      tkBoard[r][c] = Math.random() < 0.9 ? 2 : 4;
      return true;
    }

    function tkRender() {
      for (let r = 0; r < TK_SIZE; r++) {
        for (let c = 0; c < TK_SIZE; c++) {
          const v = tkBoard[r][c];
          const el = tkCellEls[r][c];
          el.textContent = v === 0 ? '' : v;
          el.className = 'tk-cell' + (v > 0 ? ' v-' + v : '');
        }
      }
      tkScoreEl.textContent = tkScore;
    }

    // Slide one row toward index 0, merging equal-adjacent pairs once.
    function tkSlideLeft(row) {
      const filtered = row.filter(x => x !== 0);
      const out = [];
      let i = 0;
      while (i < filtered.length) {
        if (i + 1 < filtered.length && filtered[i] === filtered[i + 1]) {
          const merged = filtered[i] * 2;
          out.push(merged);
          tkScore += merged;
          if (merged >= TK_WIN) tkWon = true;
          i += 2;
        } else {
          out.push(filtered[i]);
          i += 1;
        }
      }
      while (out.length < TK_SIZE) out.push(0);
      return out;
    }
    function tkTranspose(b) {
      return Array.from({length: TK_SIZE}, (_, r) =>
        Array.from({length: TK_SIZE}, (_, c) => b[c][r])
      );
    }
    function tkBoardsEqual(a, b) {
      for (let r = 0; r < TK_SIZE; r++) {
        for (let c = 0; c < TK_SIZE; c++) {
          if (a[r][c] !== b[r][c]) return false;
        }
      }
      return true;
    }
    function tkHasMoves() {
      for (let r = 0; r < TK_SIZE; r++) {
        for (let c = 0; c < TK_SIZE; c++) {
          if (tkBoard[r][c] === 0) return true;
          if (c + 1 < TK_SIZE && tkBoard[r][c] === tkBoard[r][c + 1]) return true;
          if (r + 1 < TK_SIZE && tkBoard[r][c] === tkBoard[r + 1][c]) return true;
        }
      }
      return false;
    }

    function tkMove(dir) {
      if (tkGameOver) return false;
      let next;
      if (dir === 'left') {
        next = tkBoard.map(row => tkSlideLeft(row));
      } else if (dir === 'right') {
        next = tkBoard.map(row => tkSlideLeft([...row].reverse()).reverse());
      } else if (dir === 'up') {
        next = tkTranspose(tkTranspose(tkBoard).map(row => tkSlideLeft(row)));
      } else if (dir === 'down') {
        next = tkTranspose(tkTranspose(tkBoard).map(row => tkSlideLeft([...row].reverse()).reverse()));
      } else {
        return false;
      }
      if (tkBoardsEqual(tkBoard, next)) return false;     // nothing actually moved
      tkBoard = next;
      tkSpawn();
      tkRender();
      if (tkWon) {
        tkGameOver = true;
        tkStatusEl.textContent = '2048 · unlocked';
        setTimeout(unlock, 1200);
        return true;
      }
      if (!tkHasMoves()) {
        tkGameOver = true;
        tkStatusEl.textContent = 'no moves · try again';
      }
      return true;
    }

    function tkInit() {
      tkBuildGridOnce();
      tkBoard = Array.from({length: TK_SIZE}, () => Array(TK_SIZE).fill(0));
      tkScore = 0;
      tkGameOver = false;
      tkWon = false;
      tkSpawn();
      tkSpawn();
      tkRender();
      tkStatusEl.textContent = 'reach 2048 to unlock';
    }

    // Keyboard: arrows + WASD. Only handle keys while the 2048 panel is open.
    document.addEventListener('keydown', (e) => {
      if (!document.body.classList.contains('tk-on')) return;
      if (document.body.classList.contains('unlocked')) return;
      const map = {
        ArrowUp:    'up',    ArrowDown:  'down', ArrowLeft:  'left', ArrowRight: 'right',
        w: 'up', W: 'up', s: 'down', S: 'down', a: 'left', A: 'left', d: 'right', D: 'right',
      };
      const dir = map[e.key];
      if (!dir) return;
      e.preventDefault();
      tkMove(dir);
    });

    // Swipe: touchstart/touchend → cardinal direction by dominant axis.
    let tkTouchStart = null;
    tkGridEl.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      tkTouchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });
    tkGridEl.addEventListener('touchend', (e) => {
      if (!tkTouchStart) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - tkTouchStart.x;
      const dy = t.clientY - tkTouchStart.y;
      tkTouchStart = null;
      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (Math.max(adx, ady) < 24) return;             // ignore tiny taps
      if (adx > ady) tkMove(dx > 0 ? 'right' : 'left');
      else           tkMove(dy > 0 ? 'down' : 'up');
    }, { passive: true });

    document.getElementById('tk-new').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      tkInit();
    });

    // ------- Bypass cycle: gate → minesweeper → poker → 2048 → gate -------
    // One "try another way" button on every screen advances to the next. The
    // cycle reads the current state from body classes so a single function
    // works for all four screens.
    function cycleBypass() {
      const body = document.body;
      msStopTimer();                                 // safe no-op if not running
      if (body.classList.contains('tk-on')) {
        body.classList.remove('tk-on');              // 2048 → gate (close all)
      } else if (body.classList.contains('poker-on')) {
        body.classList.remove('poker-on');           // poker → 2048
        body.classList.add('tk-on');
        tkInit();
      } else if (body.classList.contains('minesweeper-on')) {
        body.classList.remove('minesweeper-on');     // minesweeper → poker
        body.classList.add('poker-on');
        pkHandCount = 0;
        pkCountEl.textContent = pkHandCount;
        pkReset();
      } else {
        body.classList.add('minesweeper-on');        // gate → minesweeper
        msInit();
      }
    }
    document.querySelectorAll('.cycle-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        cycleBypass();
      });
    });

    // ------- DVD-bounce wordmark -------
    // Reveal the bouncing wordmark once all frames are decoded so it never
    // lands on a black screen. Hard cap so a slow network can't keep it dark.
    const brandBounce = document.querySelector('.brand-bounce');
    function revealBounce() {
      if (revealBounce.fired) return;
      revealBounce.fired = true;
      document.body.classList.add('brand-bounce-ready');
      startBounce();
    }
    allFramesPromise.then(revealBounce);
    setTimeout(revealBounce, 2000);

    const SPEED_X = 78;    // px/sec
    const SPEED_Y = 57;    // px/sec
    const DVD_COLORS = [
      '#ff4d4d', '#ff9933', '#ffea00',
      '#4dff7a', '#4de0ff', '#b366ff', '#ff66d4',
    ];
    let dvdColorIdx = 0;
    function nextBounceColor() {
      dvdColorIdx = (dvdColorIdx + 1) % DVD_COLORS.length;
      brandBounce.style.color = DVD_COLORS[dvdColorIdx];
    }

    let bx = 0, by = 0;
    let bdx = SPEED_X, bdy = SPEED_Y;
    let lastFrameMs = 0;

    function placeBounceStart() {
      const bw = brandBounce.offsetWidth, bh = brandBounce.offsetHeight;
      bx = Math.max(0, (window.innerWidth  - bw) / 2);
      by = Math.max(0, (window.innerHeight - bh) * 0.34);
      brandBounce.style.transform = `translate3d(${bx}px, ${by}px, 0)`;
    }
    function bounceTick(nowMs) {
      const dt = lastFrameMs ? Math.min((nowMs - lastFrameMs) / 1000, 0.05) : 0;
      lastFrameMs = nowMs;
      const bw = brandBounce.offsetWidth, bh = brandBounce.offsetHeight;
      const maxX = Math.max(0, window.innerWidth  - bw);
      const maxY = Math.max(0, window.innerHeight - bh);
      bx += bdx * dt;
      by += bdy * dt;
      if (bx <= 0)    { bx = 0;    bdx = Math.abs(bdx);  nextBounceColor(); }
      if (bx >= maxX) { bx = maxX; bdx = -Math.abs(bdx); nextBounceColor(); }
      if (by <= 0)    { by = 0;    bdy = Math.abs(bdy);  nextBounceColor(); }
      if (by >= maxY) { by = maxY; bdy = -Math.abs(bdy); nextBounceColor(); }
      brandBounce.style.transform = `translate3d(${bx}px, ${by}px, 0)`;
      requestAnimationFrame(bounceTick);
    }
    function startBounce() {
      placeBounceStart();
      brandBounce.style.color = DVD_COLORS[dvdColorIdx];
      lastFrameMs = 0;
      requestAnimationFrame(bounceTick);
    }
    window.addEventListener('resize', () => {
      const bw = brandBounce.offsetWidth, bh = brandBounce.offsetHeight;
      bx = Math.min(bx, Math.max(0, window.innerWidth  - bw));
      by = Math.min(by, Math.max(0, window.innerHeight - bh));
    });

    // ------- Debug overlay (?debug=1) -------
    if (new URLSearchParams(location.search).has('debug')) {
      document.body.classList.add('debug-on');
      const dbg = document.getElementById('debug');
      let lastErr = '—';

      ['error','stalled','abort'].forEach(ev => {
        [idleVid, scrubVid, endVid].forEach(v => v.addEventListener(ev, e => {
          lastErr = `${v.id}.${ev} (code=${v.error && v.error.code})`;
        }));
      });

      const fmt = v => `rs=${v.readyState} dur=${isFinite(v.duration)?v.duration.toFixed(2):'?'} t=${v.currentTime.toFixed(2)} paused=${v.paused}`;

      const vhsStatus = () => {
        const loaded = vhsFrames.filter(im => im.complete && im.naturalWidth > 0).length;
        return `frame_${String(vhsActive + 1).padStart(2,'0')} loaded=${loaded}/${vhsFrames.length}`;
      };

      function paint() {
        const paused = document.body.classList.contains('paused-at-checkpoint');
        dbg.innerHTML =
          `<b>state</b> ${state} | <b>primed</b> ${primed} | <b>paused-cp</b> ${paused}<br>` +
          `<b>checkpoints</b> [${CHECKPOINTS.join(', ')}] | <b>next</b> ${nextCheckpointIdx}<br>` +
          `<b>idle </b> ${fmt(idleVid)}<br>` +
          `<b>scrub</b> ${fmt(scrubVid)}<br>` +
          `<b>end  </b> ${fmt(endVid)}<br>` +
          `<b>vhs  </b> ${vhsStatus()}<br>` +
          `<b>err</b> ${lastErr} | <b>vh</b> ${window.innerHeight}`;
        requestAnimationFrame(paint);
      }
      paint();
    }

    // ---- VCR menu (end state) ----
    // Three action types per row:
    //   `open`     → window.open(data-url) in a new tab; "#" or missing falls
    //                through to a "NO SIGNAL" overlay.
    //   `static`   → full-screen visible static for ~1.6s.
    //   `tracking` → "TRACKING ERROR" shake overlay for ~1.4s.
    // Keyboard (↑↓/Enter) and pointer (hover/click/tap) drive the same selector.
    const menuEl    = document.getElementById('menu');
    const menuItems = Array.from(menuEl.querySelectorAll('.menu-item'));
    let menuIndex = 0;

    function setMenuIndex(i) {
      menuIndex = (i + menuItems.length) % menuItems.length;
      menuItems.forEach((el, idx) =>
        el.classList.toggle('selected', idx === menuIndex)
      );
      // Menu can now scroll on short viewports (15 channels). Keep the selected
      // item visible without ever scroll-anchoring the page.
      const sel = menuItems[menuIndex];
      if (sel && typeof sel.scrollIntoView === 'function') {
        sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }

    document.addEventListener('keydown', (e) => {
      // Only intercept arrow/enter once we're in the ended state — pre-end the
      // start button + scrub video own the surface.
      if (document.body.dataset.state !== 'ended') return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        setMenuIndex(menuIndex + 1);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setMenuIndex(menuIndex - 1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        triggerMenuItem(menuItems[menuIndex]);
      }
    });

    // Don't let `mouseenter` snap the selector to wherever the cursor happened
    // to be when the menu faded in. Only follow the cursor after a real move.
    let menuMouseHasMoved = false;
    document.addEventListener('mousemove', () => { menuMouseHasMoved = true; }, { once: true });

    menuItems.forEach((el, idx) => {
      el.addEventListener('mouseenter', () => {
        if (!menuMouseHasMoved) return;
        setMenuIndex(idx);
      });
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenuIndex(idx);
        triggerMenuItem(el);
      });
    });

    // Dispatcher — small action table keyed off `data-action` so adding more
    // text-only channels later is a one-line HTML change.
    const ACTIONS = {
      open: (el) => {
        const url = el.dataset.url;
        if (url && url !== '#') window.open(url, '_blank', 'noopener');
        else                    showFxText('no signal', 1200);
      },
      static:    ()   => showFxStatic(1600),
      tracking:  ()   => showFxText('tracking error', 1400),
      text:      (el) => {
        const ms = +el.dataset.ms || 1400;
        showFxText(el.dataset.text || '', ms, el.dataset.color);
        // Optional audio cue keyed off `data-tone`.
        const tone = el.dataset.tone;
        if (tone === 'rewind')   playRewindWhoosh();
        else if (tone === 'ffwd') playFfwdChirp();
      },
      colorbars: () => showFxColorBars(2000),
      deadair:   () => showFxDeadAir(3000),
      poweroff:  () => showFxPowerOff(),
    };

    function triggerMenuItem(el) {
      const handler = ACTIONS[el.dataset.action];
      if (handler) handler(el);
    }

    const fxStaticEl     = document.getElementById('fx-static');
    const fxStaticImgEl  = fxStaticEl.querySelector('.fx-static-frame');
    const fxTextEl       = document.getElementById('fx-text');
    const fxColorBarsEl  = document.getElementById('fx-colorbars');
    const fxDeadAirEl    = document.getElementById('fx-deadair');
    const fxPowerOffEl   = document.getElementById('fx-poweroff');

    function showFxStatic(ms) {
      const frames = ['vhs_frames/frame_01.jpg', 'vhs_frames/frame_02.jpg'];
      let i = 0;
      fxStaticImgEl.src = frames[0];
      fxStaticEl.classList.add('on');
      const id = setInterval(() => {
        i = (i + 1) % frames.length;
        fxStaticImgEl.src = frames[i];
      }, 80);
      setTimeout(() => {
        clearInterval(id);
        fxStaticEl.classList.remove('on');
      }, ms);
    }

    function showFxText(text, ms, color) {
      fxTextEl.textContent = text;
      // Reset any previous color modifier before applying the new one.
      fxTextEl.classList.remove('red');
      if (color) fxTextEl.classList.add(color);
      fxTextEl.classList.add('on');
      setTimeout(() => {
        fxTextEl.classList.remove('on');
        // Drop the color modifier on exit so the next text overlay starts clean.
        if (color) fxTextEl.classList.remove(color);
      }, ms);
    }

    function showFxColorBars(ms) {
      fxColorBarsEl.classList.add('on');
      // Tone fires once per trigger. ~0.8s pip so the bars sit slightly silent
      // before they vanish — feels less like a buzzer, more like a test card.
      playTone(1000, 800, 'sine', 0.06);
      setTimeout(() => fxColorBarsEl.classList.remove('on'), ms);
    }

    function showFxDeadAir(ms) {
      fxDeadAirEl.classList.add('on');
      setTimeout(() => fxDeadAirEl.classList.remove('on'), ms);
    }

    function showFxPowerOff() {
      // Two-stage animation. Stage 1: paint the black backdrop instantly and
      // start the line collapse keyframe. Stage 2 (after the animation): drop
      // .on so the whole overlay fades out and the menu returns.
      fxPowerOffEl.classList.add('on');
      // Restart the keyframe in case the channel is fired repeatedly.
      fxPowerOffEl.classList.remove('collapse');
      // Force reflow so the next class add re-triggers the animation.
      void fxPowerOffEl.offsetWidth;
      fxPowerOffEl.classList.add('collapse');
      // CSS animation runs 0.7s; hold the black ~1.0s, then fade out.
      setTimeout(() => {
        fxPowerOffEl.classList.remove('on', 'collapse');
      }, 1700);
    }

    // ------- FX audio cues -------
    // Reuse the AudioContext spun up for the unlock chime if present; otherwise
    // lazy-create one here so the FX channels work even if the user gets to the
    // menu via the start button without a prior chime fire.
    function getFxAudioCtx() {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        if (!unlockAudioCtx) unlockAudioCtx = new Ctx();
        if (unlockAudioCtx.state === 'suspended') {
          unlockAudioCtx.resume().catch(() => {});
        }
        return unlockAudioCtx;
      } catch (_) { return null; }
    }

    // Single tone with a short attack/decay envelope. Respects the mute toggle.
    function playTone(freq, ms, type = 'sine', peak = 0.08) {
      if (bgAudio.muted) return;
      const ctx = getFxAudioCtx();
      if (!ctx) return;
      try {
        const t0 = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(peak, t0 + 0.012);
        gain.gain.linearRampToValueAtTime(peak, t0 + ms / 1000 - 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + ms / 1000 + 0.02);
      } catch (_) {}
    }

    // Rewind whoosh — pitch falls from ~900Hz to ~150Hz over the duration, with
    // a parallel band of high-frequency noise (white noise gated low) so it feels
    // like tape spinning, not just a tone.
    function playRewindWhoosh() {
      if (bgAudio.muted) return;
      const ctx = getFxAudioCtx();
      if (!ctx) return;
      try {
        const t0  = ctx.currentTime;
        const dur = 1.0;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(900, t0);
        osc.frequency.exponentialRampToValueAtTime(150, t0 + dur);
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.05, t0 + 0.04);
        gain.gain.linearRampToValueAtTime(0.05, t0 + dur - 0.08);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
      } catch (_) {}
    }

    // Fast-fwd chirp — same shape as rewind, but rising. Sounds like a tape
    // shuttling forward.
    function playFfwdChirp() {
      if (bgAudio.muted) return;
      const ctx = getFxAudioCtx();
      if (!ctx) return;
      try {
        const t0  = ctx.currentTime;
        const dur = 1.0;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(180, t0);
        osc.frequency.exponentialRampToValueAtTime(1100, t0 + dur);
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.05, t0 + 0.04);
        gain.gain.linearRampToValueAtTime(0.05, t0 + dur - 0.08);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
      } catch (_) {}
    }
