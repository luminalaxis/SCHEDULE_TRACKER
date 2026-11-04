# 라즈베리파이에 피트보드 올리기

라즈베리파이 한 대에서 피트보드를 24시간 돌리는 방법이에요. 서버는 Node.js 하나로 돌아가고, 따로 설치할 패키지(npm install)가 없어요. `deploy/install.sh` 가 설치와 24시간 운영 설정을 한 번에 해요.

## 1. 준비물

- Raspberry Pi 4 또는 5 (메모리 4GB 이상), 64비트 Raspberry Pi OS (Lite 권장)
- **USB SSD 권장.** SD 카드는 계속 쓰기를 하면 수명이 짧고, 갑자기 망가지면 데이터가 날아갈 수 있어요. 파이 4·5는 USB SSD로 바로 부팅할 수 있어요.
- 정품 전원 어댑터 (파이 4는 5V 3A, 파이 5는 5V 5A). 전원이 불안정하면 데이터베이스가 깨질 수 있어요.
- **유선 랜 권장.** 와이파이도 되지만 끊기는 일이 더 잦아요.

정전이 되어도 전기가 다시 들어오면 파이가 저절로 켜지고 서버도 자동으로 시작해요. 정전이 잦은 곳이면 작은 UPS(보조 전원)를 고려하세요.

### OS 굽기 (Raspberry Pi Imager)

Imager에서 OS를 고른 뒤 **설정 편집**에서:

- 사용자 이름·비밀번호: 아무 이름이나 괜찮아요. 요즘 Raspberry Pi OS에는 예전의 기본 계정 `pi` 가 없고, 설치 스크립트가 지금 로그인한 계정에 맞춰요.
- 호스트 이름: 예를 들어 `fsk-pit` (아래 명령의 `fsk-pit.local`)
- SSH 사용, 시간대 Asia/Seoul, (유선이 아니면) 와이파이

## 2. 설치

노트북에서 파이에 접속해요.

```bash
ssh <사용자 이름>@fsk-pit.local
```

파이에서:

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/luminalaxis/SCHEDULE_TRACKER.git ~/SCHEDULE_TRACKER
cd ~/SCHEDULE_TRACKER
bash deploy/install.sh
```

기본 설치는 서버가 파이 안에서만 받아요. 바깥 접속은 3단계에서 개발자 계정을 만든 뒤 4단계에서 열어요 (도메인이 있으면 Cloudflare Tunnel, 없으면 `--tailscale`).

설치 스크립트가 하는 일:

| 무엇 | 왜 |
|---|---|
| Node.js 22 설치 (없거나 오래됐을 때), 시간대 Asia/Seoul | 서버 실행, 알림(아침 8시 이후)과 자동 백업 시각의 기준 |
| 데이터 폴더 `~/fsk-data` (나만 읽기·쓰기) | 데이터베이스, 첨부 파일, 백업 |
| 서비스 `fsk-pitboard` 등록 | 부팅하면 자동 시작, 꺼지면 3초 뒤 다시 시작 |
| 응답 확인 `fsk-pitboard-watchdog.timer` | 2분마다 `/healthz` 를 확인해서 30초 동안 응답이 없으면 다시 시작 (켜져 있는데 멈춘 경우) |
| 하드웨어 워치독 | 파이 자체가 멈추면 자동 재부팅 |
| 로그 보관 (재부팅해도 남기고 200MB까지) | 왜 멈췄는지 나중에 확인 |
| 보안 업데이트 자동 설치 (unattended-upgrades) | 재부팅은 하지 않아요 |
| 와이파이 절전 끄기 (와이파이일 때만) | 연결 끊김 줄이기 |
| 전원 부족 기록, 데이터가 SD 카드에 있는지 확인 | 경고만 해요 |

여러 번 실행해도 돼요. 포트, 데이터 폴더, 접속 방식은 처음 정한 대로 유지돼요. 옵션은 `bash deploy/install.sh --help` (`--port`, `--data-dir`, `--tailscale` / `--tailscale-private` / `--lan` / `--tunnel`, `--backup-dir`).

## 3. 첫 개발자 계정

**처음 가입하는 사람이 개발자(관리자) 계정**이 돼요. 바깥 접속(4단계)을 열기 전에 개발자 본인이 먼저 가입하세요.

기본 설치는 서버가 파이 안에서만 받으니, 노트북에서 SSH로 잠깐 연결해요.

```bash
ssh -L 8080:127.0.0.1:8080 <사용자 이름>@fsk-pit.local
```

이 창을 열어 둔 채 노트북 브라우저에서 `http://localhost:8080` 을 열고 가입해요. `--lan` 으로 설치했다면 `http://<파이 IP>:8080` 에서 바로 가입하면 돼요.

