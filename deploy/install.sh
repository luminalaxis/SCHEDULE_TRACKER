#!/usr/bin/env bash
# FSK 피트보드를 라즈베리파이 한 대에 24시간 서버로 설치해요. 다시 실행해도 돼요(정한 설정은 그대로 두고 갱신해요).
#   bash deploy/install.sh                  바깥 접속은 Cloudflare Tunnel로 (서버는 파이 안에서만 받음, 도메인 필요)
#   bash deploy/install.sh --tailscale      도메인 없이 Tailscale Funnel로 https://<파이>.<tailnet>.ts.net 공개 주소
#   bash deploy/install.sh --tailscale-private   Tailscale 안(공유받은 사람)에서만 https 주소로
#   bash deploy/install.sh --lan            같은 와이파이 안에서 http://<파이 IP>:8080 으로 바로 접속
#   bash deploy/install.sh --tunnel         다른 방식으로 쓰다가 Cloudflare Tunnel 방식으로 돌아가기
#   bash deploy/install.sh --backup-dir /mnt/backup    외부 복사(USB 드라이브) 폴더에 쓸 수 있게
#   bash deploy/install.sh --port 8080 --data-dir ~/fsk-data
#   bash deploy/install.sh --print-unit     설치하지 않고 만들어질 서비스 파일만 보기
# 자세한 안내: deploy/RASPBERRY_PI.md
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UNIT=/etc/systemd/system/fsk-pitboard.service
DROPIN=/etc/systemd/system/fsk-pitboard.service.d/backup-dir.conf
MIN_NODE=$(sed -n 's/.*"node": *">=\([0-9.]*\)".*/\1/p' "$REPO/package.json"); MIN_NODE=${MIN_NODE:-22.13}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m주의:\033[0m %s\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
need() { [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 다음에 값을 적어 주세요."; }

MODE="" TS="" PORT="" DATA="" BACKUP="" PRINT=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --lan) MODE=lan ;;
    --tunnel) MODE=tunnel ;;
    --tailscale) MODE=tailscale TS=funnel ;;
    --tailscale-private) MODE=tailscale TS=serve ;;
    --port) need "$@"; PORT=$2; shift ;;
    --data-dir) need "$@"; DATA=$2; shift ;;
    --backup-dir) need "$@"; BACKUP=$2; shift ;;
    --print-unit) PRINT=1 ;;
    -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "모르는 옵션이에요: $1 (bash deploy/install.sh --help)" ;;
  esac
  shift
done

# Settings: what was given now, else what the installed service already has, else defaults.
current() { if [ -f "$UNIT" ]; then sed -n "s/^Environment=$1=//p" "$UNIT" | tail -n 1; fi; }
U=$(id -un)
# (Tailscale keeps its own serve/funnel setting, so a plain re-run leaves it as it is.)
if [ -z "$MODE" ]; then
  if [ "$(current HOST)" = 0.0.0.0 ]; then MODE=lan; elif [ "$(current TRUST_PROXY)" = tailscale ]; then MODE=tailscale; else MODE=tunnel; fi
fi
PORT=${PORT:-$(current PORT)}; PORT=${PORT:-8080}
DATA=${DATA:-$(current DATA_DIR)}; DATA=${DATA:-$HOME/fsk-data}
DATA=$(realpath -m -- "${DATA/#\~/$HOME}")
[ -z "$BACKUP" ] || BACKUP=$(realpath -m -- "${BACKUP/#\~/$HOME}")
case "$MODE" in
  lan) HOST=0.0.0.0 TRUST_PROXY=0 ;;
  tailscale) HOST=127.0.0.1 TRUST_PROXY=tailscale ;;
  *) HOST=127.0.0.1 TRUST_PROXY=1 ;;
esac
NODE=$(command -v node || echo /usr/bin/node)

