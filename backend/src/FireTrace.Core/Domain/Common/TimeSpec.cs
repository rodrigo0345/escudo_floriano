using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Common;

/// <summary>Instante dentro de um cenário: relativo ao início (`offsetMinutes`, pode ser negativo) ou absoluto (`time`). Indica-se exatamente um.</summary>
public sealed record TimeSpec(int? OffsetMinutes = null, DateTimeOffset? Time = null)
{
    public DateTimeOffset Resolve(DateTimeOffset start) => Time ?? start.AddMinutes(OffsetMinutes ?? 0);
    public double MinutesFrom(DateTimeOffset start) => Time is { } t ? (t - start).TotalMinutes : OffsetMinutes ?? 0;
}
