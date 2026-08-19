$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $projectRoot 'assets\icon.svg'
$buildDir = Join-Path $projectRoot 'build'
$png = Join-Path $buildDir 'icon.png'
$ico = Join-Path $buildDir 'icon.ico'

New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
magick $source -background none -resize 512x512 $png
magick $source -background none -define icon:auto-resize=256,128,64,48,32,24,16 $ico

Write-Host "Created $ico"
