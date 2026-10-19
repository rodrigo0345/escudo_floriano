using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Services.Routing;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Routing;

public sealed record VehicleProfile(VehicleType? VehicleType = null, double? HeightM = null, double? WidthM = null, double? WeightT = null, bool? OffRoad = null, double? SpeedKmh = null)
{
    /// <summary>O perfil de deslocação: todo-o-terreno se a viatura o diz, ou se o seu tipo está em `FireTrace:Routing:OffRoadVehicleTypes`.</summary>
    public TravelProfile ToTravel(RoadSpeeds speeds, RoutingSettings routing, bool emergency) =>
        speeds.Profile(OffRoad ?? (VehicleType is { } t && routing.OffRoadVehicleTypes.Contains(EnumText.ToSnake(t))), emergency, SpeedKmh);
}
