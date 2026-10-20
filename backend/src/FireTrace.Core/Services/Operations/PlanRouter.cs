using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Repositories;
using FireTrace.Core.Domain.Resources;

namespace FireTrace.Core.Services.Operations;

/// <summary>
/// As rotas e os tempos de chegada de um plano são do servidor: para cada viatura terrestre põe a rota por estrada e o `etaMinutes` calculados, no lugar do que o cliente enviou
/// (um cliente simplifica as rotas e corta curvas; o plano guardado tem de mostrar por onde a viatura vai de facto). Sem caminho não se mexe: a validação recusa o plano.
/// </summary>
public sealed class PlanRouter(ArrivalEstimator arrival, IDocumentStore<Vehicle> vehicles)
{
    public async Task<Plan> ApplyAsync(Plan plan, CancellationToken ct = default)
    {
        var actions = new List<PlanAction>();
        foreach (var action in plan.Actions)
        {
            if (action.Resources is not { Count: > 0 } resources) { actions.Add(action); continue; }
            var routed = new List<ResourceAssignment>();
            foreach (var r in resources)
            {
                if (r.ResourceType == ResourceType.Vehicle && await vehicles.GetAsync(r.ResourceId, ct) is { } v && !ArrivalEstimator.IsAerial(v.Type)
                    && await arrival.ForActionAsync(plan, action, v, r, ct) is { Minutes: { } minutes, Route: { } route })
                    routed.Add(r with { Route = route, EtaMinutes = minutes });
                else routed.Add(r);
            }
            actions.Add(action with { Resources = routed });
        }
        return plan with { Actions = actions };
    }
}
