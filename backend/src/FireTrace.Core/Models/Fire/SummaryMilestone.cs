using System.Collections.Concurrent;
using FireTrace.Core.Domain.Weather;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record SummaryMilestone(int TMin, DateTimeOffset Time, double AreaHa, double? AreaGrowthHaPerHour, double? HeadSpeedMmin, double? HeadBearingDeg, double MaxIntensityKwm,
    double CrownHa, int BuildingsAffected, int RoadsCut, int PlacesThreatened, LatLon? HeadPosition, WeatherCore? Wind);
