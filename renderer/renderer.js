// Renderer — v5 redesign
//  - Circular avatar with halo + ring animations driven by speaking state
//  - Settings: connection + voice (Edge / Kokoro) + render (resolution + fps) + persona
//  - Real MetaHuman lipsync via baked MP4s

const chat = document.getElementById('chat');
const hint = document.getElementById('hint');
const input = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const statusEl = document.getElementById('status');
const dotEl = document.getElementById('dot');
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const closeSettings = document.getElementById('closeSettings');
const saveSettingsBtn = document.getElementById('saveSettings');
const mavisVideo = document.getElementById('mavisVideo');
const avatarWrap = document.getElementById('avatarWrap');
// AVSpeech avatar surface — image + SVG mouth overlay, hidden until that
// engine is selected. Audio is held in a separate <audio> element so we can
// drive Web Audio FFT off it without losing native playback controls.
const avspeechPortrait = document.getElementById('avspeechPortrait');
const mouthSvg = document.getElementById('mouthSvg');
const mouthPath = document.getElementById('mouthPath');
const avspeechAudio = document.getElementById('avspeechAudio');

const apiKeyInput = document.getElementById('apiKey');
const modelInput = document.getElementById('model');
const voiceSelect = document.getElementById('voice');
const voiceLabel = document.getElementById('voiceLabel');
const ttsEngineSelect = document.getElementById('ttsEngine');
const sttEngineSelect = document.getElementById('sttEngine');
const avatarEngineSelect = document.getElementById('avatarEngine');
const resolutionSelect = document.getElementById('resolution');
const fpsSelect = document.getElementById('fps');
const systemPromptInput = document.getElementById('systemPrompt');
const xaiAccountState = document.getElementById('xaiAccountState');
const xaiSignInBtn = document.getElementById('xaiSignInBtn');
const micBtn = document.getElementById('micBtn');
// Avatar image picker elements (preview thumb + pick/reset + mouth position sliders).
const avatarPreview = document.getElementById('avatarPreview');
const avatarPickBtn = document.getElementById('avatarPickBtn');
const avatarResetBtn = document.getElementById('avatarResetBtn');
const avatarPathLabel = document.getElementById('avatarPathLabel');
const mouthXInput = document.getElementById('mouthX');
const mouthYInput = document.getElementById('mouthY');
const mouthXVal = document.getElementById('mouthXVal');
const mouthYVal = document.getElementById('mouthYVal');

const history = [];
const HISTORY_LIMIT = 20;
let sending = false;

const EDGE_VOICES = [
  ['en-US-AvaMultilingualNeural', 'Ava (warm, Copilot-style) — default'],
  ['en-US-EmmaMultilingualNeural', 'Emma (multilingual)'],
  ['en-US-AriaNeural', 'Aria (novel/narration)'],
  ['en-US-JennyNeural', 'Jenny (friendly)'],
  ['en-US-MichelleNeural', 'Michelle (calm)'],
  ['en-US-AnaNeural', 'Ana (young, conversational)'],
];
const KOKORO_VOICES = [
  ['af_heart', 'Heart (warm female) — default'],
  ['af_nova', 'Nova (bright female)'],
  ['af_sky', 'Sky (energetic female)'],
  ['bf_emma', 'Emma (British female)'],
  ['bf_isabella', 'Isabella (British female)'],
  ['am_adam', 'Adam (neutral male)'],
  ['am_michael', 'Michael (authoritative male)'],
  ['bm_george', 'George (British male)'],
];
const XAI_VOICES = [
  ['ara', 'Ara (warm, friendly) — default'],
  ['eve', 'Eve (energetic, upbeat)'],
  ['rex', 'Rex (confident, clear)'],
  ['sal', 'Sal (smooth, balanced)'],
  ['leo', 'Leo (authoritative, strong)'],
];

