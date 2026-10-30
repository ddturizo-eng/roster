# Copies the neutral definitions in agents/ to each harness format.
# Today: Claude Code (.claude/agents/). To add a harness, add its target here.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'agents'

$targets = @(
    (Join-Path $root '.claude\agents')
    # (Join-Path $root '.opencode\agent')  # OpenCode: check its frontmatter format before enabling
)

foreach ($target in $targets) {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Get-ChildItem -Path $source -Filter '*.md' | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination (Join-Path $target $_.Name) -Force
    }
    Write-Host "Synced: $target"
}
