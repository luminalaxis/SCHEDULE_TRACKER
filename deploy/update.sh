#!/usr/bin/env bash
# FSK 피트보드 업데이트: 새 코드가 있으면 백업 → 코드 받기 → 서비스 다시 설치·시작 → 응답 확인.
#   bash deploy/update.sh
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UNIT=/etc/systemd/system/fsk-pitboard.service
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "sudo 없이 실행하세요:  bash deploy/update.sh"
[ -f "$UNIT" ] || die "아직 설치되지 않았어요. 먼저  bash deploy/install.sh"
cd "$REPO"
DATA=$(sed -n 's/^Environment=DATA_DIR=//p' "$UNIT" | tail -n 1)
NODE=$(sed -n 's/^ExecStart=\([^ ]*\) .*/\1/p' "$UNIT" | tail -n 1)

echo "새 코드 확인"
git fetch --quiet origin || die "GitHub에 연결하지 못했어요. 인터넷 연결을 확인하세요."
git rev-parse --verify --quiet '@{u}' >/dev/null || die "따라갈 브랜치가 없어요. git checkout main 후 다시 실행하세요."
old=$(git rev-parse HEAD)
if [ "$old" = "$(git rev-parse '@{u}')" ]; then echo "이미 최신이에요 ($(git log -1 --format='%h %s'))."; exit 0; fi
git log --oneline "HEAD..@{u}" | head -n 20

echo "업데이트 전 백업"
backup=$(DATA_DIR="$DATA" "$NODE" --disable-warning=ExperimentalWarning server/cli.js backup) || die "백업하지 못했어요. 업데이트를 멈춰요."
echo "  $backup"

echo "코드 받기"
git merge --ff-only --quiet '@{u}' || die "코드를 받지 못했어요. 파이에서 파일을 직접 고쳤다면 git status 로 확인하세요."

if ! bash "$REPO/deploy/install.sh"; then
  echo
  echo "새 버전이 제대로 켜지지 않았어요. 이전 버전으로 되돌리려면:"
  echo "  cd $REPO && git reset --hard $old && bash deploy/install.sh"
  echo "데이터는 업데이트 직전에 백업했어요 (위 '백업했어요' 파일, 관리 창 → 백업·복원)."
  exit 1
fi