// ---------- Avatar state machine ----------
const IDLE_POSTER = 'assets/mavis_idle.jpg';
mavisVideo.addEventListener('ended', () => goIdle());
mavisVideo.addEventListener('error', () => {
  const err = mavisVideo.error;
  const code = err?.code, msg = err?.message || '';
  console.error('[mavis] video error', code, msg, mavisVideo.currentSrc);
  addError(`Video playback error (${code}): ${msg || 'could not load baked MP4'}`);
  goIdle();
});
if (avspeechAudio) {
  avspeechAudio.addEventListener('ended', () => goIdle());
  avspeechAudio.addEventListener('error', () => {
    addError('AVSpeech audio failed to play.'); goIdle();
  });
}
// Switch the avatar wrap into the right rendering mode so only the active
// engine's DOM is visible. Keeps the avatar slot the exact same size whichever
// engine is driving it.
function setAvatarMode(mode /* 'video' | 'avspeech' */) {
  if (!avatarWrap) return;
  avatarWrap.classList.toggle('mode-video', mode === 'video');
  avatarWrap.classList.toggle('mode-avspeech', mode === 'avspeech');
}

function setSpeaking(on) {
  avatarWrap.classList.toggle('speaking', !!on);
}
function setDot(state) {
  dotEl.classList.remove('live', 'speaking', 'thinking');
  if (state === 'speaking') dotEl.classList.add('speaking');
  else if (state === 'thinking' || state === 'preparing') dotEl.classList.add('thinking');
  else if (state === 'idle') dotEl.classList.add('live');
}

function goIdle() {
  setDot('idle');
  setSpeaking(false);
  try {
    mavisVideo.pause();
    mavisVideo.removeAttribute('src');
    mavisVideo.load();
    mavisVideo.poster = IDLE_POSTER;
  } catch {}
  try {
    if (avspeechAudio) { avspeechAudio.pause(); avspeechAudio.removeAttribute('src'); avspeechAudio.load(); }
  } catch {}
  stopAvSpeechAnim();
  // Default visible surface when idle is the video poster — cheaper than the
  // big portrait and consistent with the chat's existing visual rhythm.
  setAvatarMode('video');
  refreshStatus();
}

// Reveal text in sync with the audio so it lands like she is actually saying it.
// Streams characters across roughly the audio duration (with a tiny lead so
// the text finishes just before her mouth stops moving).
function streamText(div, fullText, durationSec) {
  return new Promise((resolve) => {
    const chars = [...fullText];
    if (!chars.length || durationSec <= 0) {
      div.textContent = fullText; resolve(); return;
    }
    const delay = Math.max(8, (durationSec * 1000) / chars.length);
    let i = 0;
    function tick() {
      if (i >= chars.length) { resolve(); return; }
      // Add 1-3 chars per tick to feel natural (CJK should still stream, but
      // English benefits from slightly chunkier ticks so the reveal isn't too tickery).
      const step = chars[i] && chars[i].charCodeAt(0) > 0x3000 ? 1 : 2;
      div.textContent += chars.slice(i, i + step).join('');
      i += step;
      chat.scrollTop = chat.scrollHeight;
      setTimeout(tick, delay);
    }
    tick();
  });
}

// Plays the baked MP4 AND reveals the reply text in sync with it.
// Used by both 'unreal' and 'musetalk' avatar engines — they both produce MP4.
// Text bubble is created at play() success — not before — so the user never
// sees a transcript without a face.
function playBaked(mp4Url, replyText) {
  setAvatarMode('video');
  setDot('speaking');
  setSpeaking(true);
  statusEl.textContent = 'speaking\u2026';
  try {
    mavisVideo.muted = false;
    mavisVideo.loop = false;
    const cacheBust = `${mp4Url}${mp4Url.includes('?') ? '&' : '?'}t=${Date.now()}`;
    mavisVideo.src = cacheBust;
    mavisVideo.load();
    const onReady = () => {
      mavisVideo.removeEventListener('canplay', onReady);
      mavisVideo.play().then(() => {
        // Reveal the bubble at the moment audio starts.
        const div = addMessage('mavis', '');
        const duration = (mavisVideo.duration && isFinite(mavisVideo.duration))
          ? mavisVideo.duration
          : Math.max(2, replyText.length * 0.06);
        streamText(div, replyText, duration * 0.88);
      }).catch((e) => {
        console.warn('[mavis] play() rejected', e);
        addMessage('mavis', replyText); // fallback so user still sees the reply
        addError(`Autoplay blocked: ${e.message || e}`);
        goIdle();
      });
    };
    mavisVideo.addEventListener('canplay', onReady, { once: true });
  } catch (e) { console.warn(e); addMessage('mavis', replyText); goIdle(); }
}

