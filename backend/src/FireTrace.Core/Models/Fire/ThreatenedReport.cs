using System.Collections.Concurrent;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record ThreatenedReport(string SimulationId, int TMin, int HorizonMinutes, double MinProbability, IReadOnlyList<ThreatenedAsset> Assets, ThreatenedBuildings Buildings);
