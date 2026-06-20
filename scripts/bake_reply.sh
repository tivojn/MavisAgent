#!/bin/bash
# Mavis Agent — real MetaHuman lipsync bake.
# Usage: bake_reply.sh <reply_text> [voice] [out_dir]
# Output: prints absolute MP4 path on stdout.
set -e

REPLY_TEXT="$1"
VOICE="${2:-en-US-AvaMultilingualNeural}"
OUT_DIR="${3:-/tmp/mavis_replies}"

[ -z "$REPLY_TEXT" ] && { echo "ERROR: text required" >&2; exit 1; }
mkdir -p "$OUT_DIR"
WORK=$(mktemp -d -t mavis-bake-XXXXXX)
trap "rm -rf $WORK" EXIT

ID="r$(date +%s)$(($RANDOM % 1000))"
FFMPEG="${FFMPEG_PATH:-/Users/zanearcher/.config/enconvo/bin/ffmpeg}"
EDGE_TTS="${EDGE_TTS_PATH:-/Users/zanearcher/.enconvo/workspace/agent-main/.venv/bin/edge-tts}"
# Resolution overridable via env. Defaults to 432x648.
MAVIS_W="${MAVIS_RES_W:-432}"
MAVIS_H="${MAVIS_RES_H:-648}"
# Frame rate overridable. Defaults to 24fps (was 30). Saves ~20% MRQ frames.
MAVIS_FPS="${MAVIS_FPS:-24}"
# TTS engine: 'edge' (cloud, default), 'kokoro' (local), or 'xai' (cloud via Enconvo).
MAVIS_TTS="${MAVIS_TTS:-edge}"
ENCONVO_API_URL="${ENCONVO_API_URL:-http://localhost:54535}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UE_DAEMON_PY="$SCRIPT_DIR/ue_daemon.py"
UE_SEND_PY="$SCRIPT_DIR/ue_send.py"
UE_DAEMON_SOCK="/tmp/mavis_ue_daemon.sock"
UE_DAEMON_LOG="/tmp/mavis_ue_daemon.log"

# Ensure the UE daemon is running. Saves ~1s per bake vs spinning up
# Python + UDP discovery + TCP connect every time.
if ! python3 -c "import socket,sys; s=socket.socket(socket.AF_UNIX); s.settimeout(0.3); s.connect('$UE_DAEMON_SOCK')" 2>/dev/null; then
  echo "[bake] starting UE daemon…" >&2
  nohup python3 "$UE_DAEMON_PY" >"$UE_DAEMON_LOG" 2>&1 &
  for i in $(seq 1 50); do  # up to 5s
    sleep 0.1
    [ -S "$UE_DAEMON_SOCK" ] && grep -q 'ready' "$UE_DAEMON_LOG" 2>/dev/null && break
  done
  [ -S "$UE_DAEMON_SOCK" ] || { echo "ERROR: daemon failed to bind socket" >&2; cat "$UE_DAEMON_LOG" >&2; exit 7; }
fi

WAV="$WORK/reply.wav"; PNG_DIR="$WORK/png"; mkdir -p "$PNG_DIR"
if [ "$MAVIS_TTS" = "kokoro" ]; then
  # Kokoro local TTS via persistent daemon (kokoro_tts.py).
  # Cold init ~3s; warm synth ~0.6s. Offline / privacy mode.
  KOKORO_VOICE="${KOKORO_VOICE:-af_heart}"
  KOKORO_PY="$SCRIPT_DIR/kokoro_tts.py"
  /Users/zanearcher/.enconvo/workspace/agent-main/.venv/bin/python3 "$KOKORO_PY" "$REPLY_TEXT" "$KOKORO_VOICE" "$WORK/raw.wav" >/dev/null 2>&1 || true
  [ -f "$WORK/raw.wav" ] || { echo "ERROR: kokoro tts failed (check /tmp/mavis_kokoro_daemon.log)" >&2; exit 2; }
  "$FFMPEG" -y -i "$WORK/raw.wav" -ar 48000 -ac 1 -c:a pcm_s16le "$WAV" 2>/dev/null
