using System.Collections.Concurrent;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record SpreadVectorProperties(int TMin, double BearingDeg, double SpeedMmin, double? IntensityKwm, bool Crown);
