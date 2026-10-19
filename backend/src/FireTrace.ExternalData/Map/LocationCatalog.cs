using System.Text.Json;

namespace FireTrace.ExternalData.Map;

/// <summary>Os locais disponíveis (ficheiros locations/*.json). Um novo local é só um novo ficheiro.</summary>
public sealed class LocationCatalog
{
    static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { ReadCommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
    readonly Dictionary<string, LocationDefinition> _byId;

    public LocationCatalog(IEnumerable<LocationDefinition> defs)
    {
        All = defs.ToList();
        _byId = All.ToDictionary(d => d.Id, StringComparer.OrdinalIgnoreCase);
    }

    public IReadOnlyList<LocationDefinition> All { get; }
    public LocationDefinition? Find(string id) => _byId.GetValueOrDefault(id);
    public LocationDefinition Get(string id) => Find(id) ?? throw new KeyNotFoundException($"Local desconhecido: {id}");

    public static LocationCatalog FromDirectory(string dir) =>
        new(Directory.Exists(dir) ? Directory.GetFiles(dir, "*.json").OrderBy(f => f).Select(Load).ToList() : new List<LocationDefinition>());

    static LocationDefinition Load(string file)
    {
        var d = JsonSerializer.Deserialize<LocationDefinition>(File.ReadAllText(file), Options) ?? throw new InvalidDataException($"Local inválido: {file}");
        if (string.IsNullOrWhiteSpace(d.Id)) d.Id = Path.GetFileNameWithoutExtension(file);
        if (d.WeatherPoint.Lat == 0 && d.WeatherPoint.Lon == 0) d.WeatherPoint = d.Center;
        return d;
    }
}