elif [ "$MAVIS_TTS" = "xai" ]; then
  # xAI TTS via Enconvo local API. Uses the user's logged-in xAI OAuth2 account
  # (Enconvo handles token refresh + auth headers). xAI returns MP3; resample to
  # 48kHz mono WAV like the other branches.
  XAI_VOICE="${XAI_VOICE:-eve}"
  XAI_PY="/Users/zanearcher/.enconvo/workspace/agent-main/.venv/bin/python3"
  XAI_MP3="$(MAVIS_XAI_TEXT="$REPLY_TEXT" MAVIS_XAI_VOICE="$XAI_VOICE" MAVIS_XAI_ENDPOINT="$ENCONVO_API_URL/tts/features/xai/create" "$XAI_PY" -c 'import os,json,urllib.request; req=urllib.request.Request(os.environ["MAVIS_XAI_ENDPOINT"], data=json.dumps({"text":os.environ["MAVIS_XAI_TEXT"],"voice":os.environ["MAVIS_XAI_VOICE"],"format":"mp3"}).encode(), headers={"Content-Type":"application/json"}, method="POST"); print(json.loads(urllib.request.urlopen(req,timeout=30).read()).get("path",""))' 2>/dev/null)"
  [ -n "$XAI_MP3" ] && [ -f "$XAI_MP3" ] || { echo "ERROR: xAI TTS failed (endpoint=$ENCONVO_API_URL voice=$XAI_VOICE)." >&2; exit 2; }
  "$FFMPEG" -y -i "$XAI_MP3" -ar 48000 -ac 1 -c:a pcm_s16le "$WAV" 2>/dev/null
else
  # edge-tts piped directly to ffmpeg — no intermediate MP3 file write.
  "$EDGE_TTS" --voice "$VOICE" --text "$REPLY_TEXT" --write-media /dev/stdout 2>/dev/null \
    | "$FFMPEG" -y -i pipe:0 -ar 48000 -ac 1 -c:a pcm_s16le "$WAV" 2>/dev/null
fi
[ -f "$WAV" ] || { echo "ERROR: tts pipe failed (engine=$MAVIS_TTS)" >&2; exit 2; }

