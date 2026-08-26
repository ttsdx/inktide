# Mirror ai/*.md into .cursor/ so the diary is visible to both layouts.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ai = Join-Path $root 'ai'
$cursor = Join-Path $root '.cursor'

if (-not (Test-Path $ai)) {
    throw "Missing $ai"
}

New-Item -ItemType Directory -Force -Path $cursor | Out-Null

$names = @('REQUIREMENTS.md', 'REQUIREMENTS_LOG.md', 'CONSTRAINTS.md')
foreach ($name in $names) {
    $src = Join-Path $ai $name
    if (-not (Test-Path $src)) {
        throw "Missing $src"
    }
    Copy-Item -Path $src -Destination (Join-Path $cursor $name) -Force
}

Write-Host "Synced $($names.Count) files to .cursor/"
