// SPDX-License-Identifier: MIT
using System;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Windows.Media.Control;

namespace SmtcBridge;

/// <summary>
/// Polls the Windows SystemMediaTransportControls session manager
/// (driven by Spotify and other media apps) and emits a stream of
/// change events as line-delimited JSON on stdout.
/// </summary>
internal sealed class Bridge
{
    private readonly int _pollMs;
    private static readonly JsonWriterOptions WriterOptions = new() { Indented = false };

    public Bridge(int pollMs)
    {
        _pollMs = pollMs;
    }

    public async Task<int> RunAsync(CancellationToken ct)
    {
        GlobalSystemMediaTransportControlsSessionManager? manager = null;
        try
        {
            manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync().AsTask(ct);
        }
        catch (OperationCanceledException)
        {
            return 0;
        }
        catch (Exception ex)
        {
            EmitError($"manager request failed: {ex.Message}");
            return 1;
        }

        if (manager is null)
        {
            EmitError("manager unavailable (returned null)");
            return 1;
        }


        bool attached = false;
        string lastTitle = "";
        string lastArtist = "";
        string lastAlbum = "";
        long lastDurationMs = 0;
        bool? lastPlaying = null;
        long lastPositionMs = -1;
        string? lastSourceAppId = null;

        try
        {
            while (!ct.IsCancellationRequested)
            {
                GlobalSystemMediaTransportControlsSession? session = null;
                try
                {
                    session = manager.GetCurrentSession();
                }
                catch (Exception ex)
                {
                    EmitError($"GetCurrentSession failed: {ex.Message}");
                }

                if (session is null)
                {
                    if (attached)
                    {
                        EmitDetached();
                        attached = false;
                        lastTitle = "";
                        lastArtist = "";
                        lastAlbum = "";
                        lastDurationMs = 0;
                        lastPlaying = null;
                        lastPositionMs = -1;
                        lastSourceAppId = null;
                    }

                    try { await Task.Delay(_pollMs, ct); }
                    catch (OperationCanceledException) { break; }
                    continue;
                }

                // Prefer Spotify. If we see another app briefly, keep
                // streaming — the Node adapter treats "any session" as
                // attached, which preserves compatibility with the
                // existing PowerShell bridge.
                string? sourceAppId = null;
                try { sourceAppId = session.SourceAppUserModelId; }
                catch { /* not all sources expose this */ }

                if (!attached)
                {
                    EmitAttached(sourceAppId);
                    attached = true;
                    lastSourceAppId = sourceAppId;
                }
                else if (!string.Equals(sourceAppId, lastSourceAppId, StringComparison.Ordinal))
                {
                    // Source changed (e.g. switched from another player
                    // to Spotify). Treat it as a fresh attach so the
                    // Node side re-seeds its track.
                    EmitDetached();
                    EmitAttached(sourceAppId);
                    lastSourceAppId = sourceAppId;
                    lastTitle = "";
                    lastArtist = "";
                    lastAlbum = "";
                    lastDurationMs = 0;
                    lastPlaying = null;
                    lastPositionMs = -1;
                }

                // Playback status.
                try
                {
                    var info = session.GetPlaybackInfo();
                    if (info is not null)
                    {
                        var playing = info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
                        if (lastPlaying is null || lastPlaying.Value != playing)
                        {
                            EmitPlaybackStatus(playing);
                            lastPlaying = playing;
                        }
                    }
                }
                catch (Exception ex)
                {
                    EmitError($"GetPlaybackInfo failed: {ex.Message}");
                }

                // Timeline (position + duration). We prefer
                // GetTimelineProperties because it gives us both
                // position and EndTime in one call. We emit a timeline
                // event whenever the position changes by >= 250 ms, the
                // same threshold the PowerShell bridge used.
                long posMs = lastPositionMs;
                long durMs = lastDurationMs;
                bool gotTimeline = false;
                try
                {
                    var timeline = session.GetTimelineProperties();
                    if (timeline is not null)
                    {
                        gotTimeline = true;
                        posMs = ClampMs(timeline.Position.TotalMilliseconds);
                        durMs = ClampMs(timeline.EndTime.TotalMilliseconds);
                    }
                }
                catch (Exception ex)
                {
                    EmitError($"GetTimelineProperties failed: {ex.Message}");
                }

                if (gotTimeline && Math.Abs(posMs - lastPositionMs) >= 250)
                {
                    EmitTimeline(posMs);
                    lastPositionMs = posMs;
                }
                if (gotTimeline && durMs != lastDurationMs)
                {
                    // We don't have a dedicated "duration" event in the
                    // schema; duration is reported as part of
                    // mediaProperties. We re-emit mediaProperties below
                    // if the title didn't change but the duration did.
                }

                // Media properties.
                string title = lastTitle;
                string artist = lastArtist;
                string album = lastAlbum;
                long durationMs = durMs;
                bool gotMedia = false;
                try
                {
                    var mp = await session.TryGetMediaPropertiesAsync().AsTask(ct);
                    if (mp is not null)
                    {
                        gotMedia = true;
                        title = mp.Title ?? "";
                        artist = mp.Artist ?? "";
                        album = mp.AlbumTitle ?? "";
                        if (!gotTimeline) durationMs = lastDurationMs;
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    EmitError($"TryGetMediaPropertiesAsync failed: {ex.Message}");
                }

                if (gotMedia && (
                    !string.Equals(title, lastTitle, StringComparison.Ordinal) ||
                    !string.Equals(artist, lastArtist, StringComparison.Ordinal) ||
                    !string.Equals(album, lastAlbum, StringComparison.Ordinal) ||
                    durationMs != lastDurationMs))
                {
                    EmitMediaProperties(title, artist, album, durationMs);
                    lastTitle = title;
                    lastArtist = artist;
                    lastAlbum = album;
                    lastDurationMs = durationMs;
                }

                try { await Task.Delay(_pollMs, ct); }
                catch (OperationCanceledException) { break; }
            }
        }
        catch (OperationCanceledException)
        {
            // graceful shutdown
        }
        catch (Exception ex)
        {
            EmitError($"fatal: {ex.Message}");
            return 1;
        }
        finally
        {
            if (attached)
            {
                EmitDetached();
                attached = false;
            }
        }

        return 0;
    }

    private static long ClampMs(double ms)
    {
        if (double.IsNaN(ms) || double.IsInfinity(ms) || ms < 0) return 0;
        if (ms > long.MaxValue) return long.MaxValue;
        return (long)ms;
    }

    private static void EmitAttached(string? sourceAppId)
    {
        using var stream = Console.OpenStandardOutput();
        using var writer = new Utf8JsonWriter(stream, WriterOptions);
        writer.WriteStartObject();
        writer.WriteString("type", "attached");
        if (!string.IsNullOrEmpty(sourceAppId))
        {
            writer.WriteString("source", sourceAppId);
        }
        writer.WriteEndObject();
        writer.Flush();
        Console.Out.Write('\n');
    }

    private static void EmitDetached()
    {
        using var stream = Console.OpenStandardOutput();
        using var writer = new Utf8JsonWriter(stream, WriterOptions);
        writer.WriteStartObject();
        writer.WriteString("type", "detached");
        writer.WriteEndObject();
        writer.Flush();
        Console.Out.Write('\n');
    }

    private static void EmitPlaybackStatus(bool playing)
    {
        using var stream = Console.OpenStandardOutput();
        using var writer = new Utf8JsonWriter(stream, WriterOptions);
        writer.WriteStartObject();
        writer.WriteString("type", "playbackStatus");
        writer.WriteBoolean("playing", playing);
        writer.WriteEndObject();
        writer.Flush();
        Console.Out.Write('\n');
    }

    private static void EmitTimeline(long positionMs)
    {
        using var stream = Console.OpenStandardOutput();
        using var writer = new Utf8JsonWriter(stream, WriterOptions);
        writer.WriteStartObject();
        writer.WriteString("type", "timeline");
        writer.WriteNumber("positionMs", positionMs);
        writer.WriteEndObject();
        writer.Flush();
        Console.Out.Write('\n');
    }

    private static void EmitMediaProperties(string title, string artist, string album, long durationMs)
    {
        using var stream = Console.OpenStandardOutput();
        using var writer = new Utf8JsonWriter(stream, WriterOptions);
        writer.WriteStartObject();
        writer.WriteString("type", "mediaProperties");
        writer.WriteString("title", title ?? "");
        writer.WriteString("artist", artist ?? "");
        writer.WriteString("album", album ?? "");
        writer.WriteNumber("durationMs", durationMs);
        writer.WriteEndObject();
        writer.Flush();
        Console.Out.Write('\n');
    }

    private static void EmitError(string message)
    {
        // Errors go to stderr — the Node adapter only listens to
        // stdout for JSON events. We still emit a JSON-shaped line to
        // stderr so the surrounding logger can include it.
        try
        {
            using var stream = Console.OpenStandardError();
            using var writer = new Utf8JsonWriter(stream, WriterOptions);
            writer.WriteStartObject();
            writer.WriteString("type", "error");
            writer.WriteString("message", message);
            writer.WriteEndObject();
            writer.Flush();
            Console.Error.Write('\n');
        }
        catch
        {
            // Last-resort: nothing more we can do.
        }
    }
}