UE_SCRIPT="$WORK/bake.py"
cat > "$UE_SCRIPT" <<PY
import unreal, os, json, warnings, shutil
warnings.filterwarnings('ignore')
ID = '${ID}'
WAV = '${WAV}'
OUT_DIR = '${PNG_DIR}'
EAL = unreal.EditorAssetLibrary
LES = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
ATH = unreal.AssetToolsHelpers.get_asset_tools()
out = {}
try:
    sw_path = f'/Game/Mavis/Audio/reply_{ID}'
    # Reusable MHP asset — created once, audio re-set per bake. Saves ~200-300ms
    # of ATH.create_asset overhead per call.
    perf_path = '/Game/Mavis/Performance/Perf_Reusable'
    ls_path = f'/Game/Mavis/Performance/LS_Reply_{ID}'
    task = unreal.AssetImportTask()
    task.set_editor_property('filename', WAV)
    task.set_editor_property('destination_path', '/Game/Mavis/Audio')
    task.set_editor_property('destination_name', f'reply_{ID}')
    task.set_editor_property('replace_existing', True)
    task.set_editor_property('automated', True)
    task.set_editor_property('save', True)
    ATH.import_asset_tasks([task])
    sw = EAL.load_asset(sw_path)
    # Reuse a single global MetaHumanPerformance if it exists; otherwise create once.
    perf = EAL.load_asset(perf_path)
    if perf is None:
        perf = ATH.create_asset('Perf_Reusable', '/Game/Mavis/Performance', unreal.MetaHumanPerformance, unreal.MetaHumanPerformanceFactoryNew())
    perf.set_editor_property('input_type', unreal.DataInputType.AUDIO)
    perf.set_editor_property('audio', sw)
    perf.set_blocking_processing(True)
    perf.start_pipeline()
    settings = unreal.MetaHumanPerformanceExportUtils.get_export_level_sequence_settings(perf)
    settings.set_editor_property('package_path', '/Game/Mavis/Performance')
    settings.set_editor_property('asset_name', f'LS_Reply_{ID}')
    settings.set_editor_property('show_export_dialog', False)
    settings.set_editor_property('export_audio_track', True)
    settings.set_editor_property('export_camera', False)
    settings.set_editor_property('export_control_rig_track', True)
    settings.set_editor_property('export_depth_mesh', False)
    settings.set_editor_property('export_depth_track', False)
    settings.set_editor_property('export_identity', False)
    settings.set_editor_property('export_image_plane', False)
    settings.set_editor_property('export_transform_track', False)
    settings.set_editor_property('export_video_track', False)
    settings.set_editor_property('enable_meta_human_head_movement', False)
    settings.set_editor_property('enable_control_rig_head_movement', True)
    target_bp = EAL.load_asset('/Game/Mavis/MH/Unpacked/Mavis_Built/BP_Mavis_Built')
    settings.set_editor_property('target_meta_human_class', target_bp)
    unreal.MetaHumanPerformanceExportUtils.export_level_sequence(perf, settings)
    ls = EAL.load_asset(ls_path)
    pb_end = ls.get_playback_end()
    for b in list(ls.get_bindings()):
        if b.get_name() in ('Body','Face') and not b.get_parent().is_valid():
            try: b.remove()
            except: pass
    bp_bind = next((b for b in ls.get_bindings() if b.get_name() == 'BP Mavis Built'), None)
    if bp_bind:
        for tr in list(bp_bind.get_tracks()):
            if tr.get_class().get_name() == 'MovieScene3DTransformTrack':
                bp_bind.remove_track(tr)
    LES.load_level('/Game/Mavis/RenderLevel')
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors()
    cam = next((a for a in actors if a.get_actor_label() == 'ShowcaseCam'), None)
    cam_bind = ls.add_possessable(cam)
    cam_cut_track = ls.add_track(unreal.MovieSceneCameraCutTrack)
    cam_cut_sect = cam_cut_track.add_section()
    cam_cut_sect.set_camera_binding_id(ls.get_binding_id(cam_bind))
    tps = ls.get_tick_resolution().numerator
    cam_cut_sect.set_range(0, int(round((pb_end/30.0)*tps)))
    # Skip EAL.save_asset(ls_path) — the LS lives in memory and MRQ resolves it via
    # the queue job's SoftObjectPath inside this same process. The asset will be
    # garbage-collected after the bake; no need to persist to disk. Saves ~200-500ms.
    if os.path.exists(OUT_DIR): shutil.rmtree(OUT_DIR)
    os.makedirs(OUT_DIR, exist_ok=True)
    MPQS = unreal.get_editor_subsystem(unreal.MoviePipelineQueueSubsystem)
    queue = MPQS.get_queue()
    for j in list(queue.get_jobs()): queue.delete_job(j)
    job = queue.allocate_new_job(unreal.MoviePipelineExecutorJob)
    job.set_editor_property('sequence', unreal.SoftObjectPath(ls_path))
    job.set_editor_property('map', unreal.SoftObjectPath('/Game/Mavis/RenderLevel'))
    cfg = job.get_configuration()
    cfg.find_or_add_setting_by_class(unreal.MoviePipelineDeferredPassBase)
    os_set = cfg.find_or_add_setting_by_class(unreal.MoviePipelineOutputSetting)
    os_set.output_directory = unreal.DirectoryPath(OUT_DIR)
    os_set.file_name_format = 'frame_{frame_number_rel}'
    # Resolution from env (default 432x648). Stage renders at ~460px wide.
    os_set.output_resolution = unreal.IntPoint(${MAVIS_W}, ${MAVIS_H})
    # Frame rate override — 24fps cuts ~20% of MRQ frames vs 30fps with no
    # perceptual loss on talking-head content (24fps = broadcast film standard).
    os_set.use_custom_frame_rate = True
    os_set.output_frame_rate = unreal.FrameRate(${MAVIS_FPS}, 1)
    os_set.override_existing_output = True
    os_set.use_custom_playback_range = True
    os_set.custom_start_frame = 0
    # custom_end_frame is in LS DISPLAY frames (30fps from MHP), NOT MRQ output
    # frames — MRQ then writes (pb_end * output_fps / 30) PNGs.
    os_set.custom_end_frame = pb_end
    cfg.find_or_add_setting_by_class(unreal.MoviePipelineImageSequenceOutput_PNG)
    aa = cfg.find_or_add_setting_by_class(unreal.MoviePipelineAntiAliasingSetting)
    # ta=1 disables temporal sub-sampling entirely — silences the
    # 'evaluation will occur outside of shot boundaries (from frame -1 to 0)'
    # warning AND drops per-frame render cost ~4x. TSR still benefits from
    # render history, so output stays clean for a static portrait shot.
    aa.spatial_sample_count = 1; aa.temporal_sample_count = 1
    aa.override_anti_aliasing = True; aa.anti_aliasing_method = unreal.AntiAliasingMethod.AAM_TSR
    executor = unreal.MoviePipelinePIEExecutor()
    MPQS.render_queue_with_executor_instance(executor)
    # Report MRQ output frame count to bash (matches custom_end_frame above).
    out['frames'] = int(round(pb_end * ${MAVIS_FPS} / 30.0))