// ---------- AVSpeech avatar (Mavis portrait + Web-Audio formant-driven mouth) ----------
// Renders the canonical Mavis hero portrait, with a small SVG mouth-shape
// laid over the lips. While the WAV plays, an AnalyserNode pulls per-frame
// FFT bands and converts them into three viseme weights:
//   jawOpen   <- F1 energy (300–900 Hz)  : open vowels (æ ɑ ʌ) push high
//   lipSpread <- F2 energy (1000–2500 Hz): front vowels (i e) push wide
//   teethHF   <- HF energy (3000–8000 Hz): sibilants (s sh f) flash teeth
// These three weights drive an SVG <path> that morphs from closed lips to open
// mouth in real time, so visemes are real (not amplitude-only) without any
// alignment pass.
let avAudioCtx = null;
let avSourceNode = null;
let avAnalyser = null;
let avFreqBuf = null;
let avAnimRaf = 0;
let avLastEl = null;
function stopAvSpeechAnim() {
  if (avAnimRaf) { cancelAnimationFrame(avAnimRaf); avAnimRaf = 0; }
  if (mouthPath) mouthPath.setAttribute('d', closedMouthPath());
  if (mouthSvg) mouthSvg.style.opacity = '0';
}
// Apply the user-tuned mouth position to the SVG overlay. Called whenever
// settings are loaded or the user drags the X/Y sliders — keeps the mouth
// SVG sitting on top of the actual lips in whatever portrait is loaded.
function applyMouthPosition(xPct, yPct) {
  if (!mouthSvg) return;
  const x = Math.max(0, Math.min(100, Number(xPct) || 50));
  const y = Math.max(0, Math.min(100, Number(yPct) || 67));
  mouthSvg.style.left = `${x}%`;
  mouthSvg.style.top  = `${y}%`;
}
// Swap the portrait <img> source. Lazy-loaded on first AVSpeech reply or when
// the user picks a new avatar.
function applyAvatarImage(url) {
  if (!url || !avspeechPortrait) return;
  // Cache-bust so the file:// URL re-fetches after a user picks a new image
  // with the same filename (rare, but cheap insurance).
  const cacheBust = `${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`;
  avspeechPortrait.src = cacheBust;
}
// Mouth coords are in the SVG's own 100x60 viewBox, centered horizontally,
// upper baseline at y=24. closedMouthPath() draws the resting lip seam; the
// dynamic version expands it on jawOpen and stretches/contracts on lipSpread.
function closedMouthPath() {
  return 'M 18 30 Q 50 28 82 30 Q 50 32 18 30 Z';
}
function visemeMouthPath(jawOpen, lipSpread, teethHF) {
  // Width swing: +18% on full spread, -10% on full round (we infer round when
  // lipSpread is low AND jawOpen is non-trivial).
  const round = Math.max(0, jawOpen * (1 - lipSpread));
  const halfW = 32 + lipSpread * 12 - round * 9;            // 23..44 px
  const cx = 50;
  const topY = 30 - jawOpen * 7 + teethHF * 1.5;            // upper lip raises
  const botY = 30 + jawOpen * 12 + round * 2;               // lower lip drops
  const midSag = Math.min(jawOpen * 4, 4);                  // slight curve in the middle
  const x1 = cx - halfW, x2 = cx + halfW;
  // Two-cubic mouth: top curve, then bottom curve back. With teethHF > 0.3 we
  // bisect with a thin highlight to suggest teeth.
  let d = `M ${x1} 30 Q ${cx} ${topY - midSag} ${x2} 30 Q ${cx} ${botY + midSag} ${x1} 30 Z`;
  if (teethHF > 0.32 && jawOpen > 0.18) {
    const teethY = 30 - jawOpen * 1.2;
    d += ` M ${cx - halfW * 0.7} ${teethY} L ${cx + halfW * 0.7} ${teethY}`;
  }
  return d;
}
function playAvSpeech(audioUrl, portraitUrl, replyText) {
  setAvatarMode('avspeech');
  setDot('speaking');
  setSpeaking(true);
  statusEl.textContent = 'speaking\u2026';
  // Hot-swap portrait if the bake returned a different URL than what's loaded.
  if (avspeechPortrait && portraitUrl) {
    // Strip cache-bust query when comparing so we don't reload on every reply.
    const cur = (avspeechPortrait.src || '').split('?')[0];
    if (cur !== portraitUrl) applyAvatarImage(portraitUrl);
  }
  try {
    avspeechAudio.muted = false;
    const cacheBust = `${audioUrl}${audioUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
    avspeechAudio.src = cacheBust;
    avspeechAudio.load();
    const onReady = () => {
      avspeechAudio.removeEventListener('canplay', onReady);
      // Web Audio plumbing — lazily create AudioContext (browser policy: needs
      // a user gesture, which the send-button click counts as).
      try {
        if (!avAudioCtx) avAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (avSourceNode && avLastEl === avspeechAudio) {
          // Reuse the existing MediaElementSource so we don't hit the
          // "HTMLMediaElement already connected" InvalidStateError.
        } else {
          avSourceNode = avAudioCtx.createMediaElementSource(avspeechAudio);
          avAnalyser = avAudioCtx.createAnalyser();
          avAnalyser.fftSize = 2048;            // ~23ms window at 48kHz — plenty for formant tracking
          avAnalyser.smoothingTimeConstant = 0.5;
          avSourceNode.connect(avAnalyser);
          avAnalyser.connect(avAudioCtx.destination);
          avFreqBuf = new Uint8Array(avAnalyser.frequencyBinCount);
          avLastEl = avspeechAudio;
        }
        if (avAudioCtx.state === 'suspended') avAudioCtx.resume();
      } catch (e) { console.warn('[mavis] web audio init failed', e); }

      avspeechAudio.play().then(() => {
        const div = addMessage('mavis', '');
        const duration = (avspeechAudio.duration && isFinite(avspeechAudio.duration))
          ? avspeechAudio.duration
          : Math.max(2, replyText.length * 0.06);
        streamText(div, replyText, duration * 0.88);
        // Start the formant-driven mouth animation loop.
        if (mouthSvg) mouthSvg.style.opacity = '1';
        const sr = avAudioCtx ? avAudioCtx.sampleRate : 48000;
        const binHz = sr / avAnalyser.fftSize;
        // Pre-compute the FFT bin ranges for the three formant bands.
        const idx = (hz) => Math.max(0, Math.min(avAnalyser.frequencyBinCount - 1, Math.round(hz / binHz)));
        const f1Lo = idx(300),  f1Hi = idx(900);
        const f2Lo = idx(1000), f2Hi = idx(2500);
        const hfLo = idx(3000), hfHi = idx(8000);
        const noiseFloor = 18; // u8 — below this we treat as silence (mouth closed)
        let jOpen = 0, lSpread = 0, hfE = 0;
        const tick = () => {
          if (avspeechAudio.paused || avspeechAudio.ended) {
            stopAvSpeechAnim();
            return;
          }
          avAnalyser.getByteFrequencyData(avFreqBuf);
          // Mean amplitude in each band.
          let f1 = 0; for (let i = f1Lo; i <= f1Hi; i++) f1 += avFreqBuf[i]; f1 /= (f1Hi - f1Lo + 1);
          let f2 = 0; for (let i = f2Lo; i <= f2Hi; i++) f2 += avFreqBuf[i]; f2 /= (f2Hi - f2Lo + 1);
          let hf = 0; for (let i = hfLo; i <= hfHi; i++) hf += avFreqBuf[i]; hf /= (hfHi - hfLo + 1);
          // Silence gate.
          if (f1 < noiseFloor && f2 < noiseFloor && hf < noiseFloor) { f1 = f2 = hf = 0; }
          // Normalize to 0..1 and gently saturate.
          const j = Math.min(1, Math.max(0, (f1 - noiseFloor) / 110));
          const s = Math.min(1, Math.max(0, (f2 - noiseFloor) / 120));
          const h = Math.min(1, Math.max(0, (hf - noiseFloor) / 95));
          // Easing so the mouth motion stays organic (not strobing every frame).
          jOpen   += (j - jOpen)   * 0.45;
          lSpread += (s - lSpread) * 0.40;
          hfE     += (h - hfE)     * 0.55;
          if (mouthPath) mouthPath.setAttribute('d', visemeMouthPath(jOpen, lSpread, hfE));
          avAnimRaf = requestAnimationFrame(tick);
        };
        avAnimRaf = requestAnimationFrame(tick);
      }).catch((e) => {
        console.warn('[mavis] avspeech play() rejected', e);
        addMessage('mavis', replyText);
        addError(`Autoplay blocked: ${e.message || e}`);
        goIdle();
      });
    };
    avspeechAudio.addEventListener('canplay', onReady, { once: true });
  } catch (e) { console.warn(e); addMessage('mavis', replyText); goIdle(); }
}

// ---------- Status ----------
function shortLabel(s) {
  let voicePart;
  if (s.ttsEngine === 'kokoro') voicePart = `Kokoro`;
  else if (s.ttsEngine === 'xai') voicePart = `xAI \u00b7 ${s.voice}`;
  else voicePart = s.voice.replace('en-US-', '').replace('Neural', '').replace('Multilingual', '');
  // Tag the avatar engine when it's not the default UE bake.
  const av = s.avatarEngine === 'avspeech' ? ' \u00b7 AVSpeech'
          : s.avatarEngine === 'musetalk' ? ' \u00b7 MuseTalk'
          : '';
  return `${s.model} \u00b7 ${voicePart}${av}`;
}
async function refreshStatus() {
  const s = await window.mavis.getSettings();
  if (s.hasKey) {
    statusEl.textContent = shortLabel(s);
    setDot('idle');
  } else {
    statusEl.textContent = 'no API key';
    dotEl.classList.remove('live', 'speaking', 'thinking');
  }
  // Keep the avatar surface in sync with persisted settings on every status
  // refresh — covers the boot path and post-save UI consistency.
  if (s.avatarImageUrl) applyAvatarImage(s.avatarImageUrl);
  applyMouthPosition(s.avatarMouthX, s.avatarMouthY);
  return s;
}

// ---------- Chat UI ----------
function addMessage(role, text) {
  if (hint && hint.parentNode) hint.remove();
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}
function addError(text) {
  const div = document.createElement('div');
  div.className = 'msg error';
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}
function addTyping(label) {
  const div = document.createElement('div');
  div.className = 'typing';
  div.textContent = label;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

async function send() {
  if (sending) return;
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  autoresize();
  addMessage('user', text);

  sending = true;
  sendBtn.disabled = true;
  let typing = addTyping('Mavis is thinking\u2026');
  setDot('thinking');
  statusEl.textContent = 'thinking\u2026';

  try {
    const trimmed = history.slice(-HISTORY_LIMIT * 2);
    const { reply } = await window.mavis.sendChat({ history: trimmed, userMessage: text });
    // Don't show the reply text yet — wait for the video to start so text + voice land together.
    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: reply });

    // Keep the same 'thinking' indicator during the bake — no second 'preparing her face' message.
    try {
      const baked = await window.mavis.bakeReply(reply);
      typing.remove();
      if (baked?.cached) console.log('[mavis] cache hit', baked.mp4Path || baked.audioPath);
      if (baked?.kind === 'avspeech') {
        const audioUrl = baked.audioUrl || (baked.audioPath ? `file://${encodeURI(baked.audioPath)}` : null);
        const portraitUrl = baked.portraitUrl || 'assets/portrait.jpg';
        if (audioUrl) playAvSpeech(audioUrl, portraitUrl, reply);
        else { addMessage('mavis', reply); goIdle(); }
      } else if (baked?.kind === 'mp4') {
        const url = baked.mp4Url || (baked.mp4Path ? `file://${encodeURI(baked.mp4Path)}` : null);
        if (url) playBaked(url, reply);
        else { addMessage('mavis', reply); goIdle(); }
      } else {
        // No avatar payload (empty reply or 'none'). Still show the text.
        addMessage('mavis', reply);
        goIdle();
      }
    } catch (bakeErr) {
      typing.remove();
      console.warn('bake failed', bakeErr);
      // Bake failed but we have the text — don't strand the user.
      addMessage('mavis', reply);
      addError(`Lipsync bake failed: ${bakeErr.message || bakeErr}`);
      goIdle();
    }
  } catch (err) {
    typing.remove();
    goIdle();
    addError(err.message || String(err));
  } finally {
    sending = false;
    sendBtn.disabled = false;
    input.focus();
  }
}

