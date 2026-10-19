using System.Text.Json;
using System.Text.RegularExpressions;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Domain.Plans;

namespace FireTrace.Core.Models.Operations;

public sealed record PlanSummary(string Id, string Title, string? Variant, string? Strategy, PlanStatus Status, AlertLevel? AlertLevel, ActorRef? Author,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, IReadOnlyList<string> OrganizationIds, ActionCounts ActionCounts)
{
    public static PlanSummary Of(Plan p) => new(p.Id, p.Title, p.Variant, p.Strategy, p.Status, p.AlertLevel, p.Author, p.CreatedAt, p.UpdatedAt,
        p.Actions.SelectMany(a => (a.SupportingOrganizationIds ?? new()).Prepend(a.OrganizationId)).Distinct().ToList(),
        new ActionCounts(p.Actions.Count, p.Actions.Count(a => a.Status == ActionStatus.Completed), p.Actions.Count(a => a.Status == ActionStatus.InProgress), p.Actions.Count(a => a.Status == ActionStatus.Blocked)));
}
