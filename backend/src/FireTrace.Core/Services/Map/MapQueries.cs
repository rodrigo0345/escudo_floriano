using System.Runtime.CompilerServices;
using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Fuel;
using FireTrace.Core.Domain.Weather;
using FireTrace.Core.Models.Map;
using FireTrace.Core.Services.Fire;
using FireTrace.Engine.Weather;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Map;

/// <summary>Tudo o que se pergunta ao mapa: o local, as estradas, os pontos de interesse, o terreno, a vegetação e as zonas.</summary>
public sealed class MapQueries(IMapReader map, FuelCatalog fuels, Population population, MapSettings settings, Fire.LandscapeBuilder landscape)
{
    static readonly GeometryFactory Gf = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);
    readonly ConditionalWeakTable<RoadNetwork, RoadGeo[]> _roadCache = new();
    readonly ConditionalWeakTable<RoadNetwork, RoadIndex> _indexCache = new();

    sealed record RoadGeo(RoadEdge Edge, LineString Line, Envelope Box);

    public RoadIndex IndexOf(RoadNetwork net) => _indexCache.GetValue(net, n => new RoadIndex(n));

    // ===================================================================================================== local
    public async Task<LocationView> LocationAsync(string id, CancellationToken ct = default)
    {
        var def = map.Locations.Find(id) ?? throw new NotFoundException($"Local '{id}'");
        TerrainGrids terrain;
        try
        {
            terrain = await map.GetTerrainAsync(id, ct);
        }
        catch (InvalidOperationException)
        {
            throw new ServiceUnavailableException($"O local '{id}' ainda está a carregar dados (ingest em curso). Tente novamente em instantes.");
        }
        var layers = new List<LayerInfo>();
        if (await map.GetRenderHeightmapAsync(id, ct) is not null)
            layers.Add(new LayerInfo("heightmap", "heightmap", LayerUrl(id, "heightmap"), "image/png"));
        foreach (var a in await map.GetImageryAsync(id, ct))
            layers.Add(new LayerInfo(a.Kind, a.Kind switch { "species" => "vegetation", "satellite" => "satellite", _ => "orthophoto" }, LayerUrl(id, a.Kind),
                a.Path.EndsWith(".png") ? "image/png" : "image/jpeg", a.Attribution, a.Bounds));
        var sources = layers.Select(l => l.Attribution).Where(a => a is not null).Cast<string>().Distinct()
            .Concat(new[] { "AWS Terrain Tiles (Terrarium)", "© OpenStreetMap contributors (ODbL)", "Open-Meteo (ERA5 / previsão)" }).ToList();
        return new LocationView(def.Id, def.Name, def.Center, def.WeatherPoint, def.Spec.Bounds, "Europe/Lisbon", GridInfo.Of(def.Spec), GridInfo.Of(def.RenderSpec),
            new NumberRange(terrain.Elevation.Min(), terrain.Elevation.Max()), layers, sources);
    }

    public async Task<IReadOnlyList<LocationView>> LocationsAsync(CancellationToken ct = default)
    {
        var list = new List<LocationView>();
        foreach (var l in map.Locations.All)
        {
            try
            {
                list.Add(await LocationAsync(l.Id, ct));
            }
            catch (ServiceUnavailableException)
            {
                // Local ainda sem relevo carregado (ingest a correr em segundo plano)
            }
        }
        return list;
    }

    static string LayerUrl(string loc, string layer) => $"/api/v1/locations/{loc}/layers/{layer}";

    /// <summary>Imagem de uma camada (heightmap, satélite, ortofoto ou mapa de espécies).</summary>
    public async Task<LayerFile> LayerAsync(string loc, string layerId, CancellationToken ct = default)
    {
        map.Locations.Get(loc);
        if (layerId == "heightmap")
            return new(null, HeightmapPng.Encode(await map.GetRenderHeightmapAsync(loc, ct) ?? throw new NotFoundException("Relevo de desenho")), "image/png");
        var asset = (await map.GetImageryAsync(loc, ct)).FirstOrDefault(a => a.Kind == layerId) ?? throw new NotFoundException($"Camada '{layerId}'");
        var path = Path.GetFullPath(Path.Combine(map.DataDir, asset.Path));
        if (!map.FileExists(path)) throw new NotFoundException($"Ficheiro da camada '{layerId}'");
        return new(path, null, path.EndsWith(".png") ? "image/png" : "image/jpeg");
    }

    // ===================================================================================================== estradas
    RoadGeo[] Roads(RoadNetwork net) => _roadCache.GetValue(net, n => n.Edges.Select(e =>
    {
        var coords = Enumerable.Range(0, e.Pts.Length / 2).Select(i => { var (lat, lon) = n.Spec.ToLatLon(e.Pts[2 * i], e.Pts[2 * i + 1]); return new Coordinate(Math.Round(lon, 6), Math.Round(lat, 6)); }).ToArray();
        var line = Gf.CreateLineString(coords);
        return new RoadGeo(e, line, line.EnvelopeInternal);
    }).ToArray());

    /// <param name="status">Estado (e corte ativo) de cada troço num instante, se foi pedido.</param>
    public async Task<FeatureCollection<Feature<RoadProperties>>> RoadsAsync(string loc, (double West, double South, double East, double North)? bbox, ISet<string> classes,
        Func<RoadEdge, (string Status, string? ClosureId)>? status = null, CancellationToken ct = default)
    {
        var net = await map.GetRoadsAsync(loc, ct);
        var box = bbox is { } b ? new Envelope(b.West, b.East, b.South, b.North) : null;
        var features = Roads(net).Where(r => (classes.Count == 0 || classes.Contains(r.Edge.Highway)) && (box is null || box.Intersects(r.Box))).Select(r =>
        {
            var (st, closure) = status is null ? ((string?)null, (string?)null) : status(r.Edge);
            return new Feature<RoadProperties>(r.Line, new RoadProperties(MapIds.Road(r.Edge.Id), r.Edge.Name, r.Edge.Ref == "" ? null : r.Edge.Ref, r.Edge.Highway,
                Math.Round(r.Edge.LengthCells * net.Spec.CellM), r.Edge.OffRoad, r.Edge.TrackType, r.Edge.WidthM, st, closure), MapIds.Road(r.Edge.Id));
        }).ToList();
        return new FeatureCollection<Feature<RoadProperties>>(features);
    }

    // ===================================================================================================== pontos de interesse
    public async Task<IReadOnlyList<PlaceView>> PlacesAsync(string loc, CancellationToken ct = default) =>
        (await map.GetPlacesAsync(loc, ct)).Select(p => new PlaceView(MapIds.Place(p.Id), p.Name, p.Kind, new(p.Lat, p.Lon), p.Population, p.PopulationEstimated)).ToList();

    public async Task<IReadOnlyList<FacilityView>> FacilitiesAsync(string loc, CancellationToken ct = default) =>
        (await map.GetFacilitiesAsync(loc, ct)).Select(f => new FacilityView(MapIds.Facility(f.Id), f.Name, EnumText.ToSnake(f.Kind), new(f.Lat, f.Lon), f.Operator, f.Capacity, f.Vulnerable,
            f.Source == "osm" ? "osm" : "curated", f.Confidence >= settings.ConfidenceHigh ? "high" : f.Confidence >= settings.ConfidenceMedium ? "medium" : "low")).ToList();

    public async Task<IReadOnlyList<WaterPointView>> WaterPointsAsync(string loc, CancellationToken ct = default) =>
        (await map.GetWaterPointsAsync(loc, ct)).Select(w => new WaterPointView(MapIds.Water(w.Id), EnumText.ToSnake(w.Kind), w.Name, new(w.Lat, w.Lon), w.Ref, w.CapacityL, w.CapacityEstimated,
            w.FlowLpm, w.AreaM2, w.DiameterMm, w.HydrantType, w.TruckAccessible, w.HelicopterAccessible, w.NearestRoadId is { } r ? MapIds.Road(r) : null, w.RoadDistanceM, w.Access,
            w.Source, w.OsmId)).ToList();

    public static IReadOnlyList<WaterPointNear> Nearest(IEnumerable<WaterPointView> points, LatLon at, double radiusM, int limit) =>
        points.Select(p => (P: p, D: RoadGeometry.DistanceM(at.Lat, at.Lon, p.Position.Lat, p.Position.Lon))).Where(t => t.D <= radiusM)
            .OrderBy(t => t.D).Take(Math.Clamp(limit, 1, 200)).Select(t => new WaterPointNear(t.P, Math.Round(t.D))).ToList();

    public async Task<FeatureCollection<Feature<FirebreakProperties>>> FirebreaksAsync(string loc, (double West, double South, double East, double North)? bbox, ISet<FirebreakKind> kinds,
        bool maintainedOnly, CancellationToken ct = default)
    {
        var box = bbox is { } b ? new Envelope(b.West, b.East, b.South, b.North) : null;
        var items = (await map.GetFirebreaksAsync(loc, ct)).Where(f => (kinds.Count == 0 || kinds.Contains(f.Kind)) && (!maintainedOnly || f.Maintained) && (box is null || box.Intersects(f.Geometry.EnvelopeInternal)))
            .Select(f => new Feature<FirebreakProperties>(f.Geometry, new FirebreakProperties(MapIds.Firebreak(f.Id), EnumText.ToSnake(f.Kind), f.Name, f.WidthM, f.Maintained, f.Source), MapIds.Firebreak(f.Id))).ToList();
        return new FeatureCollection<Feature<FirebreakProperties>>(items);
    }

    // ===================================================================================================== vegetação, edifícios, terreno
    public async Task<VegetationInfo> VegetationAsync(string loc, CancellationToken ct = default)
    {
        var t = await map.GetTerrainAsync(loc, ct);
        var counts = new int[fuels.Count];
        foreach (var c in t.LandCover) if (c < counts.Length) counts[c]++;
        var classes = fuels.All.Skip(1).Select(m => new VegetationClass(m.Id, m.Key, m.Label, m.Color, m.Fbfm40, m.CanopyCoverPct, m.CanopyHeightM, m.CanopyBaseHeightM, m.BurnMinutes,
            Math.Round(100.0 * counts[m.Id] / t.LandCover.Length, 1))).ToList();
        return new VegetationInfo(loc, classes, "ESA WorldCover 2021 + Copernicus HRL Forest Type 2018 + fenologia Sentinel-2",
            "Eucaliptal vs. folhosas é uma inferência por fenologia, sem verdade de terreno.", $"/api/v1/locations/{loc}/grids/vegetation");
    }

    public async Task<BuildingCollection> BuildingsAsync(string loc, (double West, double South, double East, double North)? bbox, int minBuildings, int limit, CancellationToken ct = default)
    {
        var t = await map.GetTerrainAsync(loc, ct);
        var box = bbox is { } b ? new Envelope(b.West, b.East, b.South, b.North) : null;
        var features = new List<Feature<BuildingProperties>>();
        long total = 0;
        for (int i = 0; i < t.Buildings.Length; i++)
        {
            if (t.Buildings[i] < minBuildings) continue;
            var (lat, lon) = t.Spec.ToLatLon(i % t.Spec.Width, i / t.Spec.Width);
            if (box is not null && !box.Contains(lon, lat)) continue;
            total += t.Buildings[i];
            if (features.Count < limit) features.Add(new(Gf.CreatePoint(new Coordinate(Math.Round(lon, 6), Math.Round(lat, 6))), new BuildingProperties(t.Buildings[i], population.Of(t.Buildings[i]))));
        }
        return new BuildingCollection(features, new BuildingTotals(total, population.Of((int)Math.Min(total, int.MaxValue / 3)), t.Spec.CellM), population.PerBuilding);
    }

    public async Task<GridData> GridAsync(string loc, GridLayerName layer, CancellationToken ct = default)
    {
        var t = await map.GetTerrainAsync(loc, ct);
        byte[] F(float[] v) { var b = new byte[v.Length * 4]; Buffer.BlockCopy(v, 0, b, 0, b.Length); return b; }
        byte[] U(ushort[] v) { var b = new byte[v.Length * 2]; Buffer.BlockCopy(v, 0, b, 0, b.Length); return b; }
        var (bytes, dtype) = layer switch
        {
            GridLayerName.Elevation => (F(t.Elevation), "float32"),
            GridLayerName.Slope => (F(t.Slope), "float32"),
            GridLayerName.Aspect => (F(t.Aspect), "float32"),
            GridLayerName.Vegetation => (t.LandCover, "uint8"),
            GridLayerName.Buildings => (U(t.Buildings), "uint16"),
            GridLayerName.Barriers => (landscape.BarrierStrength(t, await map.GetRoadsAsync(loc, ct), await map.GetWaterwaysAsync(loc, ct)), "uint8"),
            GridLayerName.Riparian => (landscape.RiparianSlowdownPct(t, await map.GetWaterwaysAsync(loc, ct)), "uint8"),
            _ => (U(t.Buildings.Select(b => (ushort)Math.Min(ushort.MaxValue, population.Of(b))).ToArray()), "uint16"),
        };
        return new GridData(bytes, t.Spec.Width, t.Spec.Height, t.Spec.CellM, dtype);
    }

    public async Task<TerrainPoint> TerrainAtAsync(string loc, double lat, double lon, CancellationToken ct = default)
    {
        var t = await map.GetTerrainAsync(loc, ct);
        int cell = t.Spec.CellAt(lat, lon);
        if (cell < 0) throw new ValidationException("O ponto está fora do local.", "/lat");
        var fuel = fuels.Get(t.LandCover[cell]);
        var road = IndexOf(await map.GetRoadsAsync(loc, ct)).Nearest(lat, lon, settings.NearestRoadMaxM);
        var water = (await map.GetWaterPointsAsync(loc, ct)).Select(w => (W: w, D: RoadGeometry.DistanceM(lat, lon, w.Lat, w.Lon))).OrderBy(x => x.D).FirstOrDefault();
        var place = (await map.GetPlacesAsync(loc, ct)).Select(p => (P: p, D: RoadGeometry.DistanceM(lat, lon, p.Lat, p.Lon))).OrderBy(x => x.D).FirstOrDefault();
        return new TerrainPoint(new(lat, lon), Math.Round(t.Elevation[cell], 1), Math.Round(t.Slope[cell], 1), Math.Round(t.Aspect[cell]),
            fuel.Id == 0 ? null : new VegetationAt(fuel.Id, fuel.Key, fuel.Label, fuel.Fbfm40), t.Buildings[cell], population.Of(t.Buildings[cell]),
            road is { } r ? new NearestRoad(MapIds.Road(r.Edge.Id), r.Edge.Highway, Math.Round(r.DistanceM)) : null,
            water.W is null ? null : new NearestWater(MapIds.Water(water.W.Id), EnumText.ToSnake(water.W.Kind), Math.Round(water.D)),
            place.P is null ? null : new NearestPlace(MapIds.Place(place.P.Id), place.P.Name, Math.Round(place.D)));
    }

    // ===================================================================================================== zonas
    public async Task<AreaStats> AreaStatsAsync(string loc, Geometry area, CancellationToken ct = default)
    {
        var t = await map.GetTerrainAsync(loc, ct);
        var spec = t.Spec;
        var env = area.EnvelopeInternal;
        var prepared = NetTopologySuite.Geometries.Prepared.PreparedGeometryFactory.Prepare(area);
        var cells = new List<int>();
        var (x0, y1) = spec.ToCell(env.MinY, env.MinX); var (x1, y0) = spec.ToCell(env.MaxY, env.MaxX);
        for (int y = Math.Max(0, (int)Math.Floor(y0)); y <= Math.Min(spec.Height - 1, (int)Math.Ceiling(y1)); y++)
            for (int x = Math.Max(0, (int)Math.Floor(x0)); x <= Math.Min(spec.Width - 1, (int)Math.Ceiling(x1)); x++)
            {
                var (lat, lon) = spec.ToLatLon(x, y);
                if (prepared.Contains(Gf.CreatePoint(new Coordinate(lon, lat)))) cells.Add(y * spec.Width + x);
            }
        double cellHa = spec.CellM * spec.CellM / 1e4;
        int buildings = cells.Sum(c => (int)t.Buildings[c]);
        var veg = cells.GroupBy(c => fuels.Get(t.LandCover[c])).OrderByDescending(g => g.Count())
            .Select(g => new VegetationShare(g.Key.Key, g.Key.Label, Math.Round(100.0 * g.Count() / Math.Max(cells.Count, 1), 1))).ToList();
        var elevations = cells.Select(c => (double)t.Elevation[c]).ToList();

        bool Inside(double lat, double lon) => prepared.Contains(Gf.CreatePoint(new Coordinate(lon, lat)));
        var places = (await map.GetPlacesAsync(loc, ct)).Where(p => Inside(p.Lat, p.Lon)).Select(p => new PlaceInArea(MapIds.Place(p.Id), p.Name, p.Population)).ToList();
        var facilities = (await map.GetFacilitiesAsync(loc, ct)).Where(f => Inside(f.Lat, f.Lon)).OrderByDescending(f => f.Vulnerable)
            .Select(f => new FacilityInArea(MapIds.Facility(f.Id), f.Name, EnumText.ToSnake(f.Kind), f.Vulnerable, f.Capacity)).ToList();
        var inside = Roads(await map.GetRoadsAsync(loc, ct)).Where(r => r.Box.Intersects(env) && prepared.Intersects(r.Line)).ToList();
        var byClass = inside.GroupBy(r => r.Edge.Highway).Select(g => new RoadClassLength(g.Key, Math.Round(g.Sum(r => GeodesicKm(r.Line)), 2))).ToList();
        var water = (await map.GetWaterPointsAsync(loc, ct)).Where(w => Inside(w.Lat, w.Lon)).ToList();
        double fbKm = (await map.GetFirebreaksAsync(loc, ct)).Where(f => prepared.Intersects(f.Geometry)).Sum(f => GeodesicKm(area.Intersection(f.Geometry)));

        return new AreaStats(Math.Round(cells.Count * cellHa, 1), buildings, population.Of(buildings), veg,
            elevations.Count == 0 ? new(0, 0, 0) : new(Math.Round(elevations.Min()), Math.Round(elevations.Max()), Math.Round(elevations.Average())),
            cells.Count == 0 ? 0 : Math.Round(cells.Average(c => (double)t.Slope[c]), 1), places, facilities,
            new RoadsInArea(inside.Count, Math.Round(byClass.Sum(c => c.LengthKm), 2), byClass),
            new WaterInArea(water.Count, water.GroupBy(w => EnumText.ToSnake(w.Kind)).Select(g => new CountBreakdown(g.Key, g.Count(), g.Count(w => w.TruckAccessible))).ToList()),
            new FirebreaksInArea(Math.Round(fbKm, 2)));
    }

    /// <summary>Comprimento em km de uma geometria em WGS84 (somando segmentos com a distância na esfera).</summary>
    public static double GeodesicKm(Geometry g)
    {
        double m = 0;
        for (int gi = 0; gi < g.NumGeometries; gi++)
        {
            var part = g.GetGeometryN(gi);
            if (part is not LineString ls) continue;
            for (int i = 1; i < ls.NumPoints; i++)
                m += RoadGeometry.DistanceM(ls.GetCoordinateN(i - 1).Y, ls.GetCoordinateN(i - 1).X, ls.GetCoordinateN(i).Y, ls.GetCoordinateN(i).X);
        }
        return m / 1000;
    }
}
