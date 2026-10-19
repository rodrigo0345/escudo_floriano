using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Dispatches;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

/// <summary>Atualização feita por quem executa uma ação.</summary>
public sealed record ActionPatch(ActionStatus? Status = null, string? Note = null, DateTimeOffset? StartedAt = null, DateTimeOffset? CompletedAt = null, List<ResourceAssignment>? Resources = null);
