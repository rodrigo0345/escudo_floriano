using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Errors;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans;

public sealed record PlanValidation(bool Valid, DateTimeOffset CheckedAt, List<ValidationIssue> Issues);
