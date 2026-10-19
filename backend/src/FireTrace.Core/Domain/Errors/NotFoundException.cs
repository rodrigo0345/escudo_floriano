using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Errors;

public sealed class NotFoundException(string what) : ApiException($"{what} não existe.", "not_found", 404);
