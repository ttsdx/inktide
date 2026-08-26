# Fail if .cursor/ mirrors are missing or differ from ai/.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ai = Join-Path $root 'ai'
$cursor = Join-Path $root '.cursor'
$names = @('REQUIREMENTS.md', 'REQUIREMENTS_LOG.md', 'CONSTRAINTS.md')
$failed = $false

foreach ($name in $names) {
    $src = Join-Path $ai $name
    $dst = Join-Path $cursor $name
    if (-not (Test-Path $src)) {
        Write-Error "Missing source $src"
        $failed = $true
        continue
    }
    if (-not (Test-Path $dst)) {
        Write-Error "Missing mirror $dst — run scripts/sync-ai-docs.ps1"
        $failed = $true
        continue
    }
    $a = Get-FileHash -Algorithm SHA256 -Path $src
    $b = Get-FileHash -Algorithm SHA256 -Path $dst
    if ($a.Hash -ne $b.Hash) {
        Write-Error "$name differs between ai/ and .cursor/"
        $failed = $true
    }
}

if ($failed) {
    exit 1
}

Write-Host 'ai docs and .cursor mirrors match.'
