# FSK 피트보드를 Windows 노트북에서 켜요. 더블클릭으로 켜려면 같은 폴더의 start-pitboard.cmd 를 쓰세요.
# 바깥 공개(Tailscale Funnel)는 한 번만 설정하면 재부팅해도 남아 있어요. 설정 방법은 deploy\WINDOWS.md
# 미리 정해 둔 환경 변수(PORT, DATA_DIR 등)가 있으면 그 값을 그대로 써요.
Set-Location (Split-Path -Parent $PSScriptRoot)

function Use-Default($name, $value) {
  if (-not [Environment]::GetEnvironmentVariable($name)) { Set-Item "env:$name" $value }
}
Use-Default PORT "8080"
Use-Default HOST "127.0.0.1"   # 이 노트북 안에서만 받고, 바깥 접속은 Tailscale Funnel이 넘겨 줘요
Use-Default DATA_DIR (Join-Path $HOME "fsk-data")
Use-Default TZ "Asia/Seoul"
Use-Default TRUST_PROXY "1"    # Funnel이 넘겨 주는 https 여부와 접속한 사람의 IP를 믿어요 (HOST가 127.0.0.1일 때만 안전)
Use-Default COOKIE_SECURE "1"  # Funnel 주소는 항상 HTTPS예요

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js가 없어요. PowerShell에서 'winget install OpenJS.NodeJS.LTS' 로 설치하고 창을 다시 연 뒤 실행하세요." -ForegroundColor Red
  exit 1
}
$nodeVersion = [version](node -p "process.versions.node")
if ($nodeVersion -lt [version]"22.13") {
  Write-Host "Node.js $nodeVersion 은 너무 오래됐어요. 22.13 이상이 필요해요: winget upgrade OpenJS.NodeJS.LTS" -ForegroundColor Red
  exit 1
}

if (Get-Command tailscale -ErrorAction SilentlyContinue) {
  $funnel = tailscale funnel status 2>&1 | Out-String
  $urls = [regex]::Matches($funnel, "https://[^\s]+\.ts\.net") | ForEach-Object { $_.Value } | Select-Object -Unique
  if ($funnel -match "Funnel on" -and $urls) {
    Write-Host "바깥 주소: $($urls -join ', ')" -ForegroundColor Green
  } else {
    Write-Host "아직 바깥에 공개되지 않았어요. 새 PowerShell 창에서 한 번만 실행하세요: tailscale funnel --bg $env:PORT" -ForegroundColor Yellow
  }
} else {
  Write-Host "Tailscale이 없어서 이 노트북에서만 http://localhost:$env:PORT 로 열려요." -ForegroundColor Yellow
}
Write-Host "데이터 폴더: $env:DATA_DIR"
Write-Host "끄려면 이 창에서 Ctrl+C 를 누르세요."
Write-Host ""

node --disable-warning=ExperimentalWarning server/server.js
