using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Plans.Actions;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans;

/// <summary>Uma tarefa na lista de trabalho de uma organização.</summary>
public sealed record TaskItem(string PlanId, string? PlanTitle, PlanStatus PlanStatus, PlanAction Action);
