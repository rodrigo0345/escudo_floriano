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
            if (!el.TryGetProperty("center", out var c)) continue;
            if (!_seen.Add(el.GetProperty("id").GetInt64() * 4 + (el.GetProperty("type").GetString() == "way" ? 0 : 1))) continue;
            int cell = spec.CellAt(c.GetProperty("lat").GetDouble(), c.GetProperty("lon").GetDouble());
            if (cell >= 0 && Grid[cell] < ushort.MaxValue) Grid[cell]++;
        }
    }
}