case "$PORT" in ''|*[!0-9]*) die "포트는 숫자로 적어 주세요: $PORT" ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "포트는 1~65535 사이로 적어 주세요: $PORT"
# systemd unit lines take these paths as they are, so keep them to plain characters
plain() { case "$1" in /*) ;; *) return 1 ;; esac; case "$1" in *[!A-Za-z0-9._/-]*) return 1 ;; esac; }
for p in "$REPO" "$DATA" ${BACKUP:+"$BACKUP"}; do plain "$p" || die "경로에는 영문·숫자와 . _ - / 만 써 주세요: $p"; done
case "$DATA/" in "$REPO"/*) die "데이터 폴더는 코드 폴더($REPO) 밖에 두세요 (예: ~/fsk-data). 코드를 정리하다 함께 지워지지 않게요." ;; esac
if [ -n "$BACKUP" ]; then case "$BACKUP/" in "$DATA"/*) die "외부 복사 폴더는 데이터 폴더 밖이어야 해요." ;; esac; fi

render_unit() {
  local lan_note=""
  [ "$MODE" = lan ] && lan_note='s|^# Listen only on the Pi itself.*|# --lan: listen on every network (same Wi-Fi), with no tunnel in front.|'
  sed -e "s|^User=.*|User=$U|" \
      -e "s|^WorkingDirectory=.*|WorkingDirectory=$REPO|" \
      -e "s|^Environment=PORT=.*|Environment=PORT=$PORT|" \
      -e "s|^Environment=HOST=.*|Environment=HOST=$HOST|" \
      -e "s|^Environment=DATA_DIR=.*|Environment=DATA_DIR=$DATA|" \
      -e "s|^Environment=TRUST_PROXY=.*|Environment=TRUST_PROXY=$TRUST_PROXY|" \
      -e "s|^ExecStart=[^ ]*|ExecStart=$NODE|" \
      -e "s|^ReadWritePaths=.*|ReadWritePaths=$DATA|" \
      ${lan_note:+-e "$lan_note"} \
      "$REPO/deploy/fsk-pitboard.service"
}
render_watchdog() { sed "s|http://127.0.0.1:[0-9]*/healthz|http://127.0.0.1:$PORT/healthz|" "$REPO/deploy/fsk-pitboard-watchdog.service"; }
unit=$(render_unit)
for want in "User=$U" "WorkingDirectory=$REPO" "Environment=PORT=$PORT" "Environment=HOST=$HOST" "Environment=DATA_DIR=$DATA" \
            "Environment=TRUST_PROXY=$TRUST_PROXY" "ReadWritePaths=$DATA"; do
  grep -qxF -- "$want" <<<"$unit" || die "deploy/fsk-pitboard.service 에서 '$want' 줄을 만들지 못했어요. 그 파일의 줄 이름이 바뀌었는지 확인하세요."
done
grep -q "^ExecStart=$NODE " <<<"$unit" || die "deploy/fsk-pitboard.service 의 ExecStart 줄을 찾지 못했어요."
render_watchdog | grep -qF "http://127.0.0.1:$PORT/healthz" || die "deploy/fsk-pitboard-watchdog.service 의 응답 확인 주소를 찾지 못했어요."

if [ "$PRINT" = 1 ]; then printf '%s\n' "$unit"; exit 0; fi

# ---------- install ----------
[ "$(id -u)" -ne 0 ] || die "sudo 없이 실행하세요. 서버는 지금 로그인한 계정으로 돌아요:  bash deploy/install.sh"
command -v systemctl >/dev/null || die "systemd 가 있는 리눅스(Raspberry Pi OS)에서 실행하세요."
command -v sudo >/dev/null || die "sudo 가 필요해요."

say "FSK 피트보드 설치"
info "계정 $U · 코드 $REPO · 데이터 $DATA · 포트 $PORT"
case "$MODE$TS" in
  lan) info "접속 방식: 같은 와이파이에서 바로 (--lan)" ;;
  tailscalefunnel) info "접속 방식: Tailscale Funnel 공개 주소 (--tailscale)" ;;
  tailscaleserve) info "접속 방식: Tailscale 안에서만 (--tailscale-private)" ;;
  tailscale) info "접속 방식: Tailscale (지금 설정 유지)" ;;
  *) info "접속 방식: 파이 안에서만 받고 Cloudflare Tunnel로 바깥 연결" ;;
esac
sudo -v

case "$(uname -m)" in aarch64|arm64|x86_64) ;; *) warn "64비트 OS를 권장해요 (지금 $(uname -m)). Node.js $MIN_NODE 이상이 설치되지 않을 수 있어요." ;; esac

APT_READY=0
apt_install() {
  [ "$APT_READY" = 1 ] || { sudo apt-get update -q; APT_READY=1; }
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@"
}
# put <file> <content>: write a root-owned file. Returns 1 when it already had that content (nothing to reload).
put() {
  local tmp; tmp=$(mktemp)
  printf '%s\n' "$2" >"$tmp"
  if sudo cmp -s "$tmp" "$1" 2>/dev/null; then rm -f "$tmp"; return 1; fi
  sudo install -D -m 644 "$tmp" "$1" || { rm -f "$tmp"; die "$1 을(를) 쓰지 못했어요."; }
  rm -f "$tmp"
}

say "1. Node.js · 시간대"
node_ok() { command -v node >/dev/null 2>&1 && printf '%s\n%s\n' "$MIN_NODE" "$(node -p process.versions.node)" | sort -V -C; }
command -v curl >/dev/null || apt_install curl
if node_ok; then
  info "Node.js $(node -v) 있음"
