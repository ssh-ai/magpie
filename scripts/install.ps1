# Magpie installer (Windows) — no Node/npm/docker required.
#
#   irm https://ssh-ai.github.io/magpie/install.ps1 | iex
#
# Installs magpie binaries to ~\.magpie\bin and registers the MCP server with
# Claude Code if present.
$ErrorActionPreference = "Stop"

$repo = "ssh-ai/magpie"
$dir  = Join-Path $HOME ".magpie\bin"
$url  = "https://github.com/$repo/releases/latest/download/magpie-windows-x64.zip"

Write-Host "→ installing magpie (windows-x64) to $dir"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$zip = Join-Path $env:TEMP "magpie.zip"
Invoke-WebRequest -Uri $url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $dir -Force
Remove-Item $zip

# PATH (user)
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$dir*") {
  [Environment]::SetEnvironmentVariable("Path", "$dir;$userPath", "User")
  Write-Host "→ added $dir to PATH (restart your terminal)"
}

# Auto-register with Claude Code
$ext = "@$env:USERNAME/main".ToLower()
if (Get-Command claude -ErrorAction SilentlyContinue) {
  $exists = $true
  try { claude mcp get magpie *> $null } catch { $exists = $false }
  if (-not $exists) {
    claude mcp add magpie --scope user -e MAGPIE_EXTENSION=$ext -- (Join-Path $dir "magpie-mcp.exe")
    Write-Host "→ Claude Code: registered magpie MCP (extension $ext)"
  } else {
    Write-Host "→ Claude Code: magpie MCP already registered"
  }
}

Write-Host ""
Write-Host "✅ magpie installed."
Write-Host "Start a call:  tell your agent  `"start a magpie call about <topic>`""
Write-Host "Join a call:   tell your agent  `"join <invite>`""
