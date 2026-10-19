using FireTrace.Core.Domain.Interventions;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Fire;

/// <summary>De onde vêm as intervenções de um plano ou de despachos ativos (quem sabe de planos e despachos implementa isto; a simulação não depende deles).</summary>
public interface IInterventionProvider
{
    Task<IReadOnlyList<Intervention>> ForPlanAsync(string planId, CancellationToken ct = default);
    Task<IReadOnlyList<Intervention>> ForActiveDispatchesAsync(string locationId, CancellationToken ct = default);
}
