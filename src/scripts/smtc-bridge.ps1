#!/usr/bin/env pwsh
#Requires -Version 5.0
<#
.SYNOPSIS
  Windows SMTC bridge for the Discord Lyrics Status runtime.

.DESCRIPTION
  Reads the current SystemMediaTransportControls session (typically
  Spotify) and emits a stream of JSON events on stdout, one per line:

    { "type": "attached" }
    { "type": "playbackStatus", "playing": true }
    { "type": "timeline", "positionMs": 12345 }
    { "type": "mediaProperties", "title": "...", "artist": "...",
      "album": "...", "durationMs": 210000 }
    { "type": "detached" }
    { "type": "error", "message": "..." }

  Polled at -PollMs (default 750ms). Most changes are detected within
  one poll cycle. Shutdown is via process kill.

  The runtime parses these lines and translates them to a higher-level
  event stream.
#>
[CmdletBinding()]
param(
    [int]$PollMs = 750
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Load the WinRT types we need. On PS5 they're built in; on PS7 we
# prepend the System.Runtime.WindowsRuntime assembly.
try {
    [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
} catch {
    try {
        Add-Type -AssemblyName System.Runtime.WindowsRuntime
        [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
    } catch {
        Write-Output (ConvertTo-Json -Compress @{ type = 'error'; message = "WinRT unavailable: $($_.Exception.Message)" })
        exit 1
    }
}

function Emit-Json($obj) {
    try {
        $json = ConvertTo-Json -Compress -InputObject $obj -Depth 5
        Write-Output $json
    } catch {
        # Swallow: emit must never throw.
    }
}

function Get-StatusName([int]$code) {
    switch ($code) {
        0 { 'closed' }
        1 { 'opened' }
        2 { 'changing' }
        3 { 'stopped' }
        4 { 'playing' }
        5 { 'paused' }
        default { "code=$code" }
    }
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$managerAsync = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()

$manager = [System.WindowsRuntimeSystemExtensions]::AsTask($managerAsync).Result
$attached = $false
$lastTitle = ''
$lastArtist = ''
$lastPlaying = $false
$lastPos = -1

while ($true) {
    try {
        $session = $manager.GetCurrentSession()
        if ($null -eq $session) {
            if ($attached) {
                Emit-Json @{ type = 'detached' }
                $attached = $false
                $lastTitle = ''
                $lastArtist = ''
                $lastPlaying = $false
                $lastPos = -1
            }
            Start-Sleep -Milliseconds $PollMs
            continue
        }

        if (-not $attached) {
            Emit-Json @{ type = 'attached' }
            $attached = $true
        }

        $info = $session.GetPlaybackInfo()
        if ($null -ne $info) {
            $status = [int]$info.PlaybackStatus
            $playing = ($status -eq 4)
            if ($playing -ne $lastPlaying) {
                Emit-Json @{ type = 'playbackStatus'; playing = $playing }
                $lastPlaying = $playing
            }
        }

        $timeline = $session.GetTimelineProperties()
        if ($null -ne $timeline) {
            $posMs = [int][double]$timeline.Position.TotalMilliseconds
            if ([Math]::Abs($posMs - $lastPos) -ge 250) {
                Emit-Json @{ type = 'timeline'; positionMs = $posMs }
                $lastPos = $posMs
            }
        }

        $mediaAsync = $session.TryGetMediaPropertiesAsync()
        $mp = [System.WindowsRuntimeSystemExtensions]::AsTask($mediaAsync).Result

$mediaAsync = $session.TryGetMediaPropertiesAsync()
$mp = [System.WindowsRuntimeSystemExtensions]::AsTask($mediaAsync).Result

        if ($null -ne $mp) {
        $title = if ($mp.Title) { $mp.Title } else { '' }
        $artist = if ($mp.Artist) { $mp.Artist } else { '' }
        $album = if ($mp.AlbumTitle) { $mp.AlbumTitle } else { '' }

            if ($title -ne $lastTitle -or $artist -ne $lastArtist) {
                $durationMs = 0
                if ($null -ne $timeline) {
                    $durationMs = [int][double]$timeline.EndTime.TotalMilliseconds
        }

        Emit-Json @{
            type = 'mediaProperties'
            title = $title
            artist = $artist
            album = $album
            durationMs = $durationMs
        }

        $lastTitle = $title
        $lastArtist = $artist
    }
}
        }
    } catch {
        Emit-Json @{ type = 'error'; message = $_.Exception.Message }
    }
    Start-Sleep -Milliseconds $PollMs
}
