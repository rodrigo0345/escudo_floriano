using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Models.Paging;
using FireTrace.Core.Services.Operations;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Controllers;

/// <summary>A lista de trabalho: ações de planos ativos (ou do estado pedido), por prioridade.</summary>
[Route("/api/v1/actions")]
public sealed class ActionsController(PlanService service) : ApiController
{
    [HttpGet]
    public async Task<ActionResult<Page<TaskItem>>> List([FromQuery] Query q, [FromQuery] PageQuery page, CancellationToken ct)
    {
        var planStatuses = q.Enums<PlanStatus>("planStatus");
        var statuses = q.Enums<ActionStatus>("status");
        var types = q.Strings("type");
        var organizationId = q.Str("organizationId");
        var tasks = await service.TasksAsync(
            p => planStatuses.Count == 0 ? p.Status == PlanStatus.Active : planStatuses.Contains(p.Status),
            a => (organizationId is null || a.OrganizationId == organizationId || a.SupportingOrganizationIds?.Contains(organizationId) == true)
                && (statuses.Count == 0 || statuses.Contains(a.Status)) && (types.Count == 0 || types.Contains(ActionTypeName.Of(a))), ct);
        return Ok(page.Apply(tasks, t => t.Action.Progress?.CompletedAt ?? DateTimeOffset.MinValue));
    }
}
