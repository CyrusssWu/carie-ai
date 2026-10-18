# Builds the "publish" folder: only the files the Carie AI website needs.
# Drag the resulting folder onto https://app.netlify.com/drop (or upload it to any static host).
# Run it again after every change to the app, then re-upload.
$root = $PSScriptRoot
$out = Join-Path $root "publish"
if (Test-Path $out) { Remove-Item $out -Recurse -Force -Confirm:$false }
New-Item -ItemType Directory -Path $out | Out-Null
$files = "index.html", "config.js", "i18n.js", "sw.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png"
foreach ($f in $files) { Copy-Item (Join-Path $root $f) $out }
Copy-Item (Join-Path $root "images") (Join-Path $out "images") -Recurse
# Also build carie-ai-site.zip with forward-slash paths (Compress-Archive on Windows writes
# "images\x.jpg", which web hosts treat as a single file name instead of a folder).
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = Join-Path $root "carie-ai-site.zip"
if (Test-Path $zip) { Remove-Item $zip -Force -Confirm:$false }
$stream = [IO.File]::Open($zip, 'Create')
$archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create)
Get-ChildItem $out -Recurse -File | ForEach-Object {
  $name = $_.FullName.Substring($out.Length + 1).Replace('\', '/')
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $name) | Out-Null
  $name
}
$archive.Dispose(); $stream.Dispose()
