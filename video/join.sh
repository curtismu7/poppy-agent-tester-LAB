#!/usr/bin/env bash
# Joins the main take and the end segment (protect, observability, closing) into one video, re-encoded so the two parts match.
# Usage: video/join.sh main.mp4 end.mp4 out.mp4
set -euo pipefail
[ "$#" -eq 3 ] || { echo "usage: $0 main.mp4 end.mp4 out.mp4" >&2; exit 2; }
ffmpeg -hide_banner -loglevel error -y -i "$1" -i "$2" \
  -filter_complex "[0:v]setsar=1,fps=25[a];[1:v]scale=iw:ih,setsar=1,fps=25[b];[a][b]concat=n=2:v=1:a=0[v]" \
  -map "[v]" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p "$3"
