using NetTopologySuite.Geometries;
using NetTopologySuite.Operation.Union;
using NetTopologySuite.Simplify;

namespace FireTrace.Core.Models.Fire;

public sealed record FireVector(double Lat, double Lon, double BearingDeg, double SpeedMPerMin);
