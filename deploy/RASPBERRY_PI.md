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
- 백업 JSON에는 첨부 파일 자체가 들어가지 않아요. **`~/fsk-data` 폴더 전체를 파이 밖으로 복사**하는 걸 꼭 설정하세요. USB 드라이브 예시 (`crontab -e`):

```cron
30 4 * * * rsync -a --delete /home/pi/fsk-data/ /media/pi/BACKUP/fsk-data/
```

Google Drive 같은 클라우드로 보내려면 `rclone` 을 쓰면 돼요.

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
| 파이가 고장 나서 새 파이로 옮김 | 새 파이에 2~4단계를 한 뒤, 복사해 둔 `fsk-data` 폴더를 그대로 넣고 서비스 시작 |
| 폴더 없이 백업 JSON만 있음 | `DATA_DIR=~/fsk-data npm run admin -- restore 백업파일.json` (계정·데이터·설정 복원, 첨부 파일은 따로) |

## 9. claude.ai 피트보드에서 데이터 옮기기

1. Claude에게 "피트보드 Artifact 데이터를 내보내 줘"라고 요청하면 `{ docs: [{ path, data }] }` 형식 JSON을 만들어 줘요.
2. 관리 창 → 백업·복원 → 데이터 가져오기에서 그 파일을 "합치기"로 가져와요.
3. 주의: claude.ai 계정 id와 이 서버의 계정 id가 달라서, **사비 정산 기록(`expenses/<id>`, `reviews/<id>`)과 사람 목록은 id를 새 계정으로 바꿔서** 가져와야 해요. 팀원들이 이 서버에 가입한 뒤 내보내기를 요청하면 Claude가 id를 맞춰서 만들어 줄 수 있어요.

## 보안 체크리스트

- [ ] 외부 공개는 HTTPS(Cloudflare Tunnel)로만, 서버는 `HOST=127.0.0.1`
- [ ] 관리 창 → 설정에서 가입 방식을 "승인제" 또는 "초대 코드"로
- [ ] 개발자 계정은 강한 비밀번호, 개발자는 꼭 필요한 사람만
- [ ] `fsk-data` 폴더 외부 백업이 매일 도는지 확인
- [ ] 이 저장소는 공개 저장소예요. `data/` 폴더나 백업 파일은 절대 커밋하지 않기 (`.gitignore`에 있음)
