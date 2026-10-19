using System.Text.Json;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Overpass;

namespace FireTrace.ExternalData.Sources.Buildings;

/// <summary>Conta edifícios por célula, ignorando os que já foram contados (os blocos vizinhos repetem os elementos da fronteira).</summary>
public sealed class BuildingCellCounter(GridSpec spec)
{
    readonly HashSet<long> _seen = new();

    public ushort[] Grid { get; } = new ushort[spec.CellCount];
    public int BuildingCount => _seen.Count;

    public void Add(IEnumerable<JsonElement> elements)
    {
        foreach (var el in elements)
        {
            var c = el.TryGetProperty("center", out var center) ? center : el;
            if (!c.TryGetProperty("lat", out var latProp) || !c.TryGetProperty("lon", out var lonProp)) continue;
            string type = el.TryGetProperty("type", out var t) ? t.GetString() ?? "" : "";
            long typeOffset = type switch { "way" => 0, "relation" => 1, _ => 2 };
            if (!el.TryGetProperty("id", out var idProp) || !_seen.Add(idProp.GetInt64() * 4 + typeOffset)) continue;
            int cell = spec.CellAt(latProp.GetDouble(), lonProp.GetDouble());
            if (cell >= 0 && Grid[cell] < ushort.MaxValue) Grid[cell]++;
        }
    }
}
