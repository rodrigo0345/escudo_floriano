using System.Collections.Concurrent;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record FacilityImpact(string FacilityId, string Name, string Kind, string Status, double FireArrivalProbability);
