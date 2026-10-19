using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record ActionProgress(DateTimeOffset? AcknowledgedAt = null, DateTimeOffset? StartedAt = null, DateTimeOffset? CompletedAt = null, string? Note = null, ActorRef? UpdatedBy = null);
