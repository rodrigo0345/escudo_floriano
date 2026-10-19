using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

/// <summary>Água de uma viatura: quanto tem, quanto gasta e onde vai reabastecer.</summary>
public sealed record WaterStatus(double? LevelL = null, double? CapacityL = null, double? ConsumptionLpm = null, string? RefillWaterPointId = null,
    double? RefillEtaMinutes = null, int? EmptyAtMinute = null);
