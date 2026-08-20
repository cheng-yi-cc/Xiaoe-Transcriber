$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $projectRoot 'assets\icon.svg'
$buildDir = Join-Path $projectRoot 'build'
$workDir = Join-Path $env:TEMP 'xiaoe-transcriber-art'

New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

$semibold = 'C:/Windows/Fonts/seguisb.ttf'
$regular = 'C:/Windows/Fonts/segoeui.ttf'

function New-IconPng([int]$size, [string]$out) {
  $radius = [Math]::Round($size * 56 / 256)
  $max = $size - 1
  magick -background none $source -resize "${size}x${size}" `
    "(" -size "${size}x${size}" xc:none -fill white -draw "roundrectangle 0,0 $max,$max $radius,$radius" ")" `
    -alpha off -compose CopyOpacity -composite $out
  if (-not $?) { throw "Failed to render icon at $size px." }
}

function ConvertTo-Bmp24([string]$png, [string]$bmp) {
  magick $png -type TrueColor "BMP3:$bmp"
  if (-not $?) { throw "Failed to convert $png to BMP." }
}

New-IconPng 40 (Join-Path $workDir 'icon40.png')
New-IconPng 64 (Join-Path $workDir 'icon64.png')

$headerPng = Join-Path $workDir 'header.png'
magick -size 150x57 xc:'#fbfcfa' `
  (Join-Path $workDir 'icon40.png') -geometry +9+8 -composite `
  -font $semibold -pointsize 12 -fill '#173a36' -annotate +57+21 'Xiaoe' `
  -font $semibold -pointsize 12 -fill '#173a36' -annotate +57+36 'Transcriber' `
  -font $regular -pointsize 8.5 -fill '#687a75' -annotate +57+50 'for Windows' `
  $headerPng
if (-not $?) { throw 'Failed to compose installer header.' }

$bars = ''
$heights = @(14, 24, 38, 22, 44, 30, 16, 34, 24, 12)
$startX = 44
$baseline = 262
for ($i = 0; $i -lt $heights.Length; $i += 1) {
  $x0 = $startX + $i * 8
  $x1 = $x0 + 4
  $y0 = $baseline - $heights[$i]
  $bars += "fill '#a9f0d1' roundrectangle $x0,$y0 $x1,$baseline 2,2 "
}

$sidebarPng = Join-Path $workDir 'sidebar.png'
magick -size 164x314 xc:'#173a36' `
  (Join-Path $workDir 'icon64.png') -geometry +50+48 -composite `
  -font $semibold -pointsize 19 -fill '#a9f0d1' -gravity north -annotate +0+138 'Xiaoe' `
  -font $semibold -pointsize 19 -fill '#fbfcfa' -gravity north -annotate +0+163 'Transcriber' `
  -draw "$bars fill '#f2b84b' circle 122,214 122,209" `
  -font $regular -pointsize 8.5 -fill '#9db7af' -gravity south -annotate +0+18 'MIT · Windows x64' `
  $sidebarPng
if (-not $?) { throw 'Failed to compose installer sidebar.' }

ConvertTo-Bmp24 $headerPng (Join-Path $buildDir 'installerHeader.bmp')
ConvertTo-Bmp24 $sidebarPng (Join-Path $buildDir 'installerSidebar.bmp')
ConvertTo-Bmp24 $sidebarPng (Join-Path $buildDir 'uninstallerSidebar.bmp')

Write-Host 'Created installerHeader.bmp, installerSidebar.bmp and uninstallerSidebar.bmp in build/'
