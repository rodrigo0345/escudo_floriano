using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Errors;

public sealed class UnsupportedException(string capability) : ApiException($"'{capability}' ainda não é suportado por este servidor (ver /capabilities).", "unsupported_capability", 501);
