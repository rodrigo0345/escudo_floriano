using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Errors;

public sealed class ConflictException(string message, string code = "conflict") : ApiException(message, code, 409);
