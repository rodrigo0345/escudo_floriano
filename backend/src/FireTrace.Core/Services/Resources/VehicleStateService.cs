using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Services.Crud;
using FireTrace.Core.Services.Map;
using FireTrace.Core.Services.Operations;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Services.Resources;

/// <summary>Alterações ao estado de uma viatura (muda muitas vezes, por isso tem endpoints próprios).</summary>
public sealed class VehicleStateService(CrudService<Vehicle> vehicles, IMapReader map, MapQueries queries, RoutingSettings routing, TimeProvider clock)
{
    public async Task<VehicleState> GetAsync(string id, CancellationToken ct) => (await vehicles.GetAsync(id, ct)).State;

    public async Task<VehicleState> PatchAsync(string id, System.Text.Json.JsonElement patch, CancellationToken ct)
    {
        var vehicle = await vehicles.GetAsync(id, ct);
        var state = MergePatch.Apply(vehicle.State, patch) with { UpdatedAt = clock.GetUtcNow() };
        if (state.CrewOnboard > vehicle.CrewCapacity) throw new ValidationException($"Há mais pessoas a bordo ({state.CrewOnboard}) do que a capacidade ({vehicle.CrewCapacity}).", "/crewOnboard");
        // uma viatura terrestre só está numa estrada (ou junto dela): só um GPS real (`source: gps`) pode dizer outra coisa
        if (state.Position is { } position && position != vehicle.State.Position && state.Source != StateSource.Gps && !ArrivalEstimator.IsAerial(vehicle.Type)) await RequireRoadAccess(position, ct);
        return (await vehicles.SaveAsync(vehicle with { State = state }, ct)).State;
    }

    /// <summary>Dentro de um local com rede viária, a posição tem de estar a menos de `PositionToleranceM` de uma estrada; fora dos locais conhecidos não há rede para julgar.</summary>
    async Task RequireRoadAccess(LatLon position, CancellationToken ct)
    {
        if (map.Locations.All.FirstOrDefault(l => l.Spec.CellAt(position.Lat, position.Lon) >= 0) is not { } location) return;
        var net = await map.GetRoadsAsync(location.Id, ct);
        if (queries.IndexOf(net).Nearest(position.Lat, position.Lon, routing.PositionToleranceM) is null)
            throw new ValidationException(new[] { new ValidationIssue("error", "no_road_access", $"As viaturas terrestres só ficam em estradas: a posição está a mais de {routing.PositionToleranceM:F0} m de qualquer uma.", "/position") });
    }
}
