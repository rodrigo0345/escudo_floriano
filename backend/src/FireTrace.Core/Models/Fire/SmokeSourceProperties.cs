using System.Collections.Concurrent;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record SmokeSourceProperties(double IntensityKwm, double ColumnHeightM, bool Crown);
