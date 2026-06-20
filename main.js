// Mavis Agent — Electron main process
// Owns: window, persisted settings (API key + model + voice), OpenAI calls,
// real-lipsync MP4 baking via Unreal MetaHuman Performance, and a sha256-keyed cache.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const OpenAI = require('openai');

// Enconvo's local API — we delegate xAI OAuth2 + xAI TTS + xAI STT here so the
// user's logged-in xAI account (managed by Enconvo's credential store) just
// works without us re-implementing the entire OAuth dance. Override with env
// var if Enconvo is bound to a custom port.
const ENCONVO_API = process.env.ENCONVO_API_URL || 'http://localhost:54535';
async function enconvo(pathStr, body = {}) {
  const res = await fetch(`${ENCONVO_API}/${pathStr}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`enconvo ${pathStr} -> HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// Bake takes 25-30s; the original send-click may have aged out of Chromium's
// user-activation window by the time we call video.play() with sound.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ---------- Settings persistence ----------
function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function cacheDir() {
  const d = path.join(app.getPath('userData'), 'cache');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
// Resolution presets — 432x648 is the floor for the ~460px circular avatar
// stage. 320x480 still readable. 540x810 if user wants higher quality.
const RES_PRESETS = {
  standard: { w: 432, h: 648, label: 'Standard 432×648 (default)' },
  high:     { w: 540, h: 810, label: 'High 540×810 (slower bake)' },
  compact:  { w: 320, h: 480, label: 'Compact 320×480 (faster bake)' },
  tiny:     { w: 216, h: 324, label: 'Tiny 216×324 (fastest)' },
};
const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gpt-5-mini',
  voice: 'en-US-AvaMultilingualNeural',
  resolution: 'standard',
  fps: 24,
  ttsEngine: 'edge', // 'edge' | 'kokoro' | 'xai'
  sttEngine: 'off',  // 'off' | 'xai' — mic input mode
  // Avatar engine — which talking-head renderer drives the reply video.
  //   'unreal'   — UE 5.8 MetaHuman MP4 (default, ~4s warm, requires UE running)
  //   'avspeech' — macOS `say` + Web Audio formant analysis on the portrait
  //                  (zero deps, ~0.5s, real F1/F2/HF-driven visemes)
  //   'musetalk' — local diffusion lipsync on the portrait (~10-15s, MPS, ~3GB weights)
  avatarEngine: 'unreal',
  systemPrompt:
    "You are Mavis \u2014 warm, present, sharp without being cold. You live inside a Mac and speak directly, without performing. Keep replies short (1\u20133 sentences) unless the user asks for depth. Have opinions. Use the user's name only if they tell you. Avoid emoji unless asked.",
};
function loadSettings() {
  try {
    // Merge persisted onto defaults so older settings files auto-pick up new fields.
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

let settings = loadSettings();
let openaiClient = null;
function getClient() {
  if (!settings.apiKey) return null;
  if (!openaiClient || openaiClient._key !== settings.apiKey) {
    openaiClient = new OpenAI({ apiKey: settings.apiKey });
    openaiClient._key = settings.apiKey;
  }
  return openaiClient;
}

// ---------- Window ----------
let win;
function createWindow() {
  win = new BrowserWindow({
    width: 460, height: 860, minWidth: 380, minHeight: 720,
    title: 'Mavis', backgroundColor: '#0e0e0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.MAVIS_DEV_TOOLS === '1') win.webContents.openDevTools();
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---------- IPC: settings ----------
ipcMain.handle('settings:get', () => ({ ...settings, hasKey: !!settings.apiKey }));
ipcMain.handle('settings:set', (_e, patch) => {
  settings = { ...settings, ...patch };
  saveSettings(settings);
  openaiClient = null;
  return { ...settings, hasKey: !!settings.apiKey };
});

// ---------- IPC: chat ----------
ipcMain.handle('chat:send', async (_e, { history, userMessage }) => {
  const client = getClient();
  if (!client) throw new Error('No OpenAI API key set. Open settings and paste one.');
  const messages = [
    { role: 'system', content: settings.systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];
  try {
    const res = await client.chat.completions.create({ model: settings.model, messages });
    const reply = res.choices?.[0]?.message?.content?.trim() || '(no reply)';
    return { reply };
  } catch (err) {
    throw new Error(err?.message || String(err));
  }
});

// ---------- IPC: bake (real lipsync) ----------
// Three engines feed the same {kind, ...} response shape so the renderer can
// route to MP4 playback (unreal/musetalk) or to the AVSpeechAvatar component
// (avspeech) without re-asking which engine baked.
const BAKE_SH         = path.join(__dirname, 'scripts', 'bake_reply.sh');
const BAKE_AVSPEECH   = path.join(__dirname, 'scripts', 'bake_avspeech.sh');
const BAKE_MUSETALK   = path.join(__dirname, 'scripts', 'bake_musetalk.sh');
const PORTRAIT_PATH   = path.join(__dirname, 'renderer', 'assets', 'portrait.jpg');
// Cache version: bump when render settings change (resolution, AA, etc.) so
// previously cached MP4s at the old format don't get served at the new format.
// v1: 720x1080 TSR ta=4                                              — 27.0s
// v2: 540x810 TSR ta=1                                                — 8.0s
// v3: 480x720 TSR ta=1 + skip redundant saves + 100ms poll            — 6.0s
// v4: 432x648 + persistent UE daemon + ffmpeg veryfast                — 4.85s
// v5: 24fps + reusable MHP + daemon prewarm + per-user picks + Kokoro — 4.0s
// v6: avatarEngine in the key so AVSpeech/MuseTalk get their own slots         — varies
const CACHE_VERSION = 'v6';
function hashKey(text, voice, resKey, fps, ttsEngine, avatarEngine) {
  return crypto.createHash('sha256')
    .update(`${CACHE_VERSION}\n${avatarEngine}\n${voice}\n${resKey}\n${fps}\n${ttsEngine}\n${text}`)
    .digest('hex').slice(0, 16);
}
// Default helper: spawn a bake script, return whichever absolute path it printed.
function runBakeScript(scriptPath, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', (e) => reject(new Error(`bake spawn failed: ${e.message}`)));
    child.on('close', (code) => {
      const out = stdout.trim().split('\n').pop();
      if (code === 0 && out && fs.existsSync(out)) resolve(out);
      else reject(new Error(`bake failed (${code}): ${stderr.slice(0, 500) || stdout.slice(0, 500)}`));
    });
  });
}
async function bakeReply(text) {
  const voice = settings.voice;
  const resKey = settings.resolution in RES_PRESETS ? settings.resolution : 'standard';
  const res = RES_PRESETS[resKey];
  const fps = Number(settings.fps) || 24;
  const ttsEngine = ['kokoro', 'xai'].includes(settings.ttsEngine) ? settings.ttsEngine : 'edge';
  const avatarEngine = ['avspeech', 'musetalk'].includes(settings.avatarEngine) ? settings.avatarEngine : 'unreal';
  const key = hashKey(text, voice, resKey, fps, ttsEngine, avatarEngine);
  const tmpOut = path.join(os.tmpdir(), 'mavis-bakes');
  fs.mkdirSync(tmpOut, { recursive: true });

  // --- AVSpeech path: WAV + Mavis portrait + renderer-side formant animation
  if (avatarEngine === 'avspeech') {
    const cachePath = path.join(cacheDir(), `${key}.wav`);
    if (fs.existsSync(cachePath)) {
      return {
        kind: 'avspeech', cached: true,
        audioPath: cachePath, audioUrl: pathToFileURL(cachePath).href,
        portraitUrl: pathToFileURL(PORTRAIT_PATH).href,
      };
    }
    // Pick the macOS `say` voice. We respect a dedicated AVSpeech voice if set,
    // otherwise fall back to Samantha — ships on every Mac.
    const sayVoice = settings.avspeechVoice || 'Samantha';
    const out = await runBakeScript(BAKE_AVSPEECH, [text, sayVoice, tmpOut], process.env);
    fs.copyFileSync(out, cachePath);
    try { fs.unlinkSync(out); } catch {}
    return {
      kind: 'avspeech', cached: false,
      audioPath: cachePath, audioUrl: pathToFileURL(cachePath).href,
      portraitUrl: pathToFileURL(PORTRAIT_PATH).href,
    };
  }

  // --- MuseTalk path: MP4 with edited mouth region on the Mavis portrait
  if (avatarEngine === 'musetalk') {
    const cachePath = path.join(cacheDir(), `${key}.mp4`);
    if (fs.existsSync(cachePath)) {
      return { kind: 'mp4', engine: 'musetalk', cached: true, mp4Path: cachePath, mp4Url: pathToFileURL(cachePath).href };
    }
    const env = {
      ...process.env,
      MAVIS_TTS: ttsEngine,
      MAVIS_FPS: '25',                                   // MuseTalk's native FPS
      MAVIS_PORTRAIT: PORTRAIT_PATH,
    };
    if (ttsEngine === 'kokoro') env.KOKORO_VOICE = voice;
    if (ttsEngine === 'xai') { env.XAI_VOICE = voice; env.ENCONVO_API_URL = ENCONVO_API; }
    const out = await runBakeScript(BAKE_MUSETALK, [text, voice, tmpOut], env);
    fs.copyFileSync(out, cachePath);
    try { fs.unlinkSync(out); } catch {}
    return { kind: 'mp4', engine: 'musetalk', cached: false, mp4Path: cachePath, mp4Url: pathToFileURL(cachePath).href };
  }

  // --- Default: UE MetaHuman bake (the v0.5/v0.6 production path)
  const cachePath = path.join(cacheDir(), `${key}.mp4`);
  if (fs.existsSync(cachePath)) {
    return { kind: 'mp4', engine: 'unreal', cached: true, mp4Path: cachePath, mp4Url: pathToFileURL(cachePath).href };
  }
  const env = {
    ...process.env,
    MAVIS_RES_W: String(res.w),
    MAVIS_RES_H: String(res.h),
    MAVIS_FPS: String(fps),
    MAVIS_TTS: ttsEngine,
  };
  if (ttsEngine === 'kokoro') env.KOKORO_VOICE = voice;
  if (ttsEngine === 'xai') { env.XAI_VOICE = voice; env.ENCONVO_API_URL = ENCONVO_API; }
  const out = await runBakeScript(BAKE_SH, [text, voice, tmpOut], env);
  fs.copyFileSync(out, cachePath);
  try { fs.unlinkSync(out); } catch {}
  return { kind: 'mp4', engine: 'unreal', cached: false, mp4Path: cachePath, mp4Url: pathToFileURL(cachePath).href };
}
ipcMain.handle('bake:reply', async (_e, { text }) => {
  if (!text?.trim()) return { kind: 'none' };
  return bakeReply(text);
});
ipcMain.handle('settings:options', () => ({
  resolutions: Object.entries(RES_PRESETS).map(([key, v]) => ({ key, ...v })),
}));

// ---------- IPC: xAI OAuth2 (delegated to Enconvo) ----------
// Enconvo's credential store already runs the full xAI OAuth2 dance and persists
// access_token / refresh_token / account_email / account_avatar. We just read
// the result and surface it in Mavis settings as a 'Signed in as ...' chip.
ipcMain.handle('xai:account', async () => {
  try {
    const cred = await enconvo('credentials/load_credentials', { providerName: 'x_ai' });
    const isOAuth = cred?.credentials_type === 'oauth2';
    const hasToken = !!(cred?.access_token);
    const hasApiKey = !!(cred?.apiKey);
    return {
      ok: true,
      authType: cred?.credentials_type || 'apiKey',
      signedIn: isOAuth ? hasToken : hasApiKey,
      account: isOAuth ? {
        name: cred?.account_name || '',
        email: cred?.account_email || '',
        avatar: cred?.account_avatar || '',
        plan: cred?.account_plan || '',
        expiresAt: cred?.expiry_date || 0,
      } : null,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});
// Opens Enconvo's credentials dialog so the user can run the OAuth flow (or
// paste an API key). After the user finishes there, the renderer should re-call
// xai:account to pull the fresh state.
ipcMain.handle('xai:sign_in', async () => {
  try {
    // The credentials/request_user_fill_credentials endpoint pops Enconvo's UI.
    // We send a synthetic conversationId so the dialog routes back to a known
    // surface even though Mavis isn't an Enconvo conversation.
    await enconvo('credentials/request_user_fill_credentials', {
      providerName: 'x_ai',
      conversationId: `mavis-agent-${Date.now()}`,
    });
    return { ok: true };
  } catch (e) {
    // Fallback: open the xAI console in the user's default browser so they can
    // grab an API key manually and paste it into Enconvo.
    try { await shell.openExternal('https://x.ai/api'); } catch {}
    return { ok: false, error: String(e?.message || e) };
  }
});

// ---------- IPC: STT (xAI Speech-to-Text) ----------
// Renderer records a WebM/Opus blob via MediaRecorder, ships the bytes as a
// Uint8Array. We write to a temp file (xAI STT accepts webm/opus, mp3, wav)
// then call Enconvo's xAI transcribe route which handles the OAuth headers.
ipcMain.handle('stt:transcribe', async (_e, { audio, mime, language }) => {
  if (!audio || !audio.byteLength) throw new Error('empty audio buffer');
  const ext = (mime && mime.includes('webm')) ? 'webm'
           : (mime && mime.includes('wav'))   ? 'wav'
           : (mime && mime.includes('mp4'))   ? 'm4a'
           : 'webm';
  const tmp = path.join(os.tmpdir(), 'mavis-stt');
  fs.mkdirSync(tmp, { recursive: true });
  const filePath = path.join(tmp, `clip-${Date.now()}.${ext}`);
  fs.writeFileSync(filePath, Buffer.from(audio));
  try {
    const res = await enconvo('transcribe/features/x_ai/transcribe', {
      audio_file_path: filePath,
      language: language || 'auto',
      punctuation: true,
      model: 'grok/xai-stt-async',
    });
    // Normalize — xAI's wrapper returns { content, results: [{ text, words, ... }] }.
    const text = (typeof res === 'string' ? res
                : res?.content ?? res?.text ?? res?.transcript ?? res?.results?.[0]?.text ?? res?.result?.text ?? '').trim();
    if (!text) throw new Error(`xAI STT returned no text. Raw: ${JSON.stringify(res).slice(0, 240)}`);
    return { text };
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
});

// ---------- IPC: tts (legacy fallback) ----------
const EDGE_TTS_BIN =
  process.env.MAVIS_EDGE_TTS ||
  '/Users/zanearcher/.enconvo/workspace/agent-main/.venv/bin/edge-tts';
ipcMain.handle('tts:speak', async (_e, { text }) => {
  if (!text?.trim()) return { mp3Path: null };
  const tmpDir = path.join(os.tmpdir(), 'mavis-agent-tts');
  fs.mkdirSync(tmpDir, { recursive: true });
  const mp3Path = path.join(tmpDir, `reply-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp3`);
  return new Promise((resolve, reject) => {
    const args = ['--voice', settings.voice, '--text', text, '--write-media', mp3Path];
    const child = spawn(EDGE_TTS_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', (e) => reject(new Error(`edge-tts spawn failed: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(mp3Path)) resolve({ mp3Path });
      else reject(new Error(`edge-tts exited ${code}: ${stderr.slice(0, 300)}`));
    });
  });
});
