using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans;

public sealed record PlanStatusChange(PlanStatus Status, DateTimeOffset At, ActorRef? By = null, string? Reason = null);
