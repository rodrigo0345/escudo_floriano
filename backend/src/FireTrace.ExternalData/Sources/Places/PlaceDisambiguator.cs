using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Places;

public static class PlaceDisambiguator
{
    /// <summary>Nomes repetidos (ex.: duas «Penha») ficam distintos, e as localidades mais populosas primeiro.</summary>
    public static List<Place> Apply(IEnumerable<Place> places)
    {
        var seen = new Dictionary<string, int>();
        return places.OrderByDescending(p => p.Population).Select(p =>
        {
            seen[p.Name] = seen.GetValueOrDefault(p.Name) + 1;
            return seen[p.Name] == 1 ? p : p with { Name = $"{p.Name} ({seen[p.Name]})" };
        }).ToList();
    }
}
