using FireTrace.Core.Configuration;
using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Models.Map;
using FireTrace.Core.Models.Paging;
using FireTrace.Core.Services.Map;
using FireTrace.Core.Services.Routing;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Controllers;

/// <summary>O mapa base de cada local (só leitura): o local e as suas camadas, estradas, pontos de interesse, água, vegetação, edifícios e terreno.</summary>
[Route("/api/v1/locations")]
public sealed class LocationsController(MapQueries map, RoadStatusResolver roadStatus, RoutingService routing, DefaultsSettings defaults) : ApiController
{
    [HttpGet]
    public async Task<ActionResult<Page<LocationView>>> List([FromQuery] PageQuery page, CancellationToken ct) => Ok(page.Apply(await map.LocationsAsync(ct)));

    [HttpGet("{loc}")]
    public async Task<ActionResult<LocationView>> Get(string loc, CancellationToken ct) => Ok(await map.LocationAsync(loc, ct));

    [HttpGet("{loc}/layers/{layerId}")]
    public async Task<IActionResult> Layer(string loc, string layerId, CancellationToken ct)
    {
        var file = await map.LayerAsync(loc, layerId, ct);
        return file.Path is not null ? PhysicalFile(file.Path, file.MediaType) : File(file.Bytes!, file.MediaType);
    }

    [HttpGet("{loc}/roads")]
    public async Task<ActionResult<FeatureCollection<Feature<RoadProperties>>>> Roads(string loc, [FromQuery] Query q, CancellationToken ct)
    {
        var status = q.Time("at") is { } at ? await roadStatus.ForAsync(loc, at, q.Str("simulationId"), q.Str("percentile") ?? "p50", ct) : null;
        return Ok(await map.RoadsAsync(loc, q.Bbox("bbox"), q.Strings("class"), status, ct));
    }

    [HttpGet("{loc}/places")]
    public async Task<ActionResult<Page<PlaceView>>> Places(string loc, [FromQuery] Query q, [FromQuery] PageQuery page, CancellationToken ct)
    {
        var kinds = q.Strings("kind");
        int minPopulation = q.Int("minPopulation") ?? 0;
        return Ok(page.Apply((await map.PlacesAsync(loc, ct)).Where(p => (kinds.Count == 0 || kinds.Contains(p.Kind)) && p.Population >= minPopulation)));
    }

    [HttpGet("{loc}/facilities")]
    public async Task<ActionResult<Page<FacilityView>>> Facilities(string loc, [FromQuery] Query q, [FromQuery] PageQuery page, CancellationToken ct)
    {
        var kinds = q.Strings("kind");
        var vulnerable = q.Bool("vulnerable");
        return Ok(page.Apply((await map.FacilitiesAsync(loc, ct)).Where(f => (kinds.Count == 0 || kinds.Contains(f.Kind)) && (vulnerable is null || f.Vulnerable == vulnerable))));
    }

    [HttpGet("{loc}/water-points")]
    public async Task<ActionResult<Page<WaterPointView>>> WaterPoints(string loc, [FromQuery] Query q, [FromQuery] PageQuery page, CancellationToken ct) =>
        Ok(page.Apply(FilterWater(await map.WaterPointsAsync(loc, ct), q)));

    [HttpGet("{loc}/water-points/near")]
    public async Task<ActionResult<WaterPointNearList>> WaterPointsNear(string loc, [FromQuery] Query q, CancellationToken ct)
    {
        var points = (await map.WaterPointsAsync(loc, ct)).Where(w => (q.Bool("truckOnly") != true || w.TruckAccessible) && (q.Bool("helicopterOnly") != true || w.HelicopterAccessible));
        var near = MapQueries.Nearest(FilterWater(points, q), q.RequiredLatLon(), q.Dbl("radiusM") ?? defaults.NearbyWaterRadiusM, q.Int("limit") ?? defaults.NearbyWaterLimit);
        if (q.Point("routeFrom") is { } from)
        {
            var minutes = await routing.DriveMinutesAsync(loc, from, near.Select(n => n.Point.Position).ToList(), ct);
            near = near.Select((n, i) => n with { DriveMinutes = minutes[i] }).ToList();
        }
        return Ok(new WaterPointNearList(near));
    }

    [HttpGet("{loc}/firebreaks")]
    public async Task<ActionResult<FeatureCollection<Feature<FirebreakProperties>>>> Firebreaks(string loc, [FromQuery] Query q, CancellationToken ct) =>
        Ok(await map.FirebreaksAsync(loc, q.Bbox("bbox"), q.Enums<FirebreakKind>("kind"), q.Bool("maintainedOnly") == true, ct));

    [HttpGet("{loc}/vegetation")]
    public async Task<ActionResult<VegetationInfo>> Vegetation(string loc, CancellationToken ct) => Ok(await map.VegetationAsync(loc, ct));

    [HttpGet("{loc}/buildings")]
    public async Task<ActionResult<BuildingCollection>> Buildings(string loc, [FromQuery] Query q, CancellationToken ct) =>
        Ok(await map.BuildingsAsync(loc, q.Bbox("bbox"), q.Int("minBuildings") ?? defaults.MinBuildings, q.Int("limit") ?? defaults.BuildingsLimit, ct));

    [HttpGet("{loc}/terrain-at")]
    public async Task<ActionResult<TerrainPoint>> TerrainAt(string loc, [FromQuery] Query q, CancellationToken ct) =>
        Ok(await map.TerrainAtAsync(loc, q.RequiredDbl("lat"), q.RequiredDbl("lon"), ct));

    [HttpPost("{loc}/area-stats")]
    public async Task<ActionResult<AreaStats>> AreaStats(string loc, [FromBody] AreaStatsRequest body, CancellationToken ct) => Ok(await map.AreaStatsAsync(loc, body.Geometry, ct));

    [HttpGet("{loc}/grids/{layer}")]
    public async Task<IActionResult> Grid(string loc, string layer, CancellationToken ct)
    {
        if (!Enum.TryParse<GridLayerName>(layer, true, out var name)) throw new ValidationException($"Camada desconhecida '{layer}'.", "/layer");
        return GridFile(await map.GridAsync(loc, name, ct));
    }

    static IEnumerable<WaterPointView> FilterWater(IEnumerable<WaterPointView> all, Query q)
    {
        var kinds = q.Strings("kind");
        var truck = q.Bool("truckAccessible");
        var helicopter = q.Bool("helicopterAccessible");
        var bbox = q.Bbox("bbox");
        var minCapacity = q.Dbl("minCapacityL");
        return all.Where(w => (kinds.Count == 0 || kinds.Contains(w.Kind)) && (truck is null || w.TruckAccessible == truck) && (helicopter is null || w.HelicopterAccessible == helicopter)
            && (bbox is not { } b || (w.Position.Lon >= b.West && w.Position.Lon <= b.East && w.Position.Lat >= b.South && w.Position.Lat <= b.North)) && (minCapacity is null || w.CapacityL >= minCapacity));
    }
}
