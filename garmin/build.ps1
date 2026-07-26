# Compilation + simulateur pour runnav-df -- Windows / PowerShell.
#
#   .\build.ps1              compile
#   .\build.ps1 sim          compile puis lance le simulateur
#   .\build.ps1 fit a.fit    compile, lance le simulateur et rejoue une activite
#
# La cle developpeur est generee au premier appel si elle est absente.
#
# Si Windows refuse d'executer le script ("execution de scripts desactivee"),
# lance-le ainsi -- cela ne change aucun reglage global de la machine :
#
#   powershell -ExecutionPolicy Bypass -File .\build.ps1
#
# ATTENTION : ce fichier doit rester en ASCII PUR. Windows PowerShell 5.1 lit
# les .ps1 en ANSI (pas en UTF-8) : un caractere accentue devient du mojibake,
# et s'il suit immediatement une variable, il est absorbe dans son nom.
# "$Device..." devenait ainsi "$Devicea" -> variable inexistante -> nom perdu.

param([string]$Action = "", [string]$FitFile = "")

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$Device = "fenix847mm"
$Out    = "bin\runnav-df.prg"
$Key    = "developer_key.der"

# --- Java : monkeyc est une application Java ---
$java = Get-Command java -ErrorAction SilentlyContinue
if (-not $java) {
    Write-Host "Java introuvable. Le compilateur Monkey C en a besoin." -ForegroundColor Red
    Write-Host "Installe un JDK, par exemple :"
    Write-Host "  winget install --id EclipseAdoptium.Temurin.21.JDK -e"
    Write-Host "puis FERME ET ROUVRE PowerShell (le PATH n'est lu qu'au demarrage)."
    exit 1
}

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
    Write-Host '  $env:CIQ_HOME = "$env:APPDATA\Garmin\ConnectIQ\Sdks\connectiq-sdk-win-9.2.0-..."'
    exit 1
}
Write-Host ("SDK    : " + $env:CIQ_HOME)
Write-Host ("Device : " + $Device)

# --- cle developpeur ---
# Elle signe le .prg. Gratuite, generee localement, jamais commitee.
if (-not (Test-Path $Key)) {
    Write-Host "Generation de la cle developpeur..."
    $done = $false

    # 1) .NET seul, sans dependance externe. ExportPkcs8PrivateKey existe sur
    #    PowerShell 7 (.NET 5+) mais pas sur Windows PowerShell 5.1 (.NET 4.x).
    try {
        $rsa = [System.Security.Cryptography.RSA]::Create(4096)
        [System.IO.File]::WriteAllBytes((Join-Path $PWD $Key), $rsa.ExportPkcs8PrivateKey())
        $done = $true
        Write-Host ("  -> " + $Key + " (via .NET)")
    } catch {
        $done = $false
    }

    # 2) repli openssl (fourni par Git pour Windows)
    if (-not $done) {
        $exe = $null
        $cmd = Get-Command openssl -ErrorAction SilentlyContinue
        if ($cmd) { $exe = $cmd.Source }
        elseif (Test-Path "C:\Program Files\Git\usr\bin\openssl.exe") {
            $exe = "C:\Program Files\Git\usr\bin\openssl.exe"
        }
        if ($exe) {
            & $exe genrsa -out developer_key.pem 4096 2>$null
            & $exe pkcs8 -topk8 -inform PEM -outform DER -in developer_key.pem -out $Key -nocrypt 2>$null
            $done = Test-Path $Key
            if ($done) { Write-Host ("  -> " + $Key + " (via openssl)") }
        }
    }

    # 3) dernier recours : l'extension VS Code sait la generer
    if (-not $done) {
        Write-Host "Impossible de generer la cle automatiquement." -ForegroundColor Yellow
        Write-Host "Dans VS Code : Ctrl+Shift+P > 'Monkey C: Generate a Developer Key'"
        Write-Host ("puis place le fichier .der ici sous le nom " + $Key + ".")
        exit 1
    }
}

New-Item -ItemType Directory -Force -Path bin | Out-Null
Write-Host "Compilation..."
& $monkeyc -f monkey.jungle -d $Device -o $Out -y $Key --warn
if ($LASTEXITCODE -ne 0) {
    Write-Host "Echec de compilation." -ForegroundColor Red
    exit $LASTEXITCODE
}
Write-Host ("OK -> " + $Out) -ForegroundColor Green

if ($Action -eq "sim" -or $Action -eq "fit") {
    Start-Process (Join-Path $env:CIQ_HOME "bin\connectiq.bat")
    Start-Sleep -Seconds 4
    $monkeydo = Join-Path $env:CIQ_HOME "bin\monkeydo.bat"
    if ($Action -eq "fit") {
        if (-not $FitFile) {
            Write-Host "usage : .\build.ps1 fit <activite.fit>" -ForegroundColor Red
            exit 1
        }
        & $monkeydo $Out $Device $FitFile
    } else {
        & $monkeydo $Out $Device
    }
}
