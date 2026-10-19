using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Services.Crud;

namespace FireTrace.Core.Services.Resources;

/// <summary>Alterações ao estado de uma viatura (muda muitas vezes, por isso tem endpoints próprios).</summary>
public sealed class VehicleStateService(CrudService<Vehicle> vehicles, TimeProvider clock)
{
    public async Task<VehicleState> GetAsync(string id, CancellationToken ct) => (await vehicles.GetAsync(id, ct)).State;

    public async Task<VehicleState> PatchAsync(string id, System.Text.Json.JsonElement patch, CancellationToken ct)
    {
        var vehicle = await vehicles.GetAsync(id, ct);
        var state = MergePatch.Apply(vehicle.State, patch) with { UpdatedAt = clock.GetUtcNow() };
        if (state.CrewOnboard > vehicle.CrewCapacity) throw new ValidationException($"Há mais pessoas a bordo ({state.CrewOnboard}) do que a capacidade ({vehicle.CrewCapacity}).", "/crewOnboard");
        return (await vehicles.SaveAsync(vehicle with { State = state }, ct)).State;
    }
}