// ---------- Settings ----------
function voicesFor(engine) {
  if (engine === 'kokoro') return KOKORO_VOICES;
  if (engine === 'xai') return XAI_VOICES;
  return EDGE_VOICES;
}
function populateVoiceList(engine, current) {
  const voices = voicesFor(engine);
  voiceSelect.innerHTML = '';
  voices.forEach(([val, label]) => {
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = label;
    voiceSelect.appendChild(opt);
  });
  // Try to preserve selection across engine switch when possible.
  const match = voices.find(([v]) => v === current);
  voiceSelect.value = match ? current : voices[0][0];
}
function populateResolutionList(resolutions, current) {
  resolutionSelect.innerHTML = '';
  resolutions.forEach(({ key, label }) => {
    const opt = document.createElement('option');
    opt.value = key; opt.textContent = label;
    resolutionSelect.appendChild(opt);
  });
  resolutionSelect.value = current || 'standard';
}
async function openSettings() {
  const [s, opts] = await Promise.all([window.mavis.getSettings(), window.mavis.getOptions()]);
  apiKeyInput.value = s.apiKey || '';
  modelInput.value = s.model || 'gpt-5-mini';
  ttsEngineSelect.value = s.ttsEngine || 'edge';
  populateVoiceList(ttsEngineSelect.value, s.voice);
  populateResolutionList(opts.resolutions || [], s.resolution);
  fpsSelect.value = String(s.fps || 24);
  if (sttEngineSelect) sttEngineSelect.value = s.sttEngine || 'off';
  if (avatarEngineSelect) avatarEngineSelect.value = s.avatarEngine || 'unreal';
  // Avatar image — thumbnail, path label, mouth-position sliders.
  if (avatarPreview && s.avatarImageUrl) avatarPreview.src = s.avatarImageUrl;
  if (avatarPathLabel) {
    avatarPathLabel.textContent = s.avatarImage
      ? s.avatarImage.replace(/^.*\//, '')
      : 'Default (bundled face capture)';
  }
  if (mouthXInput) { mouthXInput.value = String(s.avatarMouthX ?? 50); if (mouthXVal) mouthXVal.textContent = mouthXInput.value + '%'; }
  if (mouthYInput) { mouthYInput.value = String(s.avatarMouthY ?? 67); if (mouthYVal) mouthYVal.textContent = mouthYInput.value + '%'; }
  systemPromptInput.value = s.systemPrompt || '';
  settingsModal.classList.remove('hidden');
  refreshXaiAccount();
  setTimeout(() => apiKeyInput.focus(), 50);
}
// Mouth-position sliders — update both the live SVG and the displayed % value
// as the user drags. We persist the values on Save, not on every input event,
// so cancelling the modal still leaves the persisted settings intact.
if (mouthXInput) {
  mouthXInput.addEventListener('input', () => {
    if (mouthXVal) mouthXVal.textContent = mouthXInput.value + '%';
    setAvatarMode('avspeech');                            // make the SVG visible so the user can see the move
    if (mouthSvg) mouthSvg.style.opacity = '1';
    applyMouthPosition(mouthXInput.value, mouthYInput ? mouthYInput.value : 67);
  });
}
if (mouthYInput) {
  mouthYInput.addEventListener('input', () => {
    if (mouthYVal) mouthYVal.textContent = mouthYInput.value + '%';
    setAvatarMode('avspeech');
    if (mouthSvg) mouthSvg.style.opacity = '1';
    applyMouthPosition(mouthXInput ? mouthXInput.value : 50, mouthYInput.value);
  });
}
// Avatar pick / reset — wired to the native file dialog in main.js.
if (avatarPickBtn) {
  avatarPickBtn.addEventListener('click', async () => {
    avatarPickBtn.disabled = true;
    avatarPickBtn.textContent = 'Picking\u2026';
    try {
      const r = await window.mavis.pickAvatar();
      if (r.ok) {
        if (avatarPreview) avatarPreview.src = r.avatarImageUrl;
        applyAvatarImage(r.avatarImageUrl);
        if (avatarPathLabel) avatarPathLabel.textContent = (r.avatarImage || '').replace(/^.*\//, '');
      }
    } finally {
      avatarPickBtn.disabled = false;
      avatarPickBtn.textContent = 'Change\u2026';
    }
  });
}
if (avatarResetBtn) {
  avatarResetBtn.addEventListener('click', async () => {
    const r = await window.mavis.resetAvatar();
    if (r.ok) {
      if (avatarPreview) avatarPreview.src = r.avatarImageUrl;
      applyAvatarImage(r.avatarImageUrl);
      if (avatarPathLabel) avatarPathLabel.textContent = 'Default (bundled face capture)';
    }
  });
}

// ---------- xAI OAuth2 account chip ----------
async function refreshXaiAccount() {
  if (!xaiAccountState) return;
  xaiAccountState.textContent = 'Checking\u2026';
  xaiAccountState.className = 'xai-account-state';
  try {
    const r = await window.mavis.getXaiAccount();
    if (!r.ok) {
      xaiAccountState.textContent = `Couldn't reach Enconvo: ${r.error || 'unknown error'}`;
      xaiAccountState.classList.add('warn');
      return;
    }
    if (!r.signedIn) {
      xaiAccountState.textContent = 'Not signed in. Use OAuth2 or paste an API key in Enconvo.';
      xaiAccountState.classList.add('warn');
      return;
    }
    if (r.authType === 'oauth2' && r.account) {
      const who = r.account.name || r.account.email || 'xAI account';
      const exp = r.account.expiresAt ? new Date(r.account.expiresAt) : null;
      const expBit = exp && !isNaN(exp) ? ` \u00b7 expires ${exp.toLocaleDateString()}` : '';
      xaiAccountState.textContent = `Signed in via OAuth2 \u00b7 ${who}${expBit}`;
      xaiAccountState.classList.add('good');
    } else {
      xaiAccountState.textContent = 'Signed in via API key';
      xaiAccountState.classList.add('good');
    }
  } catch (e) {
    xaiAccountState.textContent = `Error: ${e.message || e}`;
    xaiAccountState.classList.add('warn');
  }
}
if (xaiSignInBtn) {
  xaiSignInBtn.addEventListener('click', async () => {
    xaiSignInBtn.disabled = true;
    xaiSignInBtn.textContent = 'Opening Enconvo\u2026';
    try {
      await window.mavis.signInXai();
    } finally {
      // Pop back after a short delay so Enconvo has a beat to write tokens.
      setTimeout(async () => {
        xaiSignInBtn.disabled = false;
        xaiSignInBtn.textContent = 'Sign in with xAI';
        await refreshXaiAccount();
      }, 1500);
    }
  });
}

// ---------- xAI STT (mic) ----------
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTs = 0;
function updateMicVisibility(sttEngine) {
  if (!micBtn) return;
  micBtn.hidden = (sttEngine || 'off') === 'off';
}
async function startRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
    mediaRecorder = mime
      ? new MediaRecorder(stream, { mimeType: mime })
      : new MediaRecorder(stream);
    recordedChunks = [];
    recordingStartTs = Date.now();
    mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size) recordedChunks.push(e.data);
    });
    mediaRecorder.addEventListener('stop', async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
      micBtn.classList.remove('recording');
      if (Date.now() - recordingStartTs < 300) return; // ignore accidental taps
      const buf = new Uint8Array(await blob.arrayBuffer());
      try {
        statusEl.textContent = 'transcribing\u2026';
        setDot('thinking');
        const r = await window.mavis.transcribe(buf, mediaRecorder.mimeType || 'audio/webm', 'auto');
        const text = (r && r.text) ? r.text.trim() : '';
        if (!text) { addError('xAI heard silence \u2014 try again.'); refreshStatus(); return; }
        input.value = (input.value ? input.value + ' ' : '') + text;
        autoresize();
        refreshStatus();
        // Auto-send after STT lands so the conversation flows.
        send();
      } catch (e) {
        addError(`STT failed: ${e.message || e}`);
        refreshStatus();
      }
    });
    mediaRecorder.start();
    micBtn.classList.add('recording');
    statusEl.textContent = 'listening\u2026';
    setDot('thinking');
  } catch (e) {
    addError(`Mic permission denied: ${e.message || e}`);
  }
}
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
}
if (micBtn) {
  micBtn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') stopRecording();
    else startRecording();
  });
}
ttsEngineSelect.addEventListener('change', () => {
  populateVoiceList(ttsEngineSelect.value, voiceSelect.value);
});
async function commitSettings() {
  // The bake script picks Kokoro / xAI voice ids from KOKORO_VOICE / XAI_VOICE env vars
  // when ttsEngine != 'edge'. The settings.voice field carries whichever voice is currently
  // selected for the active engine.
  const patch = {
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim() || 'gpt-5-mini',
    voice: voiceSelect.value,
    ttsEngine: ttsEngineSelect.value,
    sttEngine: sttEngineSelect ? sttEngineSelect.value : 'off',
    avatarEngine: avatarEngineSelect ? avatarEngineSelect.value : 'unreal',
    avatarMouthX: mouthXInput ? Number(mouthXInput.value) : 50,
    avatarMouthY: mouthYInput ? Number(mouthYInput.value) : 67,
    resolution: resolutionSelect.value,
    fps: Number(fpsSelect.value) || 24,
    systemPrompt: systemPromptInput.value.trim(),
  };
  const next = await window.mavis.setSettings(patch);
  updateMicVisibility(next.sttEngine);
  settingsModal.classList.add('hidden');
  await refreshStatus();
}

// ---------- Input UX ----------
function autoresize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 110) + 'px';
}
input.addEventListener('input', autoresize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
sendBtn.addEventListener('click', send);
settingsBtn.addEventListener('click', openSettings);
closeSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));
saveSettingsBtn.addEventListener('click', commitSettings);
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.classList.add('hidden');
});

// ---------- Boot ----------
(async () => {
  goIdle();
  const s = await refreshStatus();
  updateMicVisibility(s.sttEngine);
  if (!s.hasKey) openSettings();
})();
