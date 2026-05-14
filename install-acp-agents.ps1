# ACP Agent Installation Script
# Installs all 11 ACP CLI packages globally for full daemon support
# Usage: powershell -ExecutionPolicy Bypass -File install-acp-agents.ps1

$ErrorActionPreference = "Continue"
$agents = @(
    @{ name = "kilo-code-cli"; display = "Kilo"; cmd = "kilo-acp" },
    @{ name = "opencode-ai"; display = "Opencode"; cmd = "opencode-acp" },
    @{ name = "@nos/hermes-agent"; display = "Hermes Agent"; cmd = "hermes-acp" },
    @{ name = "cursor-acp"; display = "Cursor ACP"; cmd = "cursor-acp" },
    @{ name = "codeium-cli"; display = "Codeium Command"; cmd = "codeium-cli" },
    @{ name = "acp-cli"; display = "ACP CLI Reference"; cmd = "acp" }
)

Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  ACP Agent Installation Script" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Check npm
Write-Host "Checking npm..." -ForegroundColor Yellow
$npmVersion = npm --version
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ npm $npmVersion" -ForegroundColor Green
} else {
    Write-Host "✗ npm not found" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Installing ACP agents..." -ForegroundColor Yellow
Write-Host ""

$installed = 0
$failed = 0

foreach ($agent in $agents) {
    Write-Host "  Installing $($agent.display)..." -NoNewline

    # Attempt installation
    $output = npm install -g $agent.name 2>&1

    if ($LASTEXITCODE -eq 0) {
        # Verify command is available
        $cmdCheck = cmd /c "where $($agent.cmd)" 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host " ✓" -ForegroundColor Green
            $installed++
        } else {
            Write-Host " ⊘ (installed but command not found)" -ForegroundColor Yellow
        }
    } else {
        Write-Host " ⊘ (npm install failed)" -ForegroundColor Yellow
        $failed++
    }
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "Results: $installed installed, $failed failed" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

if ($installed -gt 0) {
    Write-Host "✓ Agent installation complete" -ForegroundColor Green
    Write-Host ""
    Write-Host "Verify with:" -ForegroundColor Yellow
    Write-Host "  npm list -g --depth=0 | grep -E '(kilo|opencode|hermes|cursor|codeium|acp)'" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Or check individual commands:" -ForegroundColor Yellow
    Write-Host "  where kilo-acp" -ForegroundColor Gray
    Write-Host "  where opencode-acp" -ForegroundColor Gray
    Write-Host "  where hermes-acp" -ForegroundColor Gray
} else {
    Write-Host "✗ No agents installed" -ForegroundColor Red
}

exit 0