가입한 뒤 관리 창(`/admin`) → 설정에서 가입 방식이 "승인제" 또는 "초대 코드"인지 확인하세요.

팀원 가입은 같은 접속 주소(같은 와이파이)에서 한 시간에 10명까지 받아요. 회의 때 동아리방 와이파이로 한꺼번에 가입하면 11번째부터 "가입 신청이 너무 많아요"가 나와요. 이때는 휴대폰 데이터로 가입하거나, 개발자가 관리 창 → 사용자에서 계정을 직접 만들어 주세요.

## 4. 바깥에서 접속하기

도메인이 있으면 A(Cloudflare Tunnel), 없으면 B(Tailscale Funnel)를 쓰세요. 둘 다 HTTPS 주소라서 휴대폰에 앱처럼 설치하기(10단계)와 오프라인 열기가 돼요. 두 방식 모두 서버는 파이 안에서만 받고, 바깥 요청은 터널이 들여보내요.

### 방법 A: Cloudflare Tunnel (도메인이 있을 때)

포트포워딩 없이 HTTPS 주소가 생기고, 학교·기숙사 망에서도 대부분 동작해요. Cloudflare에 등록된 도메인이 필요해요.

1. Cloudflare 대시보드 → **Zero Trust** → **Networks** → **Tunnels** 에서 터널을 만들어요 (종류 Cloudflared, 이름 `fsk`). 메뉴 이름은 조금 다를 수 있어요.
2. 설치 화면에서 **Debian**, **arm64** 를 고르면 나오는 명령을 파이에 그대로 붙여 넣어요. 마지막 명령 `sudo cloudflared service install <토큰>` 이 cloudflared를 부팅할 때 자동으로 켜지는 서비스로 등록해요.
3. **Public hostname**(공개 호스트 이름)을 추가해요: `pit.example.com` → 서비스 종류 `HTTP`, 주소 `localhost:8080`.
4. 파이에서 `systemctl status cloudflared` 가 active 인지, 휴대폰에서 `https://pit.example.com` 이 열리는지 확인해요.

도메인이 없을 때 잠깐 테스트만 하려면 `cloudflared tunnel --url http://localhost:8080` 을 실행하면 임시 `trycloudflare.com` 주소가 나와요. 재시작하면 주소가 바뀌니 24시간 운영에는 쓰지 마세요.

### 방법 B: Tailscale Funnel (도메인이 없을 때)

Tailscale이 `https://fsk-pit.<tailnet 이름>.ts.net` 같은 무료 HTTPS 주소를 줘요. 인터넷 어디서나 열리고, **팀원은 아무것도 설치하지 않아요.** Tailscale 계정은 개발자 한 명만 있으면 돼요.

