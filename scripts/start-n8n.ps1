<#
Starts a local n8n with the Vobiz nodes loaded, for testing.

  npm run n8n                  (from this folder)

What it does:
  1. Builds the nodes.
  2. Links them into a separate n8n folder, %USERPROFILE%\.n8n-vobiz, so your
     usual n8n and its workflows are left alone.
  3. Opens a free Cloudflare quick tunnel, so Vobiz can reach n8n from the
     internet.
  4. Starts n8n at http://localhost:5688, with the tunnel as its public address.

Press Ctrl+C to stop. The tunnel address changes every time this starts.
#>
param(
	[string]$N8nVersion = '2.37.10',
	[int]$Port = 5688,
	[switch]$NoTunnel
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$userFolder = Join-Path $env:USERPROFILE '.n8n-vobiz'

Write-Host "`n==> 1/4  Building the Vobiz nodes" -ForegroundColor Cyan
Push-Location $repo
try {
	npm run build --silent
	if ($LASTEXITCODE -ne 0) { throw 'The build failed. Scroll up for the error.' }
} finally {
	Pop-Location
}

Write-Host "==> 2/4  Linking them into $userFolder" -ForegroundColor Cyan
# n8n loads what is in its custom folder as "CUSTOM" nodes (CUSTOM.vobiz and
# so on). Only the built files are linked, so n8n doesn't scan node_modules.
$scope = Join-Path $userFolder '.n8n\custom\node_modules\@vobiz'
New-Item -ItemType Directory -Force -Path $scope | Out-Null
$link = Join-Path $scope 'n8n-nodes-vobiz'
if (-not (Test-Path $link)) {
	New-Item -ItemType Junction -Path $link -Target (Join-Path $repo 'dist') | Out-Null
}

$tunnel = $null
$publicUrl = $null
if (-not $NoTunnel) {
	Write-Host '==> 3/4  Opening a Cloudflare tunnel' -ForegroundColor Cyan
	$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
	if (-not $cloudflared -and (Test-Path 'C:\Program Files (x86)\cloudflared\cloudflared.exe')) {
		$cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
	}
	if (-not $cloudflared) {
		throw 'cloudflared is not installed. Install it with:  winget install --id Cloudflare.cloudflared   then run this again.'
	}
	$tunnelLog = Join-Path $userFolder 'tunnel.log'
	if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force }
	$tunnel = Start-Process -FilePath $cloudflared `
		-ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://localhost:$Port") `
		-RedirectStandardError $tunnelLog -WindowStyle Hidden -PassThru
	for ($i = 0; $i -lt 60 -and -not $publicUrl; $i++) {
		Start-Sleep -Seconds 1
		if (Test-Path $tunnelLog) {
			$match = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
			if ($match) { $publicUrl = $match.Matches[0].Value }
		}
	}
	if (-not $publicUrl) {
		Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
		throw "The tunnel did not start. See $tunnelLog"
	}
} else {
	Write-Host '==> 3/4  No tunnel (-NoTunnel): the triggers will not get events from Vobiz' -ForegroundColor Yellow
}

Write-Host '==> 4/4  Starting n8n' -ForegroundColor Cyan
$env:N8N_USER_FOLDER = $userFolder
$env:N8N_PORT = "$Port"
$env:N8N_RUNNERS_BROKER_PORT = "$($Port + 1)"
$env:N8N_DIAGNOSTICS_ENABLED = 'false'
$env:N8N_VERSION_NOTIFICATIONS_ENABLED = 'false'
$env:N8N_PERSONALIZATION_ENABLED = 'false'
# WEBHOOK_URL for n8n up to 2.x; N8N_WEBHOOK_URL is its newer name.
if ($publicUrl) {
	$env:WEBHOOK_URL = "$publicUrl/"
	$env:N8N_WEBHOOK_URL = "$publicUrl/"
} else {
	Remove-Item Env:WEBHOOK_URL, Env:N8N_WEBHOOK_URL -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '  Open n8n here:      ' -NoNewline; Write-Host "http://localhost:$Port" -ForegroundColor Green
if ($publicUrl) { Write-Host '  Public address:     ' -NoNewline; Write-Host $publicUrl -ForegroundColor Green }
Write-Host '  Stop:               Ctrl+C in this window'
Write-Host ''

# Use an n8n already on this computer (for example from an earlier `npx n8n`),
# or install that version once into this test folder. Either way n8n itself is
# never installed globally or changed.
function Find-N8n([string]$version) {
	$cache = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
	if (Test-Path $cache) {
		foreach ($dir in Get-ChildItem $cache -Directory) {
			$manifest = Join-Path $dir.FullName 'node_modules\n8n\package.json'
			if ((Test-Path $manifest) -and ((Get-Content $manifest -Raw | ConvertFrom-Json).version -eq $version)) {
				return (Join-Path $dir.FullName 'node_modules\n8n\bin\n8n')
			}
		}
	}
	$own = Join-Path $userFolder "n8n-$version\node_modules\n8n\bin\n8n"
	if (Test-Path $own) { return $own }
	return $null
}

try {
	$n8nBin = Find-N8n $N8nVersion
	if (-not $n8nBin) {
		Write-Host "Downloading n8n $N8nVersion. This happens once and takes a few minutes..." -ForegroundColor Cyan
		$app = Join-Path $userFolder "n8n-$N8nVersion"
		New-Item -ItemType Directory -Force -Path $app | Out-Null
		npm install --prefix $app "n8n@$N8nVersion" --no-audit --no-fund --loglevel=error
		$n8nBin = Join-Path $app 'node_modules\n8n\bin\n8n'
		if ($LASTEXITCODE -ne 0 -or -not (Test-Path $n8nBin)) {
			throw 'Downloading n8n failed. Run  npm run n8n  again; a second try usually works.'
		}
	}
	node $n8nBin start
	if ($LASTEXITCODE -ne 0) { throw "n8n stopped with exit code $LASTEXITCODE. Scroll up for the reason." }
} finally {
	if ($tunnel) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
}
