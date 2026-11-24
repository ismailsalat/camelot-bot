$ErrorActionPreference = 'Stop'

# Always locate the app from this script's own folder, not PowerShell's
# current directory. Avoid passing C:\... to Linux wslpath: older Windows
# PowerShell/WSL combinations can strip the backslashes from that argument.
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$windowsDrivePath = [regex]::Match($root, '^([A-Za-z]):[\\/](.*)$')
if (-not $windowsDrivePath.Success) {
    throw 'Camelot TV must be extracted to a local Windows drive (for example C:\Users\...\Downloads). Network/UNC paths are not supported by this launcher.'
}
$drive = $windowsDrivePath.Groups[1].Value.ToLowerInvariant()
$rest = $windowsDrivePath.Groups[2].Value.Replace('\', '/')
$linuxPath = '/mnt/' + $drive + '/' + $rest

if (-not (Test-Path (Join-Path $root 'scripts\setup-fedora.sh'))) {
    throw 'Setup script missing. Fully extract the ZIP before starting Camelot TV.'
}

Write-Host ('[Camelot TV] Folder: ' + $root)
Write-Host ('[Camelot TV] Fedora path: ' + $linuxPath)

# --cd accepts the already-normalized Linux path and keeps it as one
# Windows command-line argument. No Bash string interpolation or wslpath.
& wsl.exe -d FedoraLinux-44 --cd $linuxPath -- bash -c 'test -f scripts/setup-fedora.sh'
if ($LASTEXITCODE -ne 0) {
    throw 'Fedora could not access the Camelot TV folder. Confirm FedoraLinux-44 is installed and that the ZIP was extracted to a local drive.'
}

if ($args.Count -gt 0 -and $args[0] -eq 'install') {
    Write-Host '[Camelot TV] Installing source and streaming dependencies...'
    & wsl.exe -d FedoraLinux-44 --cd $linuxPath -- bash scripts/setup-fedora.sh
    if ($LASTEXITCODE -ne 0) { throw 'Setup failed. See the first ERROR above.' }
} else {
    Write-Host '[Camelot TV] Starting online search interface...'
    Write-Host '[Camelot TV] Watch the next lines for OPEN THIS URL (3333 may be busy).'
    & wsl.exe -d FedoraLinux-44 --cd $linuxPath -- bash scripts/run-fedora.sh
    if ($LASTEXITCODE -ne 0) { throw 'Camelot TV stopped. Read the actual error above. Do not reinstall unless the error says dependencies are missing.' }
}
