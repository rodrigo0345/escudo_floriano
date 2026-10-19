using System.Text.Json.Serialization;
using FireTrace.Core.Configuration;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Map;

/// <summary>Estimativa de pessoas a partir do nº de edifícios: pessoas por edifício de `FireTrace:Map` (só população residente, sem ocupação sazonal).</summary>
public sealed class Population(MapSettings settings)
{
    public double PerBuilding => settings.PersonsPerBuilding;
    public int Of(int buildings) => (int)Math.Round(buildings * settings.PersonsPerBuilding);
}
