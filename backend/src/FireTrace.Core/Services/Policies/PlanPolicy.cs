using System.Text.Json;
using System.Text.RegularExpressions;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Services.Crud;
using FireTrace.Core.Services.Operations;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Policies;

/// <summary>Planos: validam-se ao criar e alterar, e só se apagam enquanto não estiverem ou tenham estado em execução.</summary>
public sealed class PlanPolicy(PlanValidator validator) : EntityPolicy<Plan>("pla")
{
    public override async Task<IEnumerable<ValidationIssue>> ValidateAsync(Plan plan, CancellationToken ct) => (await validator.ValidateAsync(plan, ct)).Issues;

    public override void EnsureDeletable(Plan plan)
    {
        if (plan.Status is not (PlanStatus.Proposed or PlanStatus.Selected or PlanStatus.Discarded))
            throw new ConflictException($"Um plano '{EnumText.ToSnake(plan.Status)}' não se apaga; feche-o com PATCH.", "invalid_transition");
    }
}
