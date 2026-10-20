# 라즈베리파이에 피트보드 올리기

라즈베리파이 한 대에서 피트보드를 24시간 돌리는 방법입니다. 서버는 Node.js 하나로 돌아가고, 따로 설치할 패키지(npm install)가 없습니다.

## 1. 준비물

- Raspberry Pi 4 또는 5 (메모리 4GB 이상), 64비트 Raspberry Pi OS (Lite 권장)
- **USB SSD 권장.** SD 카드는 계속 쓰기를 하면 수명이 짧고, 갑자기 망가지면 데이터가 날아갈 수 있어요.
- 정품 전원 어댑터 (전원이 불안정하면 데이터베이스가 깨질 수 있어요)

## 2. Node.js 22 설치

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
node -v   # v22.13 이상이어야 해요
sudo timedatectl set-timezone Asia/Seoul   # 알림(아침 8시 이후)과 자동 백업 시각의 기준
```

## 3. 코드 받기와 첫 실행

```bash
cd ~
git clone https://github.com/luminalaxis/SCHEDULE_TRACKER.git
cd SCHEDULE_TRACKER
mkdir -p ~/fsk-data
PORT=8080 HOST=0.0.0.0 DATA_DIR=~/fsk-data npm start
```

같은 와이파이에 있는 컴퓨터에서 `http://<파이 IP>:8080` 에 들어가면 로그인 화면이 나와요. **처음 가입하는 사람이 개발자(관리자) 계정**이 되니, 개발자 본인이 먼저 가입하세요. 확인했으면 `Ctrl+C`로 끕니다.

## 4. 부팅할 때 자동 실행

```bash
sudo cp deploy/fsk-pitboard.service /etc/systemd/system/
sudo nano /etc/systemd/system/fsk-pitboard.service   # 사용자 이름(pi)과 경로가 다르면 고치기
sudo systemctl daemon-reload
sudo systemctl enable --now fsk-pitboard
systemctl status fsk-pitboard        # 상태 확인
journalctl -u fsk-pitboard -f        # 로그 보기
```

서비스 설정은 `HOST=127.0.0.1` 이라 파이 안에서만 접속돼요. 바깥에서 들어오게 하려면 5단계를 하세요.

## 5. 바깥에서 접속하기

### 방법 A: Cloudflare Tunnel (추천)

포트포워딩 없이 HTTPS 주소가 생기고, 학교·기숙사 망에서도 대부분 동작해요. Cloudflare에 등록된 도메인이 필요해요.

```bash
# cloudflared 설치 (arm64)
curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared.deb

cloudflared tunnel login                       # 브라우저에서 도메인 선택
cloudflared tunnel create fsk
cloudflared tunnel route dns fsk pit.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: fsk
credentials-file: /home/pi/.cloudflared/<터널ID>.json
ingress:
  - hostname: pit.example.com
    service: http://localhost:8080
  - service: http_status:404
```

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

도메인이 없을 때 잠깐 테스트만 하려면 `cloudflared tunnel --url http://localhost:8080` 을 실행하면 임시 `trycloudflare.com` 주소가 나와요 (재시작하면 바뀜).

### 방법 B: Tailscale (팀원만 접속)

팀원 모두가 Tailscale 앱을 깔고 같은 네트워크에 들어오는 방식이에요. 인터넷에 공개되지 않아 가장 안전해요. 이 경우 서비스 파일에서 `HOST=0.0.0.0`, `TRUST_PROXY=0` 으로 바꾸세요.

## 6. 백업

- 서버가 매일 새벽 4시 이후 **자동 백업**을 `~/fsk-data/backups/` 에 만들고 14개를 보관해요 (관리 창 → 설정에서 변경).
- 자동 백업(JSON)에는 첨부 파일 자체가 들어가지 않아요. 파이가 고장 나도 데이터가 남도록 **외부 복사**를 꼭 설정하세요.

### 외부 복사 (USB 드라이브, 권장)

1. USB 드라이브를 꽂고 항상 같은 경로에 연결되게 해요. `lsblk -f` 로 UUID를 확인한 뒤 `/etc/fstab` 에 한 줄 추가:

   ```
   UUID=<드라이브 UUID>  /media/pi/BACKUP  ext4  defaults,nofail  0  2
   ```

   ```bash
   sudo mkdir -p /media/pi/BACKUP && sudo mount -a && sudo mkdir -p /media/pi/BACKUP/fsk && sudo chown pi: /media/pi/BACKUP/fsk
   ```

2. 서비스가 그 폴더에 쓸 수 있게 `/etc/systemd/system/fsk-pitboard.service` 의 `# ReadWritePaths=/media/pi/BACKUP` 줄 앞의 `#` 을 지우고 `sudo systemctl daemon-reload && sudo systemctl restart fsk-pitboard`.
3. 관리 창 → 백업·복원 → 외부 복사에 `/media/pi/BACKUP/fsk` 를 적고 **저장**, **지금 복사**.

