using System.Globalization;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Models.Resources;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Controllers.Binding;

/// <summary>Lê os parâmetros de pesquisa de um pedido: texto, números, datas e listas separadas por vírgulas (`?status=a,b`).</summary>
public sealed class Query(HttpRequest request)
{
    string? Raw(string key) => request.Query.TryGetValue(key, out var v) && v.Count > 0 && v[0] is { Length: > 0 } s ? s : null;

    public string? Str(string key) => Raw(key);
    public int? Int(string key) => int.TryParse(Raw(key), out var v) ? v : null;
    public double? Dbl(string key) => double.TryParse(Raw(key), CultureInfo.InvariantCulture, out var v) ? v : null;
    public bool? Bool(string key) => bool.TryParse(Raw(key), out var v) ? v : null;
    public DateTimeOffset? Time(string key) => DateTimeOffset.TryParse(Raw(key), out var v) ? v : null;

    public double RequiredDbl(string key) => Dbl(key) ?? throw new ValidationException($"Falta o parâmetro '{key}'.", $"/{key}");
    public int RequiredInt(string key) => Int(key) ?? throw new ValidationException($"Falta o parâmetro '{key}'.", $"/{key}");
    public string RequiredStr(string key) => Str(key) ?? throw new ValidationException($"Falta o parâmetro '{key}'.", $"/{key}");
    public DateTimeOffset RequiredTime(string key) => Time(key) ?? throw new ValidationException($"Falta o parâmetro '{key}'.", $"/{key}");

    /// <summary>Lista de valores de uma enumeração (`snake_case`), vazia se não vier no pedido.</summary>
    public HashSet<T> Enums<T>(string key) where T : struct, Enum =>
        Strings(key).Select(s => EnumText.TryParse<T>(s, out var e) ? e : throw new ValidationException($"Valor inválido '{s}' em '{key}'.", $"/{key}")).ToHashSet();

    public HashSet<string> Strings(string key) => (Raw(key)?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries) ?? Array.Empty<string>()).ToHashSet();

    /// <summary>`lat,lon`.</summary>
    public LatLon? Point(string key)
    {
        var p = Raw(key)?.Split(',');
        return p is { Length: 2 } && double.TryParse(p[0], CultureInfo.InvariantCulture, out var lat) && double.TryParse(p[1], CultureInfo.InvariantCulture, out var lon) ? new(lat, lon) : null;
    }

    /// <summary>`lat` and `lon` as two separate parameters (a required point).</summary>
    public LatLon RequiredLatLon() => new(RequiredDbl("lat"), RequiredDbl("lon"));

    /// <summary>`organizationId`, `organizationType`, `stationId` e `locationId`: os filtros de pertença comuns.</summary>
    public OwnerQuery Owner() => new(Str("organizationId"), Str("stationId"), Str("locationId"), Enums<OrganizationType>("organizationType"));

    /// <summary>`west,south,east,north`.</summary>
    public (double West, double South, double East, double North)? Bbox(string key)
    {
        var p = Raw(key)?.Split(',').Select(s => double.TryParse(s, CultureInfo.InvariantCulture, out var v) ? v : double.NaN).ToArray();
        return p is { Length: 4 } && p.All(double.IsFinite) ? (p[0], p[1], p[2], p[3]) : null;
    }
}
