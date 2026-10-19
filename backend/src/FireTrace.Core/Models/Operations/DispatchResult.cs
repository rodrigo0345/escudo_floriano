using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Errors;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Operations;

public sealed record DispatchResult(IReadOnlyList<Dispatch> Items, IReadOnlyList<ValidationIssue> Warnings);
