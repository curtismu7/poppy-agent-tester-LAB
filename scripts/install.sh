#!/bin/sh
# One command: download, start and open the Poppy Agent Tester LAB in the browser.
#
#   curl -fsSL https://raw.githubusercontent.com/curtismu7/poppy-agent-tester-LAB/main/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/curtismu7/poppy-agent-tester-LAB/main/scripts/install.sh | sh -s -- --real
#
# Default (mock): the explainer with an example run of invented values. Needs no tenant, no PingFederate, no sign-in.
# --real: the live run. Needs your own Company and PingFederate and the agent reachable over https (docs/setup.md).
# --pingone: the live run against YOUR PingOne environment with the reference Company in company/. Asks for the environment ID and a
#   worker client ID and secret, creates the PingOne objects (resource, app, grant) and starts the Company and the lab. Node 26 only.
# Runs in Docker when Docker is running, otherwise on Node 26 (a --real run prefers Node 26 when it is installed). Listens on 127.0.0.1 only (ports 5450-5499).
set -eu

REPO=curtismu7/poppy-agent-tester-LAB
NAME=poppy-agent-tester-lab
MODE=mock; OPEN=1; DRY=0; STOP=0; PORT=${HOST_PORT:-}; RUNTIME=auto; DIR=${PAT_DIR:-}; REGION=com; DEMOUSER=0; CPORT=5452

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then say "+ $*"; else "$@"; fi; }
runq() { if [ "$DRY" = 1 ]; then say "+ $*"; else "$@" >/dev/null 2>&1; fi; }

usage() {
  cat <<'EOF'
Poppy Agent Tester LAB: download, start, open the browser.

  sh install.sh [options]

  --mock            explainer with an example run (default; no tenant, no sign-in)
  --real            live run against your own Company and PingFederate (see docs/setup.md)
  --pingone         live run against your own PingOne environment: creates the PingOne objects and starts the reference Company
  --region R        PingOne region for --pingone: com (default), ca, eu, com.au, sg, asia
  --demo-user       with --pingone: also create one demo user (needs the worker to manage users)
  --dir DIR         where the lab lives (default: ~/poppy-agent-tester-LAB)
  --port N          port on 127.0.0.1, 5450-5499 (default: the first free one)
  --runtime R       docker or node (default: docker if it is running, else node; --real prefers node)
  --no-open         do not open the browser
  --dry-run         print what would run, change nothing
  --stop            stop the lab started by this script
  --help            this text

Pipe form:  curl -fsSL https://raw.githubusercontent.com/curtismu7/poppy-agent-tester-LAB/main/scripts/install.sh | sh -s -- --real
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mock) MODE=mock ;;
    --real) MODE=real ;;
    --pingone) MODE=pingone ;;
    --region) [ $# -ge 2 ] || die "--region needs a value"; REGION=$2; shift ;;
    --demo-user) DEMOUSER=1 ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a path"; DIR=$2; shift ;;
    --port) [ $# -ge 2 ] || die "--port needs a number"; PORT=$2; shift ;;
    --runtime) [ $# -ge 2 ] || die "--runtime needs docker or node"; RUNTIME=$2; shift ;;
    --no-open) OPEN=0 ;;
    --dry-run) DRY=1 ;;
    --stop) STOP=1 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

case "$RUNTIME" in auto|docker|node) ;; *) die "--runtime must be docker or node" ;; esac
case "$REGION" in com|ca|eu|com.au|sg|asia) ;; *) die "--region must be com, ca, eu, com.au, sg or asia" ;; esac
if [ "$MODE" = pingone ]; then
  [ "$RUNTIME" = docker ] && die "--pingone needs Node 26 (the lab and the reference Company reach each other on loopback); drop --runtime docker"
  RUNTIME=node
fi
if [ -n "$PORT" ]; then
  case "$PORT" in *[!0-9]*) die "--port must be a number" ;; esac
  [ "$PORT" -ge 5450 ] && [ "$PORT" -le 5499 ] || die "--port must be in 5450-5499"
  [ "$MODE" = pingone ] && [ "$PORT" = "$CPORT" ] && die "--port $CPORT is the reference Company's port; pick another"
fi

