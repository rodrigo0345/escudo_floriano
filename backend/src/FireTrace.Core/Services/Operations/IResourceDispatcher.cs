using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Models.Operations;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Operations;

/// <summary>Como se despacha, atualiza e liberta um tipo de meio (viaturas e grupos de pessoal têm regras diferentes; acrescentar um tipo é acrescentar uma classe).</summary>
public interface IResourceDispatcher
{
    ResourceType Type { get; }
    Task<DispatchSubject?> FindAsync(string id, CancellationToken ct);
    IEnumerable<ValidationIssue> Check(DispatchSubject subject, DispatchInput input, int alreadyInBatch);
    Task AssignAsync(Dispatch dispatch, CancellationToken ct);
    /// <summary>Reflete no meio o estado, a responsabilidade e o alvo do despacho.</summary>
    Task SyncAsync(Dispatch dispatch, CancellationToken ct);
    Task ReleaseAsync(Dispatch dispatch, CancellationToken ct);
}
