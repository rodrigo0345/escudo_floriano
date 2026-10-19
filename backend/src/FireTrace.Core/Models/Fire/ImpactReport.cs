using System.Collections.Concurrent;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record ImpactReport(string SimulationId, int TMin, DateTimeOffset Time, int EnsembleMembers, string Percentile, double BurnedHa, Quantiles BuildingsAffected, int PopulationExposed,
    IReadOnlyList<RoadImpact> Roads, IReadOnlyList<PlaceImpact> Places, IReadOnlyList<FacilityImpact> Facilities);
