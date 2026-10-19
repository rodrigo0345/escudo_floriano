using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Plans;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Operations;

public sealed record DispatchPatch(Responsibility? Responsibility = null, int? Personnel = null, Target? Target = null, DispatchStatus? Status = null, string? Notes = null);