1. 노트북 브라우저에서 [tailscale.com](https://tailscale.com) 에 가입해요 (Google·GitHub 계정 등).
2. 3단계에서 개발자 계정을 만든 다음, 파이에서:

   ```bash
   bash ~/SCHEDULE_TRACKER/deploy/install.sh --tailscale
   ```

   - Tailscale을 설치하고, 로그인 주소가 나오면 노트북 브라우저에서 열어 로그인해요.
   - 처음이면 HTTPS 인증서와 Funnel을 허용하라는 주소가 나와요. 열어서 허용하면 설치가 이어져요.
   - 마지막에 `접속: https://fsk-pit.….ts.net` 이 나와요. 이 주소를 팀에 공유하세요.
3. 휴대폰 와이파이를 끄고 데이터로 그 주소가 열리는지 확인해요.

알아 둘 것:

- 주소 가운데 `tail1234` 같은 부분(tailnet 이름)은 Tailscale 관리 화면의 DNS 메뉴에서 기억하기 쉬운 이름으로 바꿀 수 있어요. 바꾸면 주소가 바뀌니 팀에 알리기 전에 하세요.
- Funnel 트래픽에는 Tailscale이 정한 대역폭 제한이 있어요(수치는 공개되어 있지 않아요). 현황판과 사진·xlsx 정도는 괜찮지만 큰 동영상 첨부는 느릴 수 있어요.
- 인터넷에 공개되는 주소예요. 관리 창 → 설정의 가입 방식을 "승인제"나 "초대 코드"로 두세요.
- 서버는 `TRUST_PROXY=tailscale` 로 돌아요. Tailscale이 넣어 주는 접속 주소만 믿어서, 로그인 시도 제한과 감사 로그가 사람마다 따로 맞게 기록돼요.

### 방법 C: Tailscale 안에서만 (인터넷에 공개하지 않기)

```bash
bash ~/SCHEDULE_TRACKER/deploy/install.sh --tailscale-private
```

Tailscale에 들어온 사람만 같은 `https://….ts.net` 주소로 들어와요. 가장 닫힌 방식이지만 팀원마다 Tailscale 계정과 앱이 필요하고, 쓸 때마다 휴대폰에서 Tailscale을 켜야 해요. 무료 요금제는 사용자 수가 적어서(지금 몇 명인지는 [Tailscale 요금제](https://tailscale.com/pricing) 확인) 30명이 쓰려면 관리 화면에서 파이를 팀원에게 **공유(Share)** 하거나 유료 요금제가 필요해요. 보통은 B를 추천해요.

같은 와이파이 안에서만 쓰는 `--lan` 은 HTTP 주소(`http://<파이 IP>:8080`)라서 앱 설치·오프라인 열기가 안 될 수 있어요.

## 5. 24시간 잘 돌고 있는지 확인

```bash
systemctl status fsk-pitboard           # active (running) 이면 정상
journalctl -u fsk-pitboard -f           # 실시간 로그
journalctl -u fsk-pitboard-watchdog     # 응답이 없어서 다시 시작한 기록
journalctl -b -1 -e                     # 직전 부팅의 마지막 로그 (파이가 혼자 재부팅됐을 때)
vcgencmd get_throttled                  # throttled=0x0 이 아니면 전원이 부족했던 적이 있어요
curl http://127.0.0.1:8080/healthz      # {"ok":true,...}
```

관리 창 개요에서도 가동 시간, 마지막 백업, 디스크 사용량, 경고를 볼 수 있어요.

| 무슨 일이 생기면 | 어떻게 복구돼요 |
|---|---|
| 서버 프로세스가 죽음 | 3초 뒤 자동으로 다시 시작 |
| 켜져 있는데 응답이 없음 | 2분마다 확인해서 30초 동안 응답이 없으면 다시 시작 |
| 파이(운영체제)가 멈춤 | 하드웨어 워치독이 재부팅 |
| 정전 | 전기가 들어오면 파이가 켜지고 서버와 터널(Cloudflare·Tailscale)이 자동으로 시작 |

서버가 꺼진 걸 밖에서 바로 알고 싶으면, 무료 업타임 모니터(UptimeRobot 등)에 바깥 주소 뒤에 `/healthz` 를 붙여 등록해 두세요 (예: `https://pit.example.com/healthz`, `https://fsk-pit.….ts.net/healthz`). 응답이 없으면 메일이나 앱 알림이 와요.

## 6. 백업

- 서버가 매일 새벽 4시 이후 **자동 백업**을 `~/fsk-data/backups/` 에 만들고 14개를 보관해요 (관리 창 → 설정에서 변경).
- 자동 백업(JSON)에는 첨부 파일 자체가 들어가지 않아요. 파이가 고장 나도 데이터가 남도록 **외부 복사**를 꼭 설정하세요.

### 외부 복사 (USB 드라이브, 권장)

1. USB 드라이브(ext4로 포맷)를 꽂고 항상 같은 경로에 연결되게 해요. `lsblk -f` 로 UUID를 확인한 뒤 `sudo nano /etc/fstab` 으로 한 줄 추가:

   ```
   UUID=<드라이브 UUID>  /mnt/backup  ext4  defaults,nofail  0  2
   ```

   `nofail` 이 있어서 드라이브가 빠져 있어도 파이와 서버는 정상으로 켜져요.

   ```bash
   sudo mkdir -p /mnt/backup && sudo systemctl daemon-reload && sudo mount -a
   ```

   ```bash
   sudo mkdir -p /mnt/backup/fsk && sudo chown "$USER": /mnt/backup/fsk
   ```

2. 서버가 그 드라이브에 쓸 수 있게:

   ```bash
   bash ~/SCHEDULE_TRACKER/deploy/install.sh --backup-dir /mnt/backup
   ```

3. 관리 창 → 백업·복원 → 외부 복사에 `/mnt/backup/fsk` 를 적고 **저장**, **지금 복사**.

이후 매일 자동 백업이 끝나면 백업 파일과 새 첨부 파일을 복사해요. 복사본에서는 지우지 않으니(자동 백업은 60개까지 보관) 서버 데이터가 지워져도 남아 있어요. 드라이브가 빠져 있으면 복사가 실패하고, 실패하거나 이틀 넘게 복사가 안 되면 관리 창 개요에 경고가 떠요.

Google Drive 같은 클라우드에도 두려면, 외부 복사 폴더를 `rclone` 으로 올리세요 (`crontab -e`):

```cron
0 5 * * * rclone copy /mnt/backup/fsk gdrive:fsk-backup
```

### 한 파일로 받기

관리 창 → 백업·복원 → **전체 백업 내려받기**는 데이터, 계정, 설정, 첨부 파일을 한 `.tar.gz` 파일로 줘요. 대회 전처럼 중요한 때 받아 두세요.

## 7. 업데이트

```bash
cd ~/SCHEDULE_TRACKER
bash deploy/update.sh
```

새 코드가 있을 때만 업데이트 직전 백업 → 코드 받기 → 서비스 다시 설치·시작 → 응답 확인을 해요. 새 버전이 켜지지 않으면 이전 버전으로 되돌리는 명령을 알려 줘요.

보안 업데이트는 자동으로 설치되지만, Node.js와 cloudflared는 가끔 직접 올려 주세요. 대회 직전에는 피하세요.

```bash
sudo apt update && sudo apt full-upgrade -y && sudo reboot
```

## 8. 문제가 생겼을 때

명령에 나오는 `~/fsk-data` 는 기본 데이터 폴더예요. `--data-dir` 로 바꿨다면 그 폴더로 적으세요.

| 상황 | 해결 |
|---|---|
| 서버가 켜지지 않음 | `journalctl -u fsk-pitboard -n 50` 으로 오류를 확인하고, 고친 뒤 `bash deploy/install.sh` |
| 파이가 혼자 재부팅됨 | `journalctl -b -1 -e` (직전 부팅의 마지막 로그), `vcgencmd get_throttled` (전원) |
| 바깥 주소로 안 열림 | 파이 안에서 `curl http://127.0.0.1:8080/healthz` 로 서버부터 확인. Cloudflare는 `systemctl status cloudflared`, Tailscale은 `sudo tailscale funnel status` (없으면 `bash deploy/install.sh --tailscale`) |
| 개발자 비밀번호를 잊음 | `DATA_DIR=~/fsk-data npm run admin -- reset-password <아이디>` |
| 계정 목록 확인 | `DATA_DIR=~/fsk-data npm run admin -- list-users` |
| 새 개발자 계정 만들기 | `DATA_DIR=~/fsk-data npm run admin -- create-user <아이디> developer <이름>` |
| 직책 있는 계정 만들기 | `... create-user <아이디> member\|team_lead\|vice_lead\|part_lead <이름> <부서>` (developer가 아니면 부서 필수: battery, circuit, chassis, aero, powertrain) |
| 파이가 고장 나서 새 파이로 옮김 (전체 백업 파일이 있음) | 새 파이에 2단계(설치)를 한 뒤 `sudo systemctl stop fsk-pitboard` → `DATA_DIR=~/fsk-data npm run admin -- restore fsk-full-….tar.gz` (계정·데이터·설정·첨부 파일 모두 복원) → `sudo systemctl start fsk-pitboard` |
| 외부 복사본(USB)만 있음 | 새 파이에 2단계 → `sudo systemctl stop fsk-pitboard` → `mkdir -p ~/fsk-data/assets && cp /mnt/backup/fsk/assets/* ~/fsk-data/assets/` → `DATA_DIR=~/fsk-data npm run admin -- restore /mnt/backup/fsk/backups/<가장 최근>.json` → `sudo systemctl start fsk-pitboard` |
| 백업 JSON만 있음 | 서버를 멈추고 `DATA_DIR=~/fsk-data npm run admin -- restore 백업파일.json` (계정·데이터·설정 복원, 첨부 파일은 따로) |
| 알림이 안 옴 | 관리 창 → 설정 → 알림 → **지금 마감·일정 알림 확인** / **테스트 보내기**. 시간대가 맞는지 `timedatectl` 확인 |

## 9. claude.ai 피트보드에서 데이터 옮기기

1. 팀원들이 먼저 이 서버에 가입하고, 개발자가 승인해요.
2. claude.ai에서 Claude에게 "피트보드 Artifact 데이터를 내보내 줘"라고 요청하면 `{ docs: [{ path, data }] }` 형식 JSON을 만들어 줘요.
3. 관리 창 → 백업·복원 → **claude.ai 피트보드에서 옮기기**에서 파일을 고르고 **계정 확인**을 눌러요. 사비 정산·총무 기록·점검 체크에 남은 claude.ai 계정이 이름과 함께 나와요. 이름이 같은 서버 계정은 미리 골라 두니, 확인하고 나머지를 짝지어요.
4. **가져오기**를 누르면 그 사람의 사비 내역서, 총무 처리 기록, 변경 이력이 새 계정으로 옮겨져요. 가져오기 직전 상태는 자동으로 백업돼요.

첨부 파일(사진, 도면, 영수증)은 claude.ai 파일 저장소에 있어서 함께 옮겨지지 않아요. 필요한 파일은 다시 올려 주세요.

## 10. 노트북에서 쓰던 피트보드 옮겨 오기

Windows 노트북([WINDOWS.md](WINDOWS.md))에서 Tailscale Funnel로 쓰던 피트보드를 파이로 옮겨요. 주소, 계정과 비밀번호, 데이터, 첨부 파일, 설정이 모두 그대로예요.

1. **미리 공지하세요.** 백업한 뒤에 들어온 기록은 옮겨지지 않아요.
2. **노트북에서 백업:** `tailscale funnel --https=443 off` 로 바깥 접속을 막고, 노트북 브라우저로 `http://localhost:8080/admin` → 백업 · 복원 → **전체 백업 내려받기**. 받은 뒤 서버 창을 꺼요.
3. **파이 준비:** 2단계(`bash deploy/install.sh`)만 해요. 가입은 하지 않아도 돼요.
4. **파이에서 복원:** 백업 파일을 파이로 옮기고(USB, 또는 노트북에서 `scp fsk-full-….tar.gz <사용자 이름>@fsk-pit.local:~`):

   ```bash
   sudo systemctl stop fsk-pitboard
   cd ~/SCHEDULE_TRACKER
   DATA_DIR=~/fsk-data npm run admin -- restore ~/fsk-full-….tar.gz   # 파이에서 이미 가입했다면 끝에 --force
   sudo systemctl start fsk-pitboard
   ```

5. **주소 넘기기:** Tailscale 관리 화면 → Machines에서 **노트북(pitboard)을 먼저 삭제**해요. 파이에서 `bash deploy/install.sh --tailscale` 로 Tailscale에 로그인한 뒤 `sudo tailscale set --hostname=pitboard` 로 이름을 맞추고, `bash deploy/install.sh --tailscale` 를 한 번 더 실행해요. 같은 이름(`pitboard`)이라 주소가 그대로예요. 노트북을 지우지 않으면 파이가 `pitboard-1` 같은 다른 이름을 받아요.
6. **확인:** 주소로 들어가 로그인해요. 복원하면 로그인 상태가 초기화돼서 팀원도 모두 한 번씩 다시 로그인해야 해요(비밀번호는 그대로). 노트북에서 외부 복사 폴더를 정해 뒀다면 Windows 경로라서, 관리 창에서 파이 경로(예: `/media/<사용자 이름>/BACKUP/fsk`)로 바꿔요.

서버 두 대가 같은 주소에 동시에 붙어 있으면 안 돼요. 데이터가 다른 두 서버를 팀원들이 섞어 쓰게 돼요. 노트북을 다시 켜더라도 Funnel은 꺼 둔 채로 두세요.

## 11. 휴대폰에 앱처럼 설치

HTTPS 주소(4단계의 Cloudflare Tunnel 또는 Tailscale)로 접속해야 해요.

- 안드로이드(Chrome): 메뉴 → **홈 화면에 추가** (또는 "앱 설치")
- 아이폰(Safari): 공유 → **홈 화면에 추가**

한 번 연 휴대폰은 트랙처럼 신호가 약한 곳에서도 열리고, 그동안 체크한 점검·기록은 연결되면 자동으로 올라가요.

## 보안 체크리스트

- [ ] 외부 공개는 HTTPS(Cloudflare Tunnel 또는 Tailscale Funnel)로만, 설치는 `--lan` 없이 (서버는 파이 안에서만 받음)
- [ ] 바깥 접속을 열기 전에 개발자 계정부터 만들기 (처음 가입하는 사람이 개발자)
- [ ] 관리 창 → 설정에서 가입 방식을 "승인제" 또는 "초대 코드"로
- [ ] 개발자 계정은 강한 비밀번호, 개발자는 꼭 필요한 사람만
- [ ] 파이 로그인 계정도 강한 비밀번호 (SSH)
- [ ] 외부 복사(USB)가 매일 도는지 관리 창 개요에서 확인
- [ ] 같은 휴대폰·노트북을 여러 사람이 쓰면 다 쓴 뒤 로그아웃 (이 기기에 저장된 데이터가 지워져요)
- [ ] 이 저장소는 공개 저장소예요. `data/` 폴더나 백업 파일은 절대 커밋하지 않기 (`.gitignore`에 있음)

## 참고: 스크립트 없이 설치하기

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo timedatectl set-timezone Asia/Seoul
mkdir -p ~/fsk-data && chmod 700 ~/fsk-data
sudo cp deploy/fsk-pitboard.service /etc/systemd/system/
sudo nano /etc/systemd/system/fsk-pitboard.service   # User, WorkingDirectory, DATA_DIR, ReadWritePaths 를 내 계정과 폴더로
sudo systemctl daemon-reload
sudo systemctl enable --now fsk-pitboard
```

응답 확인 타이머는 `deploy/fsk-pitboard-watchdog.service`·`.timer` 를 같은 폴더에 복사하고 `sudo systemctl enable --now fsk-pitboard-watchdog.timer` (포트가 8080이 아니면 주소를 고치기). 서버만 잠깐 띄워 보려면 `PORT=8080 HOST=0.0.0.0 DATA_DIR=~/fsk-data npm start`.
