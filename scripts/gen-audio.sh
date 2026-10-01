#!/usr/bin/env bash
# Generates the ten announcement clips with espeak-ng (a robotic but free voice).
# For a nicer result, record your own clips (or use any TTS) and convert them with:
#   ffmpeg -i in.wav -af "adelay=400|400" -c:a libopus -b:a 64k -ar 48000 -ac 2 out.ogg
# Requires: espeak-ng, ffmpeg.
set -euo pipefail

OUT="${AUDIO_DIR:-assets/audio}"
VOICE="${VOICE:-en-gb}"
mkdir -p "$OUT"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

declare -A NAMES=([fajr]=Fajr [dhuhr]=Dhuhr [asr]=Asr [maghrib]=Maghrib [isha]=Isha)
# Spellings that help espeak say the names closer to their Arabic pronunciation.
declare -A SPOKEN=([fajr]="Fudger" [dhuhr]="Thoo-hur" [asr]="Ussr" [maghrib]="Mugg-rib" [isha]="Ishaa")

for p in fajr dhuhr asr maghrib isha; do
  for kind in start ending; do
    if [[ $kind == start ]]; then text="${SPOKEN[$p]} has started."; else text="${SPOKEN[$p]} time is ending soon."; fi
    espeak-ng -v "$VOICE" -s 140 -w "$tmp/$p.wav" "$text"
    # 0.4s of leading silence so the first word is not clipped while voice warms up.
    ffmpeg -loglevel error -y -i "$tmp/$p.wav" -af "adelay=400|400,loudnorm=I=-16:TP=-1.5" \
      -c:a libopus -b:a 64k -ar 48000 -ac 2 "$OUT/${p}_${kind}.ogg"
    echo "wrote $OUT/${p}_${kind}.ogg (${NAMES[$p]} $kind)"
  done
done
