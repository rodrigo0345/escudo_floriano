using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Threading.Channels;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Fire;

/// <summary>Fila das simulações por correr: o motor usa todos os processadores, por isso corre-se uma de cada vez.</summary>
public sealed class SimulationQueue
{
    readonly Channel<string> _channel = Channel.CreateUnbounded<string>();
    public void Enqueue(string simulationId) => _channel.Writer.TryWrite(simulationId);
    public IAsyncEnumerable<string> ReadAllAsync(CancellationToken ct) => _channel.Reader.ReadAllAsync(ct);
}