# Where is the lab? An explicit --dir or PAT_DIR wins; running this script from inside a clone uses that clone.
if [ -z "$DIR" ]; then
  here=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd || true)
  if [ -n "$here" ] && [ -f "$here/Dockerfile" ] && grep -q '"name": "poppy-agent-tester"' "$here/package.json" 2>/dev/null; then
    DIR=$here
  else
    DIR=$HOME/poppy-agent-tester-LAB
  fi
fi

have() { command -v "$1" >/dev/null 2>&1; }

if [ "$STOP" = 1 ]; then
  for f in "$DIR/.launcher.pid" "$DIR/.launcher-company.pid"; do
    if [ -f "$f" ]; then
      runq kill "$(cat "$f")" || true
      run rm -f "$f"
    fi
  done
  if have docker && docker info >/dev/null 2>&1; then runq docker rm -f "$NAME" || true; fi
  say "Stopped."
  exit 0
fi

# Pick the runtime.
node_ok() { have node && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 26 ]; }
docker_ok() { have docker && docker info >/dev/null 2>&1; }
if [ "$RUNTIME" = auto ]; then
  # A live run is set up for the host (docs/setup.md), so it prefers Node when Node 26 is there.
  if [ "$MODE" = real ] && node_ok; then RUNTIME=node; elif docker_ok; then RUNTIME=docker; elif node_ok; then RUNTIME=node; else
    die "need Docker (running) or Node 26 or newer. Install OrbStack or Docker Desktop, or Node 26 from https://nodejs.org, then run this again."
  fi
fi
if [ "$DRY" = 0 ]; then
  if [ "$RUNTIME" = docker ]; then docker_ok || die "Docker is not running. Start it and run this again."; fi
  if [ "$RUNTIME" = node ]; then node_ok || die "Node 26 or newer is needed for --runtime node."; fi
fi

# Download or update.
if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  run git -C "$DIR" pull --ff-only --quiet || say "Could not update; using what is there."
elif [ -f "$DIR/Dockerfile" ]; then
  say "Using $DIR"
else
  say "Downloading to $DIR"
  if have git; then
    run git clone --depth 1 "https://github.com/$REPO.git" "$DIR"
  elif have curl && have tar; then
    run mkdir -p "$DIR"
    if [ "$DRY" = 1 ]; then say "+ curl -fsSL https://codeload.github.com/$REPO/tar.gz/refs/heads/main | tar -xz --strip-components=1 -C $DIR"
    else curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar -xz --strip-components=1 -C "$DIR"; fi
  else
    die "need git, or curl and tar, to download the lab."
  fi
fi

# A real run reads its settings from .env (docs/setup.md); start from the example.
if [ "$MODE" = real ] && [ ! -f "$DIR/.env" ]; then
  run cp "$DIR/.env.example" "$DIR/.env"
  say "Created $DIR/.env from the example. Fill in your Company and PingFederate settings there (docs/setup.md)."
fi

# First free port in 5450-5499.
port_free() {
  if have nc; then ! nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  elif have lsof; then ! lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else return 0; fi
}
if [ -z "$PORT" ]; then
  p=5450
  while [ "$p" -le 5499 ]; do
    if [ "$MODE" = pingone ] && [ "$p" = "$CPORT" ]; then p=$((p + 1)); continue; fi   # that port is the reference Company
    if port_free "$p"; then PORT=$p; break; fi
    p=$((p + 1))
  done
  [ -n "$PORT" ] || die "no free port in 5450-5499."
elif [ "$DRY" = 0 ] && ! port_free "$PORT"; then
  die "port $PORT is in use. Pick another with --port, or stop what is using it."
fi
if [ "$MODE" = pingone ] && [ "$DRY" = 0 ] && ! port_free "$CPORT"; then
  die "port $CPORT (the reference Company) is in use. Stop what is using it and run this again."
fi

if [ "$MODE" = real ] || [ "$MODE" = pingone ]; then MODEVAL=live; else MODEVAL=mock; fi

# Start.
if [ "$RUNTIME" = docker ]; then
  runq docker rm -f "$NAME" || true
  say "Building the image (first time takes a minute or two)"
  runq docker build -q -t "$NAME" "$DIR"
  ENVFILE=
  [ "$MODE" = real ] && ENVFILE="--env-file $DIR/.env"
  # shellcheck disable=SC2086
  runq docker run -d --name "$NAME" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    -p "127.0.0.1:$PORT:5450" -v "$NAME-data:/data" $ENVFILE -e PORT=5450 -e MODE="$MODEVAL" -e PAT_DATA_DIR=/data "$NAME"
