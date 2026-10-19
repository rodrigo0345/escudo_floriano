using System.Collections.Concurrent;
using FireTrace.Core.Models.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record Smoke(string SimulationId, int TMin, double WindKmh, double WindFromDeg, double DriftBearingDeg, double DriftSpeedKmh, PlumeHeight PlumeHeightM,
    FeatureCollection<Feature<SmokeSourceProperties>> Sources, Geometry? DownwindCorridor, IReadOnlyList<string> AffectedRoadIds);
