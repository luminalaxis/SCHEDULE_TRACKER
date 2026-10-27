# Windows 노트북에서 피트보드 돌리기

라즈베리파이를 준비하기 전에 Windows 노트북으로 먼저 써 보는 방법입니다. 바깥 주소는 무료인 **Tailscale Funnel**로 만들어요. `https://pitboard.<이름>.ts.net` 같은 HTTPS 주소가 생기고, 나중에 파이로 옮겨도 같은 주소를 써요. 팀원은 아무것도 설치하지 않고 브라우저로 들어와요.

노트북이 꺼지거나 잠들면 피트보드도 같이 멈춰요. 팀이 매일 쓰게 되면 [라즈베리파이로 옮기세요](RASPBERRY_PI.md#10-노트북에서-쓰던-피트보드-옮겨-오기).

아래 명령은 모두 **PowerShell**에서 입력해요.

## 1. 설치 (한 번만)

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Tailscale.Tailscale
```

설치가 끝나면 PowerShell 창을 닫았다가 다시 열고 `node -v` 가 v22.13 이상인지 확인하세요.

## 2. 코드 받기

```powershell
cd ~
git clone https://github.com/luminalaxis/SCHEDULE_TRACKER.git
```

## 3. 서버 켜기

`SCHEDULE_TRACKER\deploy\start-pitboard.cmd` 를 **더블클릭**하세요. 창이 열리고 서버가 켜져요. 이 창을 닫거나 `Ctrl+C` 를 누르면 꺼져요.

스크립트가 정해 주는 값은 아래와 같아요. 미리 같은 이름의 환경 변수를 정해 두면 그 값을 써요.

| 변수 | 값 | 뜻 |
|---|---|---|
| `PORT` | `8080` | 서버 포트 |
| `HOST` | `127.0.0.1` | 이 노트북 안에서만 받아요. 바깥 접속은 Funnel이 넘겨 줘요 |
| `DATA_DIR` | `%USERPROFILE%\fsk-data` | 데이터베이스·첨부 파일·백업 (코드 폴더 밖이라 옮기기 쉬워요) |
| `TZ` | `Asia/Seoul` | 알림·자동 백업 시각 기준 |
| `TRUST_PROXY` | `1` | Funnel이 넘겨 주는 접속자 IP와 https 여부를 믿어요 |
| `COOKIE_SECURE` | `1` | Funnel 주소는 항상 HTTPS예요 |

노트북을 재부팅하면 이 단계만 다시 하면 돼요.

## 4. 바깥에 공개하기 (Tailscale Funnel, 한 번만)

1. 작업 표시줄의 Tailscale 아이콘을 눌러 로그인하세요.
2. 관리 화면 [login.tailscale.com](https://login.tailscale.com/admin/dns) → **DNS**에서 **MagicDNS**와 **HTTPS Certificates**를 켜세요. 같은 화면에서 주소 뒷부분(tailnet 이름, `<이름>.ts.net`)을 한 번 고를 수 있어요.
3. 새 PowerShell 창에서:

   ```powershell
   tailscale set --hostname=pitboard     # 주소의 앞부분이 돼요
   tailscale funnel --bg 8080
   ```

   Funnel 권한을 켜라는 링크가 나오면 한 번 눌러 주세요. 처음 열 때는 인증서를 받느라 1분쯤 걸릴 수 있어요.

`--bg` 로 켠 Funnel은 재부팅해도 남아 있어요. 3단계 창에 바깥 주소가 표시돼요. 끄려면 `tailscale funnel --https=443 off`.

`tailscale funnel status` 에 주소가 두 개(예: 노트북 원래 이름과 `pitboard`) 보이면, 이름을 바꾸기 전에 Funnel을 켠 설정이 남아 있는 거예요. `tailscale serve reset` 으로 지우고 `tailscale funnel --bg 8080` 을 다시 실행하세요.

## 5. 주소를 공유하기 전에

- 바깥 주소로 들어가서 **개발자 본인이 제일 먼저 가입**하세요. 처음 가입한 사람이 개발자 계정이 돼요.
- 관리 창(`/admin`) → 설정에서 가입 방식을 "승인제" 또는 "초대 코드"로 하세요.
- 노트북이 잠들지 않게 하세요: 설정 → 시스템 → 전원에서 전원 연결 시 절전 "안 함", 제어판 → 전원 옵션 → 덮개를 닫으면 "아무 것도 안 함".
- 팀원 몇 명이 로그인한 뒤 관리 창 → 감사 로그에서 IP가 사람마다 다르게 보이는지 확인하세요. 모두 `127.0.0.1` 로만 보이면 Tailscale을 최신으로 업데이트하세요. 그대로 두면 가입·로그인 횟수 제한이 모든 사람에게 한꺼번에 걸려요.

## 6. 업데이트와 백업

- 업데이트: 서버 창을 끄고 `cd ~\SCHEDULE_TRACKER; git pull` 한 뒤 다시 켜요.
- 데이터는 `%USERPROFILE%\fsk-data` 에 있어요. 매일 자동 백업이 `fsk-data\backups` 에 쌓이고, 관리 창 → 백업 · 복원 → **전체 백업 내려받기**로 첨부 파일까지 한 파일로 받을 수 있어요.

## 7. 라즈베리파이로 옮기기

[RASPBERRY_PI.md의 "노트북에서 쓰던 피트보드 옮겨 오기"](RASPBERRY_PI.md#10-노트북에서-쓰던-피트보드-옮겨-오기)를 따르세요. 주소·계정·비밀번호·데이터는 그대로이고, 팀원은 한 번 다시 로그인하면 돼요.