else
  [ "$DRY" = 1 ] || cd "$DIR"
  [ -d node_modules ] || run npm ci
  [ -f web/dist/index.html ] || run npm run build
  [ "$MODE" = real ] && { run npm run doctor || say "The checks above show what still needs setting in .env."; }
  if [ "$MODE" = pingone ]; then
    # Create the PingOne objects (asks for the environment ID, worker client ID and secret on the terminal; the secret is never stored),
    # then start the reference Company and the lab, both reading the settings the setup script wrote to .env.
    DEMOARG=
    [ "$DEMOUSER" = 1 ] && DEMOARG=--demo-user
    if [ "$DRY" = 1 ]; then
      say "+ node scripts/pingone/setup.mjs --region $REGION --base-url http://127.0.0.1:$PORT $DEMOARG   (asks on the terminal)"
      say "+ node --env-file=$DIR/.env company/src/index.js   (background, log in $DIR/.launcher-company.log)"
      say "+ PORT=$PORT MODE=live node --env-file=$DIR/.env server/src/index.js   (background, log in $DIR/.launcher.log)"
    else
      [ -r /dev/tty ] || die "--pingone asks for the PingOne worker credentials, so it needs a terminal."
      # shellcheck disable=SC2086
      node scripts/pingone/setup.mjs --region "$REGION" --base-url "http://127.0.0.1:$PORT" $DEMOARG </dev/tty || die "the PingOne setup failed; nothing was started."
      nohup node --env-file="$DIR/.env" company/src/index.js >"$DIR/.launcher-company.log" 2>&1 &
      echo $! >"$DIR/.launcher-company.pid"
      PORT=$PORT MODE=live nohup node --env-file="$DIR/.env" server/src/index.js >"$DIR/.launcher.log" 2>&1 &
      echo $! >"$DIR/.launcher.pid"
    fi
  elif [ "$DRY" = 1 ]; then say "+ PORT=$PORT MODE=$MODEVAL npm start (background, log in $DIR/.launcher.log)"
  else
    PORT=$PORT MODE=$MODEVAL nohup npm start >"$DIR/.launcher.log" 2>&1 &
    echo $! >"$DIR/.launcher.pid"
  fi
fi

URL="http://localhost:$PORT/"

# Wait until it answers.
if [ "$DRY" = 0 ]; then
  have curl || die "curl is needed to check that the lab started."
  i=0
  until curl -fsS "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -le 60 ] || die "the lab did not start in 60 seconds. Look at: $( [ "$RUNTIME" = docker ] && echo "docker logs $NAME" || echo "$DIR/.launcher.log" )"
    sleep 1
  done
  if [ "$MODE" = pingone ]; then
    i=0
    until curl -fsS "http://127.0.0.1:$CPORT/healthz" >/dev/null 2>&1; do
      i=$((i + 1))
      [ "$i" -le 30 ] || die "the reference Company did not start. Look at: $DIR/.launcher-company.log"
      sleep 1
    done
  fi
fi

# Open the browser.
if [ "$OPEN" = 1 ]; then
  if have open; then run open "$URL"
  elif have xdg-open; then run xdg-open "$URL"
  fi
fi

say ""
[ "$DRY" = 1 ] && { say "Dry run: nothing was started or changed."; exit 0; }
say "Poppy Agent Tester LAB ($MODE) is running: $URL"
if [ "$MODE" = pingone ]; then
  say "Live run against your PingOne environment. The reference Company is at http://127.0.0.1:$CPORT. Press Start flow, then sign in as a user of that environment."
  say "Remove the PingOne objects when you are done: node $DIR/scripts/pingone/teardown.mjs"
elif [ "$MODE" = mock ]; then
  say "This is the explainer with an example run of invented values. For a live sign-in run: sh $DIR/scripts/install.sh --real (needs your own Company and PingFederate, docs/setup.md)."
else
  say "Live run. Type your Company origin and issuer on the page. Sign-in needs the PingFederate policy and https setup in docs/setup.md."
fi
say "Stop it: sh $DIR/scripts/install.sh --stop"