else
  info "Node.js ${MIN_NODE%%.*} 설치 (NodeSource)"
  apt_install ca-certificates curl gnupg
  curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE%%.*}.x" | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs
  node_ok || die "Node.js $MIN_NODE 이상을 설치하지 못했어요. node -v 로 확인하세요."
  NODE=$(command -v node); unit=$(render_unit)
fi
case "$NODE" in "$HOME"/*) warn "홈 폴더의 node($NODE)를 써요 (nvm 등). node 버전을 바꾸면 이 스크립트를 다시 실행하세요." ;; esac
if [ "$(timedatectl show -p Timezone --value 2>/dev/null || true)" != Asia/Seoul ]; then
  sudo timedatectl set-timezone Asia/Seoul && info "시간대를 Asia/Seoul 로 맞췄어요"
fi

say "2. 데이터 폴더 · 서비스 등록"
mkdir -p "$DATA" 2>/dev/null || sudo install -d -o "$U" -g "$(id -gn)" -m 700 "$DATA"
[ -O "$DATA" ] || sudo chown "$U:$(id -gn)" "$DATA"   # e.g. a folder made by root on an SSD
chmod 700 "$DATA"; [ -w "$DATA" ] || die "데이터 폴더에 쓸 수 없어요: $DATA"
put "$UNIT" "$unit" || true
put /etc/systemd/system/fsk-pitboard-watchdog.service "$(render_watchdog)" || true
put /etc/systemd/system/fsk-pitboard-watchdog.timer "$(cat "$REPO/deploy/fsk-pitboard-watchdog.timer")" || true
if [ -n "$BACKUP" ]; then
  put "$DROPIN" "[Service]
# Off-site copy folder (관리 창 → 백업·복원 → 외부 복사), from deploy/install.sh --backup-dir.
# The \"-\" lets the server start while the drive is unplugged.
ReadWritePaths=-$BACKUP" || true
fi
[ ! -f "$DROPIN" ] || info "외부 복사 폴더: $(sed -n 's/^ReadWritePaths=-//p' "$DROPIN")"
info "부팅하면 자동으로 켜지고, 꺼지면 3초 뒤 다시 켜져요. 2분마다 응답을 확인해 멈췄으면 다시 시작해요."

say "3. 24시간 운영 설정"
REEXEC=0
if [ -e /dev/watchdog ]; then
  put /etc/systemd/system.conf.d/90-fsk-watchdog.conf "[Manager]
# deploy/install.sh: reboot the Pi when the system itself hangs. The Pi watchdog allows about 15 s at most.
RuntimeWatchdogSec=14s" && REEXEC=1
  info "하드웨어 워치독: 파이 자체가 멈추면 자동으로 재부팅해요"
fi
if put /etc/systemd/journald.conf.d/90-fsk.conf "[Journal]
# deploy/install.sh: keep logs across reboots (to see why it stopped) but cap their size for the SD card.
Storage=persistent
SystemMaxUse=200M"; then sudo systemctl restart systemd-journald; fi
info "로그는 재부팅해도 남기고 200MB까지만 보관해요"
dpkg -s unattended-upgrades >/dev/null 2>&1 || apt_install unattended-upgrades
[ -f /etc/apt/apt.conf.d/20auto-upgrades ] || put /etc/apt/apt.conf.d/20auto-upgrades 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";' || true
info "보안 업데이트는 자동으로 설치해요 (재부팅은 하지 않아요)"
dev=$(ip -o route show default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}' || true)
case "$dev" in wl*)
  warn "와이파이($dev)로 연결돼 있어요. 24시간 서버는 유선 랜이 더 안정적이에요."
  if command -v nmcli >/dev/null; then
    con=$(nmcli -g GENERAL.CONNECTION device show "$dev" 2>/dev/null || true)
    [ -z "$con" ] || sudo nmcli connection modify "$con" 802-11-wireless.powersave 2 2>/dev/null || true
  fi
  sudo iw dev "$dev" set power_save off 2>/dev/null || true
  info "와이파이 절전을 껐어요 (연결이 끊기는 일을 줄여요)" ;;
esac
if command -v vcgencmd >/dev/null; then
  t=$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2 || true)
  case "$t" in ""|0x0) info "전원: 문제 기록 없음" ;;
    *) warn "전원이 부족했던 기록이 있어요 (get_throttled=$t). 정품 어댑터(파이 4는 5V 3A, 파이 5는 5V 5A)를 쓰세요. 전원 부족은 데이터베이스가 깨지는 흔한 원인이에요." ;;
  esac
fi
case "$(findmnt -n -o SOURCE --target "$DATA" 2>/dev/null || true)" in
  /dev/mmcblk*) warn "데이터가 SD 카드에 있어요. 오래 쓰면 SD 카드가 망가질 수 있으니 USB SSD를 쓰거나, 적어도 외부 복사(USB)를 꼭 켜 두세요." ;;
esac

say "4. 서버 시작"
sudo systemctl daemon-reload
[ "$REEXEC" = 0 ] || sudo systemctl daemon-reexec
sudo systemctl enable --quiet fsk-pitboard fsk-pitboard-watchdog.timer
sudo systemctl restart fsk-pitboard
sudo systemctl restart fsk-pitboard-watchdog.timer
BASE="http://127.0.0.1:$PORT"
for _ in $(seq 1 30); do curl -fsS -m 2 -o /dev/null "$BASE/healthz" 2>/dev/null && break; sleep 1; done
if ! health=$(curl -fsS -m 5 "$BASE/healthz" 2>/dev/null); then
  sudo journalctl -u fsk-pitboard -n 30 --no-pager || true
  die "서버가 응답하지 않아요. 위 로그를 확인하세요 (systemctl status fsk-pitboard)."
fi
VERSION=$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' <<<"$health")
IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
FIRST=0; curl -fsS -m 5 "$BASE/api/auth/config" 2>/dev/null | grep -q '"firstUser":true' && FIRST=1

ts_url() { tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{const n=JSON.parse(s).Self.DNSName.replace(/\.$/,"");if(n)console.log("https://"+n)}catch{}})' || true; }
if [ -n "$TS" ]; then
  say "5. Tailscale"
  if ! command -v tailscale >/dev/null; then
    info "Tailscale 설치"
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
  if [ "$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).BackendState)}catch{}})' || true)" != Running ]; then
    info "아래에 나오는 주소를 열어 Tailscale에 로그인하세요 (개발자 본인 계정)."
    sudo tailscale up
  fi
  if [ "$FIRST" = 1 ]; then
    warn "아직 개발자 계정이 없어서 Tailscale 주소는 열지 않았어요. 아래처럼 먼저 가입한 뒤  bash deploy/install.sh --$( [ "$TS" = funnel ] && echo tailscale || echo tailscale-private )  을 한 번 더 실행하세요."
  else
    # one front door only: drop an earlier serve/funnel setting, then open the one asked for
    sudo tailscale serve reset >/dev/null 2>&1 || true
    if [ "$TS" = funnel ]; then
      info "Funnel을 켜요. 처음이면 HTTPS 인증서·Funnel을 허용하는 주소가 나오니 열어서 허용하세요."
      sudo tailscale funnel --bg "$PORT" || die "Funnel을 켜지 못했어요. 위 메시지를 확인하세요. Tailscale 안에서만 쓰려면  bash deploy/install.sh --tailscale-private"
    else
      info "Serve를 켜요. 처음이면 HTTPS 인증서를 허용하는 주소가 나오니 열어서 허용하세요."
      sudo tailscale serve --bg "$PORT" || die "Tailscale Serve를 켜지 못했어요. 위 메시지를 확인하세요."
    fi
  fi
fi

say "다 됐어요. 피트보드 ${VERSION:-?} 이(가) 돌고 있어요."
case "$MODE" in
  lan) info "접속: http://${IP:-<파이 IP>}:$PORT  (같은 와이파이 안에서)" ;;
  tailscale)
    TSURL=$(ts_url)
    if sudo tailscale serve status --json 2>/dev/null | grep -q '"AllowFunnel"'; then info "접속: ${TSURL:-https://<파이>.<tailnet>.ts.net}  (인터넷 어디서나, 팀원은 설치할 것 없음)"
    elif sudo tailscale serve status 2>/dev/null | grep -q "127.0.0.1:$PORT"; then info "접속: ${TSURL:-https://<파이>.<tailnet>.ts.net}  (Tailscale에 들어온 사람·공유받은 사람만)"
    else info "Tailscale 주소가 아직 열려 있지 않아요:  bash deploy/install.sh --tailscale"; fi ;;
  *) info "지금은 파이 안($BASE)에서만 받아요. 바깥 접속은 Cloudflare Tunnel을 연결하세요 (deploy/RASPBERRY_PI.md 4단계)." ;;
esac
if [ "$FIRST" = 1 ]; then
  warn "아직 계정이 없어요. 처음 가입하는 사람이 개발자(관리자)가 되니, 바깥 주소를 열기 전에 먼저 가입하세요."
  if [ "$MODE" = lan ]; then
    info "브라우저에서 http://${IP:-<파이 IP>}:$PORT 을 열고 가입"
  else
    info "노트북 터미널에서:  ssh -L $PORT:127.0.0.1:$PORT $U@${IP:-<파이 IP>}"
    info "그대로 둔 채 노트북 브라우저에서 http://localhost:$PORT 을 열고 가입"
  fi
fi
info "상태: systemctl status fsk-pitboard   로그: journalctl -u fsk-pitboard -f"
info "업데이트: bash deploy/update.sh"
