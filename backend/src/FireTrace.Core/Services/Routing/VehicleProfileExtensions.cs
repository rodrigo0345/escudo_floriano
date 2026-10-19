using FireTrace.Core.Configuration;
using FireTrace.Core.Models.Routing;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Routing;

public static class VehicleProfileExtensions
{
    public static TravelProfile ToTravel(this VehicleProfile? p, RoadSpeeds speeds, RoutingSettings routing, bool emergency)
    {
        p ??= new VehicleProfile();
        return speeds.Profile(p.OffRoad ?? (p.VehicleType is { } t && routing.OffRoadVehicleTypes.Contains(EnumText.ToSnake(t))), emergency, p.SpeedKmh, p.WidthM, p.MaxSlopePercent);
    }
}
