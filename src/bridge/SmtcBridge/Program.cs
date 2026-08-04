using System;
using System.Threading;
using SmtcBridge;

namespace SmtcBridge;

internal static class Program
{
    static int Main(string[] args)
    {
        int pollMs = 750;

        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--poll-ms" || args[i] == "-PollMs")
            {
                if (int.TryParse(args[i + 1], out var p))
                    pollMs = p;
            }
        }

        using var cts = new CancellationTokenSource();

        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            cts.Cancel();
        };

        AppDomain.CurrentDomain.ProcessExit += (_, _) => cts.Cancel();

        var bridge = new Bridge(pollMs);

        try
        {
            return bridge.RunAsync(cts.Token).GetAwaiter().GetResult();
        }
        catch (OperationCanceledException)
        {
            return 0;
        }
    }
}