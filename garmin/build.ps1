# Compilation + simulateur pour runnav-df — Windows / PowerShell.
#
#   .\build.ps1              compile
#   .\build.ps1 sim          compile puis lance le simulateur
#   .\build.ps1 fit a.fit    compile, lance le simulateur et rejoue une activité
#
# La clé développeur est générée au premier appel si elle est absente.

param([string]$Action = "", [string]$FitFile = "")

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$Device = "fenix847mm"
$Out    = "bin\runnav-df.prg"
$Key    = "developer_key.der"

# --- localisation du SDK ---
if (-not $env:CIQ_HOME) {
    $sdkRoot = Join-Path $env:APPDATA "Garmin\ConnectIQ\Sdks"
    if (Test-Path $sdkRoot) {
        $latest = Get-ChildItem $sdkRoot -Directory | Sort-Object Name | Select-Object -Last 1
        if ($latest) { $env:CIQ_HOME = $latest.FullName }
    }
}
$monkeyc = Join-Path $env:CIQ_HOME "bin\monkeyc.bat"
if (-not $env:CIQ_HOME -or -not (Test-Path $monkeyc)) {
    Write-Host "SDK introuvable. Renseigne CIQ_HOME, par exemple :" -ForegroundColor Red
    Write-Host '  $env:CIQ_HOME = "$env:APPDATA\Garmin\ConnectIQ\Sdks\connectiq-sdk-win-9.2.0"'
    exit 1
}
Write-Host "SDK : $env:CIQ_HOME"

# --- clé développeur ---
# Elle signe le .prg. Gratuite, générée localement, à ne jamais committer.
if (-not (Test-Path $Key)) {
    Write-Host "Génération de la clé développeur…"
    $openssl = (Get-Command openssl -ErrorAction SilentlyContinue)
    if (-not $openssl) {
        # Git pour Windows en embarque une copie
        $guess = "C:\Program Files\Git\usr\bin\openssl.exe"
        if (Test-Path $guess) { $openssl = $guess } else { $openssl = $null }
    }
    if ($openssl) {
        $exe = if ($openssl -is [string]) { $openssl } else { $openssl.Source }
        & $exe genrsa -out developer_key.pem 4096 2>$null
        & $exe pkcs8 -topk8 -inform PEM -outform DER -in developer_key.pem -out $Key -nocrypt 2>$null
        Write-Host "  -> $Key"
    } else {
        Write-Host "openssl introuvable." -ForegroundColor Yellow
        Write-Host "Genere la cle depuis VS Code : Ctrl+Shift+P > 'Monkey C: Generate a Developer Key'"
        Write-Host "puis place-la ici sous le nom $Key."
        exit 1
    }
}

New-Item -ItemType Directory -Force -Path bin | Out-Null
Write-Host "Compilation pour $Device…"
& $monkeyc -f monkey.jungle -d $Device -o $Out -y $Key --warn
if ($LASTEXITCODE -ne 0) { Write-Host "Echec de compilation." -ForegroundColor Red; exit $LASTEXITCODE }
Write-Host "OK -> $Out" -ForegroundColor Green

if ($Action -eq "sim" -or $Action -eq "fit") {
    Start-Process (Join-Path $env:CIQ_HOME "bin\connectiq.bat")
    Start-Sleep -Seconds 4
    $monkeydo = Join-Path $env:CIQ_HOME "bin\monkeydo.bat"
    if ($Action -eq "fit") {
        if (-not $FitFile) { Write-Host "usage : .\build.ps1 fit <activite.fit>" -ForegroundColor Red; exit 1 }
        & $monkeydo $Out $Device $FitFile
    } else {
        & $monkeydo $Out $Device
    }
}
