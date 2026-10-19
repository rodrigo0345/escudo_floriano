using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

/// <summary>Cansaço e turno de uma equipa: depois de trabalhar muito tempo tem de descansar.</summary>
public sealed record CrewStatus(int? WorkedMinutes = null, double? FatiguePct = null, DateTimeOffset? ShiftEndsAt = null, DateTimeOffset? MustRestAt = null, int? Casualties = null);
