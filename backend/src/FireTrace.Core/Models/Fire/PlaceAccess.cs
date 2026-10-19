using System.Collections.Concurrent;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record PlaceAccess(string PlaceId, string Name, int Population, IReadOnlyList<double?> AccessMinutes, IReadOnlyList<double> IsolatedProbability, IReadOnlyList<string> Status);
