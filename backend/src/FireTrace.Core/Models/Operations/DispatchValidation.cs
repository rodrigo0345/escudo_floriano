using FireTrace.Core.Domain.Errors;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Operations;

public sealed record DispatchValidation(bool Valid, IReadOnlyList<ValidationIssue> Issues, IReadOnlyList<DispatchEta> Etas);
