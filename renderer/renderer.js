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

const apiKeyInput = document.getElementById('apiKey');
const modelInput = document.getElementById('model');
const voiceSelect = document.getElementById('voice');
const voiceLabel = document.getElementById('voiceLabel');
const ttsEngineSelect = document.getElementById('ttsEngine');
const sttEngineSelect = document.getElementById('sttEngine');
const resolutionSelect = document.getElementById('resolution');
const fpsSelect = document.getElementById('fps');
const systemPromptInput = document.getElementById('systemPrompt');
const xaiAccountState = document.getElementById('xaiAccountState');
const xaiSignInBtn = document.getElementById('xaiSignInBtn');
const micBtn = document.getElementById('micBtn');

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
// Text bubble is created at play() success — not before — so the user never
// sees a transcript without a face.
function playBaked(mp4Url, replyText) {
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

// ---------- Status ----------
function shortLabel(s) {
  if (s.ttsEngine === 'kokoro') return `${s.model} \u00b7 Kokoro`;
  if (s.ttsEngine === 'xai') return `${s.model} \u00b7 xAI \u00b7 ${s.voice}`;
  return `${s.model} \u00b7 ${s.voice.replace('en-US-', '').replace('Neural', '').replace('Multilingual', '')}`;
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
      const { mp4Path, mp4Url, cached } = await window.mavis.bakeReply(reply);
      typing.remove();
      if (cached) console.log('[mavis] cache hit', mp4Path);
      const url = mp4Url || (mp4Path ? `file://${encodeURI(mp4Path)}` : null);
      if (url) {
        playBaked(url, reply);
      } else {
        // No video (rare — empty reply). Show text so the user still gets the answer.
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
  systemPromptInput.value = s.systemPrompt || '';
  settingsModal.classList.remove('hidden');
  refreshXaiAccount();
  setTimeout(() => apiKeyInput.focus(), 50);
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
