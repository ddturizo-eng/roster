# Copia las definiciones neutrales de agents/ al formato de cada harness.
# Hoy: Claude Code (.claude/agents/). Para sumar un harness, agrega su destino aquí.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'agents'

$targets = @(
    (Join-Path $root '.claude\agents')
    # (Join-Path $root '.opencode\agent')  # OpenCode: revisar su formato de frontmatter antes de activar
)

foreach ($target in $targets) {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Get-ChildItem -Path $source -Filter '*.md' | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination (Join-Path $target $_.Name) -Force
    }
    Write-Host "Sincronizado: $target"
}