이후 매일 자동 백업이 끝나면 백업 파일과 새 첨부 파일을 복사해요. 복사본에서는 지우지 않으니(자동 백업은 60개까지 보관) 서버 데이터가 지워져도 남아 있어요. 실패하거나 이틀 넘게 복사가 안 되면 관리 창 개요에 경고가 떠요.

Google Drive 같은 클라우드에도 두려면, 외부 복사 폴더를 `rclone` 으로 올리세요 (`crontab -e`):

```cron
0 5 * * * rclone copy /media/pi/BACKUP/fsk gdrive:fsk-backup
```

### 한 파일로 받기

관리 창 → 백업·복원 → **전체 백업 내려받기**는 데이터, 계정, 설정, 첨부 파일을 한 `.tar.gz` 파일로 줘요. 대회 전처럼 중요한 때 받아 두세요.

## 7. 업데이트

```bash
cd ~/SCHEDULE_TRACKER
git pull
sudo systemctl restart fsk-pitboard
```

## 8. 문제가 생겼을 때

| 상황 | 해결 |
|---|---|
| 개발자 비밀번호를 잊음 | `DATA_DIR=~/fsk-data npm run admin -- reset-password <아이디>` |
| 계정 목록 확인 | `DATA_DIR=~/fsk-data npm run admin -- list-users` |
| 새 개발자 계정 만들기 | `DATA_DIR=~/fsk-data npm run admin -- create-user <아이디> developer <이름>` |
| 직책 있는 계정 만들기 | `... create-user <아이디> member\|team_lead\|vice_lead\|part_lead <이름> <부서>` (developer가 아니면 부서 필수: battery, circuit, chassis, aero, powertrain) |
| 파이가 고장 나서 새 파이로 옮김 (전체 백업 파일이 있음) | 새 파이에 2~4단계를 한 뒤 `DATA_DIR=~/fsk-data npm run admin -- restore fsk-full-….tar.gz` (계정·데이터·설정·첨부 파일 모두 복원) |
| 외부 복사본(USB)만 있음 | 새 파이에 2~4단계 → `mkdir -p ~/fsk-data/assets && cp /media/pi/BACKUP/fsk/assets/* ~/fsk-data/assets/` → `DATA_DIR=~/fsk-data npm run admin -- restore /media/pi/BACKUP/fsk/backups/<가장 최근>.json` |
| 백업 JSON만 있음 | `DATA_DIR=~/fsk-data npm run admin -- restore 백업파일.json` (계정·데이터·설정 복원, 첨부 파일은 따로) |
| 알림이 안 옴 | 관리 창 → 설정 → 알림 → **지금 마감·일정 알림 확인** / **테스트 보내기**. 시간대가 맞는지 `timedatectl` 확인 |

## 9. claude.ai 피트보드에서 데이터 옮기기

1. 팀원들이 먼저 이 서버에 가입하고, 개발자가 승인해요.
2. claude.ai에서 Claude에게 "피트보드 Artifact 데이터를 내보내 줘"라고 요청하면 `{ docs: [{ path, data }] }` 형식 JSON을 만들어 줘요.
3. 관리 창 → 백업·복원 → **claude.ai 피트보드에서 옮기기**에서 파일을 고르고 **계정 확인**을 눌러요. 사비 정산·총무 기록·점검 체크에 남은 claude.ai 계정이 이름과 함께 나와요. 이름이 같은 서버 계정은 미리 골라 두니, 확인하고 나머지를 짝지어요.
4. **가져오기**를 누르면 그 사람의 사비 내역서, 총무 처리 기록, 변경 이력이 새 계정으로 옮겨져요. 가져오기 직전 상태는 자동으로 백업돼요.

첨부 파일(사진, 도면, 영수증)은 claude.ai 파일 저장소에 있어서 함께 옮겨지지 않아요. 필요한 파일은 다시 올려 주세요.

## 10. 휴대폰에 앱처럼 설치

HTTPS 주소(5단계의 Cloudflare Tunnel)로 접속해야 해요.

- 안드로이드(Chrome): 메뉴 → **홈 화면에 추가** (또는 "앱 설치")
- 아이폰(Safari): 공유 → **홈 화면에 추가**

한 번 연 휴대폰은 트랙처럼 신호가 약한 곳에서도 열리고, 그동안 체크한 점검·기록은 연결되면 자동으로 올라가요.

## 보안 체크리스트

- [ ] 외부 공개는 HTTPS(Cloudflare Tunnel)로만, 서버는 `HOST=127.0.0.1`
- [ ] 관리 창 → 설정에서 가입 방식을 "승인제" 또는 "초대 코드"로
- [ ] 개발자 계정은 강한 비밀번호, 개발자는 꼭 필요한 사람만
- [ ] 외부 복사(USB)가 매일 도는지 관리 창 개요에서 확인
- [ ] 같은 휴대폰·노트북을 여러 사람이 쓰면 다 쓴 뒤 로그아웃 (이 기기에 저장된 데이터가 지워져요)
- [ ] 이 저장소는 공개 저장소예요. `data/` 폴더나 백업 파일은 절대 커밋하지 않기 (`.gitignore`에 있음)