except Exception as e:
    import traceback
    out['error'] = str(e); out['tb'] = traceback.format_exc()[-400:]
print('@@KIT@@' + json.dumps(out))
PY

UE_OUT=$(python3 "$UE_SEND_PY" "$UE_SCRIPT" 2>&1)
FRAMES=$(echo "$UE_OUT" | python3 -c 'import sys,re,json; m=re.search(r"@@KIT@@(\{.*?\})", sys.stdin.read(), re.DOTALL); d=json.loads(m.group(1).encode().decode("unicode_escape")) if m else {}; print(d.get("frames",0) if not d.get("error") else "ERR:"+d.get("error","x"))')
[[ "$FRAMES" == ERR:* ]] && { echo "UE bake error: $FRAMES" >&2; exit 4; }
[ "$FRAMES" -gt 0 ] || { echo "UE returned 0 frames" >&2; exit 4; }

# Poll at 100ms instead of 1s. MRQ render at 480x720 ta=1 is ~2.5s for 90 frames;
# the old 1s interval was guaranteed to add 0–900ms of tail latency. We also wait
# for the LAST expected frame's PNG file to exist (more reliable than `ls | wc -l`
# which can race with MRQ's write-then-rename pattern).
LAST_FRAME=$(printf 'frame_%04d.png' $((FRAMES - 1)))
for i in $(seq 1 600); do  # 600 * 0.1s = 60s max
  [ -f "$PNG_DIR/$LAST_FRAME" ] && C=$FRAMES && break
  sleep 0.1
done
[ "${C:-0}" -ge "$FRAMES" ] || { C=$(ls "$PNG_DIR"/*.png 2>/dev/null | wc -l | tr -d ' '); echo "render incomplete $C/$FRAMES" >&2; exit 5; }

MP4="$OUT_DIR/mavis_${ID}.mp4"
# -preset veryfast = ~50ms slower than ultrafast but half the file size at
# same crf. Framerate matches MAVIS_FPS so video duration = audio duration.
"$FFMPEG" -y -threads 0 -framerate $MAVIS_FPS -i "$PNG_DIR/frame_%04d.png" -i "$WAV" \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -crf 20 -c:a aac -shortest "$MP4" 2>/dev/null
[ -f "$MP4" ] || { echo "mux failed" >&2; exit 6; }

echo "$MP4"
