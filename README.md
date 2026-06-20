# Mavis Agent

Electron AI agent companion. Mavis is the visual body — chat with an LLM, hear the reply, watch the **real MetaHuman face pronouncing each word** in ~4 seconds end-to-end.

![status](https://img.shields.io/badge/version-0.6.0-d8b27a) ![runtime](https://img.shields.io/badge/runtime-Electron%20%2B%20Unreal%205.8-1c1a16) ![tts](https://img.shields.io/badge/TTS-Edge%20%7C%20Kokoro%20%7C%20xAI-2c5d3a) ![stt](https://img.shields.io/badge/STT-xAI-2c5d3a)

## What you get

- A **circular MetaHuman face** sitting in a warm-dark stage, with a chat panel below.
- Three TTS engines selectable from Settings:
  - **Edge TTS** (cloud, multilingual) — default. ~4.0 s warm bake.
  - **Kokoro 82M** (local, offline) — Apple Silicon MLX daemon. ~4.2 s warm bake.
  - **xAI TTS** (cloud, expressive) — routed through Enconvo's OAuth2-managed xAI account. ~5.0 s warm bake.
- **xAI Speech-to-Text** mic mode: enable in Settings → a mic button appears in the input bar → click to record, click again to send.
- **xAI account chip** in Settings shows OAuth2 sign-in status straight from Enconvo's credential store.
- Per-reply MP4 baked by Unreal Engine 5.8 MetaHuman Performance → Movie Render Queue → ffmpeg mux. Real phonemes, not audio-reactive jaw waggle.
- Reply text streams character-by-character in sync with the baked audio.
- Aggressive on-disk cache (≈ 100 ms hits) keyed by `(text, voice, resolution, fps, ttsEngine)`.

## Architecture

```
┌─────────── Electron renderer ───────────┐
│ index.html + style.css + renderer.js    │
│ • avatar / chat / mic / settings UI     │
│ • MediaRecorder → window.mavis.transcribe│
└──────────┬──────────────────────────────┘
           │ IPC
┌──────────▼──────────────────────────────┐
│ Electron main (main.js)                 │
│ • settings.json persistence             │
│ • OpenAI chat client                    │
│ • spawns scripts/bake_reply.sh per turn │
│ • thin client over Enconvo local API    │
│   (credentials, xAI TTS, xAI STT)       │
└────┬──────────────────────────┬─────────┘
     │                          │
     │ Unix socket              │ HTTP localhost:54535
     │                          ▼
     │              ┌──────────────────────┐
     │              │ Enconvo local API    │
     │              │ • OAuth2 token store │
     │              │ • /tts/features/xai  │
     │              │ • /transcribe/x_ai   │
     │              └──────────────────────┘
     ▼
┌─────────────────────────────────────────┐
│ scripts/                                │
│  bake_reply.sh   ── orchestrator        │
│  ue_daemon.py    ── UE Python bridge    │
│  kokoro_tts.py   ── MLX TTS daemon      │
└────┬────────────────────────────────────┘
     │ UDP/TCP
     ▼
┌─────────────────────────────────────────┐
│ Unreal Editor 5.8 + MetaHumanPerformance│
│ → /Game/Mavis/Performance/Perf_Reusable │
│ → MoviePipelineQueueSubsystem (PNG seq) │
│ → ffmpeg mux → mavis_<id>.mp4           │
└─────────────────────────────────────────┘
```

## Quick start

```bash
cd /Users/zanearcher/Documents/Codex/MavisAgent
npm install      # one-time
npm start
```

1. First launch pops Settings. Paste your OpenAI `sk-…` key.
2. Pick a TTS engine: Edge (default), Kokoro (offline), or xAI (cloud, expressive).
3. (Optional) Switch STT to **xAI Speech-to-Text** to enable the mic.
4. Send a message. The thinking indicator covers the LLM call + face bake; when the MP4 plays, the reply text streams in sync.

### Settings

All persisted to `~/Library/Application Support/mavis-agent/settings.json`. Schema:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `apiKey` | string | — | OpenAI key for the chat LLM |
| `model` | string | `gpt-5-mini` | Any OpenAI chat-completion model |
| `voice` | string | `en-US-AvaMultilingualNeural` | Engine-aware (Edge/Kokoro/xAI voice ids) |
| `ttsEngine` | enum | `edge` | `edge` \| `kokoro` \| `xai` |
| `sttEngine` | enum | `off` | `off` \| `xai` — toggles mic button |
| `resolution` | enum | `standard` | `tiny` (216×324) \| `compact` (320×480) \| `standard` (432×648) \| `high` (540×810) |
| `fps` | number | `24` | UE Movie Render Queue output fps |
| `systemPrompt` | string | (Mavis persona) | Editable system prompt |

### xAI integration

Auth, voice models, and STT are all delegated to **Enconvo's local API** (`http://localhost:54535`). The Electron app never holds an xAI key directly.

- **Account chip** in Settings reads `POST credentials/load_credentials {providerName:"x_ai"}` and displays the OAuth2 account name + token expiry, or a warning if not signed in.
- **Sign in with xAI** button calls `POST credentials/request_user_fill_credentials {providerName:"x_ai", conversationId:…}` which pops Enconvo's credential UI for OAuth2 flow or API-key paste.
- **TTS** routes through `POST /tts/features/xai/create {text, voice, format:"mp3"}` — returns a server-side mp3 path that the bake script reads via filesystem and resamples to 48 kHz mono WAV for UE.
- **STT** routes through `POST /transcribe/features/x_ai/transcribe {audio_file_path, language, punctuation, model:"grok/xai-stt-async"}` — returns `{content, results:[{text, words:[…]}]}`.

xAI voice ids: `ara` (default), `eve`, `rex`, `sal`, `leo`.

## Performance

Wall-clock per turn (warm, 432×648 24fps, after first request):

| Engine | TTS | UE bake + render | ffmpeg | Total |
| --- | --- | --- | --- | --- |
| Edge | ~0.5 s | ~3.1 s | ~0.25 s | **~4.0 s** |
| Kokoro | ~0.25 s (warm daemon) | ~3.1 s | ~0.25 s | **~4.2 s** |
| xAI | ~1.8 s (cloud + resample) | ~3.1 s | ~0.25 s | **~5.0 s** |

Cache hits: < 100 ms. Cold start (first bake after editor launch): ~7 s.

## Prerequisites at bake time

- **Enconvo local API** running at `http://localhost:54535` (default Enconvo install). Override with `ENCONVO_API_URL`.
- **Unreal Editor 5.8** with `UnrealMCPPilot.uproject` open and Python remote-exec enabled (multicast bind `0.0.0.0`).
- `/Game/Mavis/` assets present: `BP_Mavis_Built`, `RenderLevel` with `ShowcaseCam`, reusable `Perf_Reusable` MHP.
- **ffmpeg** at `/Users/zanearcher/.config/enconvo/bin/ffmpeg` (override with `FFMPEG_PATH`).
- **Kokoro venv** at `~/.enconvo/workspace/agent-main/.venv/bin/python3` if using Kokoro TTS.
- **xAI OAuth2** signed in via Enconvo if using xAI TTS or STT.

When UE isn't running, bake fails fast with a clear error in chat; text reply still appears so the user isn't stranded.

## Bake pipeline (`scripts/bake_reply.sh`)

1. **TTS** picks an engine and writes a 48 kHz mono WAV:
   - `edge` — pipes `edge-tts` directly into `ffmpeg`.
   - `kokoro` — talks to the long-running MLX daemon over `/tmp/mavis_kokoro_daemon.sock`.
   - `xai` — `POST /tts/features/xai/create`, downloads mp3, resamples to wav.
2. **UE bridge** (`ue_send.py` → `ue_daemon.py` over `/tmp/mavis_ue_daemon.sock`):
   - Loads reusable MHP at `/Game/Mavis/Performance/Perf_Reusable`, sets the new audio.
   - `perf.start_pipeline()` (~1 s for 4 s of audio).
   - `MetaHumanPerformanceExportUtils.export_level_sequence(perf, settings)` → fresh `LS_Reply_<id>`.
   - Strips orphan bindings, adds `ShowcaseCam` + `CameraCutTrack`, master audio track.
3. **Movie Render Queue** renders PNG sequence at the chosen resolution/fps (TSR AA, spatial=1 temporal=1).
4. **ffmpeg** muxes PNG sequence + WAV → `mavis_<id>.mp4`.

## IPC channels (preload.js)

| Channel | Direction | Payload |
| --- | --- | --- |
| `settings:get` / `settings:set` | renderer → main | merged settings JSON |
| `settings:options` | renderer → main | static resolution presets, fps list |
| `chat:send` | renderer → main | `{history, userMessage}` → `{reply}` |
| `bake:reply` | renderer → main | `text` → `{mp4Path, mp4Url, cached}` |
| `xai:account` | renderer → main | → `{ok, authType, signedIn, account:{name, email, avatar, plan, expiresAt}}` |
| `xai:sign_in` | renderer → main | pops Enconvo OAuth2 UI |
| `stt:transcribe` | renderer → main | `{audio:Uint8Array, mime, language}` → `{text}` |

## Hard-won pipeline lessons (UE 5.8 macOS)

1. **MHP creation** must use `AssetTools.create_asset(name, path, MetaHumanPerformance, MetaHumanPerformanceFactoryNew())`. Duplicate-then-delete-then-recreate to the same path returns a stale cached asset; reuse via `Perf_Reusable` instead.
2. **`perf.set_editor_property('input_type', DataInputType.AUDIO)` is mandatory.** Default is `MONO_FOOTAGE`; without the override, `start_pipeline()` silently returns 0 frames.
3. **`export_animation_sequence` produces an unusable AnimSequence for the face.** Use `export_level_sequence` — its internal name mapping translates AnimSeq curve names (`CTRL_expressions_jawOpen`) to Control Rig section parameters (`CTRL_C_jaw_openExtreme`).
4. **`settings.show_export_dialog = False` is mandatory** — default `True` makes `export_level_sequence` no-op in 0.01 s.
5. **`section.set_range(start, end)` takes plain `int`**, not `FrameNumber(int)`.
6. **MRQ render is async even with `MoviePipelinePIEExecutor`.** Poll the output dir for PNG count instead of awaiting the call.
7. **Per-reply asset paths need unique IDs.** Reuse after `delete_asset` returns `None` on next `create_asset`. Use `date +%s + RANDOM`.
8. **`custom_end_frame` stays in display frames** (30 fps). MRQ writes `pb_end * MAVIS_FPS / 30` PNGs internally; account for it in completion polling.
9. **Settings file lives in Electron userData**, not the repo. `.gitignore` excludes `settings.json` and `cache/` to keep secrets and per-user baked MP4s out of the tree.
10. **CSS gotcha**: the HTML `hidden` attribute does NOT beat `display: flex` from a sibling rule. The mic button needs `.inputbar .mic[hidden] { display: none !important; }`.

Full UE reference: `~/.agents/skills/UnrealEngine/references/sequencer-render.md`.

## Repo layout

```
main.js                  Electron main; IPC handlers; Enconvo client
preload.js               window.mavis bridges
renderer/
  index.html             stage / chat / inputbar / settings modal
  style.css              warm-dark stage + cream chat + dropdowns + mic button
  renderer.js            chat UI, MediaRecorder STT, settings, voice pickers
  assets/                idle poster + portrait jpg
scripts/
  bake_reply.sh          per-reply pipeline orchestrator
  ue_send.py             socket client to the UE daemon
  ue_daemon.py           persistent Python bridge inside UnrealEditor
  kokoro_tts.py          long-running MLX Kokoro TTS daemon
package.json
```

## License

MIT — see `package.json`.
