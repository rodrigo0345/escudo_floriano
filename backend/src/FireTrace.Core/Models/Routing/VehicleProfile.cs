using FireTrace.Core.Domain.Resources;

namespace FireTrace.Core.Models.Routing;

public sealed record VehicleProfile(VehicleType? VehicleType = null, double? HeightM = null, double? WidthM = null, double? WeightT = null, bool? OffRoad = null, double? SpeedKmh = null);
