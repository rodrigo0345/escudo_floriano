using System.Text.Json;
using Dapper;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;
using Npgsql;
using NpgsqlTypes;

namespace FireTrace.ExternalData.Store;

/// <summary>Os dados do mapa em PostgreSQL/PostGIS (geometrias em WGS84). Lê para a API e escreve para o ingest.</summary>
public sealed class PostgisMapStore : IMapReader, IMapWriter
{
    readonly NpgsqlDataSource _db;

    public PostgisMapStore(NpgsqlDataSource db, LocationCatalog locations, string dataDir) { _db = db; Locations = locations; DataDir = dataDir; }

    public LocationCatalog Locations { get; }
    public string DataDir { get; }
    public bool FileExists(string path) => File.Exists(path);

    // ============================================================================================ locais e grelhas
    public async Task UpsertLocationAsync(LocationDefinition d, CancellationToken ct = default)
    {
        await using var c = await _db.OpenConnectionAsync(ct);
        await c.ExecuteAsync(@"INSERT INTO locations(id,name,definition) VALUES (@Id,@Name,@def::jsonb)
            ON CONFLICT (id) DO UPDATE SET name=@Name, definition=@def::jsonb, updated=now()",
            new { d.Id, d.Name, def = JsonSerializer.Serialize(d, new JsonSerializerOptions(JsonSerializerDefaults.Web)) });
    }

    public async Task SaveGridAsync(string loc, string layer, GridBlob g, CancellationToken ct = default)
    {
        await using var c = await _db.OpenConnectionAsync(ct);
        await c.ExecuteAsync(@"INSERT INTO grids(location_id,layer,width,height,cell_m,dtype,data) VALUES (@loc,@layer,@W,@H,@C,@D,@data)
            ON CONFLICT (location_id,layer) DO UPDATE SET width=@W,height=@H,cell_m=@C,dtype=@D,data=@data,updated=now()",
            new { loc, layer, W = g.Width, H = g.Height, C = g.CellM, D = g.DType, data = g.Data });
    }

    async Task<GridBlob?> LoadGridAsync(string loc, string layer, CancellationToken ct)
    {
        await using var c = await _db.OpenConnectionAsync(ct);
        var r = await c.QuerySingleOrDefaultAsync("SELECT width,height,cell_m,dtype,data FROM grids WHERE location_id=@loc AND layer=@layer", new { loc, layer });
        return r is null ? null : new GridBlob((int)r.width, (int)r.height, (double)r.cell_m, (string)r.dtype, (byte[])r.data);
    }

    public async Task<TerrainGrids> GetTerrainAsync(string loc, CancellationToken ct = default)
    {
        var spec = Locations.Get(loc).Spec;
        var dem = await LoadGridAsync(loc, "dem", ct) ?? throw new InvalidOperationException($"Sem relevo para '{loc}': corra o ingest.");
        var cover = await LoadGridAsync(loc, "landcover", ct);
        var bld = await LoadGridAsync(loc, "buildings", ct); // opcional: sem ele, não há edifícios no modelo
        var buildings = new ushort[spec.CellCount];
        if (bld is not null) Buffer.BlockCopy(bld.Data, 0, buildings, 0, Math.Min(bld.Data.Length, buildings.Length * 2));
        return new TerrainGrids(spec, GridBytes.ToFloats(dem.Data), cover?.Data ?? new byte[spec.CellCount], buildings);
    }

    public async Task<RenderHeightmap?> GetRenderHeightmapAsync(string loc, CancellationToken ct = default)
    {
        var g = await LoadGridAsync(loc, "dem_render", ct);
        return g is null ? null : new RenderHeightmap(Locations.Get(loc).RenderSpec, GridBytes.ToFloats(g.Data));
    }

    // ============================================================================================ estradas
    public async Task ReplaceRoadsAsync(string loc, GridSpec spec, IReadOnlyList<RoadEdge> edges, IEnumerable<RoadNode> nodes, CancellationToken ct = default)
    {
        await using var c = await _db.OpenConnectionAsync(ct);
        await using var tx = await c.BeginTransactionAsync(ct);
        await c.ExecuteAsync("DELETE FROM road_edges WHERE location_id=@loc; DELETE FROM road_nodes WHERE location_id=@loc", new { loc }, tx);
        await Copy(c, "road_nodes", "location_id,id,geom", nodes, (w, n) =>
        {
            var (lat, lon) = spec.ToLatLon(n.X, n.Y);
            return w.Put(loc, n.Id, Wgs84.Factory.CreatePoint(new Coordinate(lon, lat)));
        }, ct);
        await Copy(c, "road_edges", "location_id,id,name,ref,highway,a,b,length_m,off_road,tracktype,width_m,geom", edges, async (w, e) =>
        {
            var coords = Enumerable.Range(0, e.Pts.Length / 2).Select(i => { var (lat, lon) = spec.ToLatLon(e.Pts[2 * i], e.Pts[2 * i + 1]); return new Coordinate(lon, lat); }).ToArray();
            await w.Put(loc, e.Id, e.Name, e.Ref, e.Highway, e.A, e.B, e.LengthCells * spec.CellM, e.OffRoad, e.TrackType, e.WidthM, Wgs84.Factory.CreateLineString(coords));
        }, ct);
        await tx.CommitAsync(ct);
    }

    public async Task<RoadNetwork> GetRoadsAsync(string loc, CancellationToken ct = default)
    {
        var spec = Locations.Get(loc).Spec;
        await using var c = await _db.OpenConnectionAsync(ct);
        var edges = new List<RoadEdge>();
        await foreach (var r in Query(c, "SELECT id,name,ref,highway,a,b,geom,off_road,tracktype,width_m FROM road_edges WHERE location_id=@l ORDER BY id", loc, ct))
        {
            var g = (LineString)r.GetFieldValue<Geometry>(6);
            var pts = new double[g.NumPoints * 2];
            for (int i = 0; i < g.NumPoints; i++)
            {
                var (x, y) = spec.ToCell(g.GetCoordinateN(i).Y, g.GetCoordinateN(i).X);
                pts[2 * i] = x; pts[2 * i + 1] = y;
            }
            edges.Add(new RoadEdge(r.GetInt32(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetString(5), pts,
                RoadGeometry.CellsOf(pts, spec), RoadGeometry.Length(pts), r.GetBoolean(7), r.Str(8), r.Dbl(9)));
        }
        var nodes = new Dictionary<string, RoadNode>();
        await foreach (var r in Query(c, "SELECT id,geom FROM road_nodes WHERE location_id=@l", loc, ct))
        {
            var p = (Point)r.GetFieldValue<Geometry>(1);
            var (x, y) = spec.ToCell(p.Y, p.X);
            nodes[r.GetString(0)] = new RoadNode(r.GetString(0), x, y);
        }
        return new RoadNetwork(spec, edges, nodes);
    }

    // ============================================================================================ instalações, localidades, água, aceiros
    public Task ReplaceFacilitiesAsync(string loc, IEnumerable<Facility> items, CancellationToken ct = default) =>
        ReplaceLayer("facilities", "type,name,operator,source,confidence,capacity,vulnerable,geom", loc, items,
            (w, f) => w.Put(EnumText.ToSnake(f.Kind), f.Name, f.Operator, f.Source, f.Confidence, f.Capacity, f.Vulnerable, Pt(f.Lat, f.Lon)), ct);

    public async Task<IReadOnlyList<Facility>> GetFacilitiesAsync(string loc, CancellationToken ct = default) =>
        await Read(loc, "SELECT id,type,name,operator,source,confidence,capacity,vulnerable,geom FROM facilities WHERE location_id=@l ORDER BY id", r =>
        {
            var p = (Point)r.GetFieldValue<Geometry>(8);
            return new Facility(r.GetInt64(0), EnumText.Parse<FacilityKind>(r.GetString(1)), r.GetString(2), p.Y, p.X, r.Str(3), r.GetString(4), r.GetDouble(5), r.Int(6), r.GetBoolean(7));
        }, ct);

    public Task ReplacePlacesAsync(string loc, IEnumerable<Place> items, CancellationToken ct = default) =>
        ReplaceLayer("places", "name,kind,population,population_estimated,geom", loc, items,
            (w, p) => w.Put(p.Name, p.Kind, p.Population, p.PopulationEstimated, Pt(p.Lat, p.Lon)), ct);

    public async Task<IReadOnlyList<Place>> GetPlacesAsync(string loc, CancellationToken ct = default) =>
        await Read(loc, "SELECT id,name,kind,population,population_estimated,geom FROM places WHERE location_id=@l ORDER BY population DESC, id", r =>
        {
            var p = (Point)r.GetFieldValue<Geometry>(5);
            return new Place(r.GetInt64(0), r.GetString(1), r.GetString(2), p.Y, p.X, r.GetInt32(3), r.GetBoolean(4));
        }, ct);

    public Task ReplaceWaterPointsAsync(string loc, IEnumerable<WaterPoint> items, CancellationToken ct = default) =>
        ReplaceLayer("water_points", "kind,name,ref,capacity_l,capacity_estimated,flow_lpm,area_m2,diameter_mm,hydrant_type,truck_accessible,helicopter_accessible,nearest_road_id,road_distance_m,access,source,osm_id,geom",
            loc, items, (w, p) => w.Put(EnumText.ToSnake(p.Kind), p.Name, p.Ref, p.CapacityL, p.CapacityEstimated, p.FlowLpm, p.AreaM2, p.DiameterMm, p.HydrantType,
                p.TruckAccessible, p.HelicopterAccessible, p.NearestRoadId, p.RoadDistanceM, p.Access, p.Source, p.OsmId, Pt(p.Lat, p.Lon)), ct);

    public async Task<IReadOnlyList<WaterPoint>> GetWaterPointsAsync(string loc, CancellationToken ct = default) =>
        await Read(loc, @"SELECT id,kind,name,ref,capacity_l,capacity_estimated,flow_lpm,area_m2,diameter_mm,hydrant_type,truck_accessible,helicopter_accessible,
            nearest_road_id,road_distance_m,access,source,osm_id,geom FROM water_points WHERE location_id=@l ORDER BY id", r =>
        {
            var p = (Point)r.GetFieldValue<Geometry>(17);
            return new WaterPoint(r.GetInt64(0), EnumText.Parse<WaterPointKind>(r.GetString(1)), r.GetString(2), p.Y, p.X, r.Str(3), r.Dbl(4), r.GetBoolean(5), r.Dbl(6), r.Dbl(7),
                r.Dbl(8), r.Str(9), r.GetBoolean(10), r.GetBoolean(11), r.Int(12), r.Dbl(13), r.GetString(14), r.GetString(15), r.Str(16));
        }, ct);

    public Task ReplaceFirebreaksAsync(string loc, IEnumerable<Firebreak> items, CancellationToken ct = default) =>
        ReplaceLayer("firebreaks", "kind,name,width_m,maintained,source,geom", loc, items,
            (w, f) => w.Put(EnumText.ToSnake(f.Kind), f.Name, f.WidthM, f.Maintained, f.Source, f.Geometry), ct);

    public async Task<IReadOnlyList<Firebreak>> GetFirebreaksAsync(string loc, CancellationToken ct = default) =>
        await Read(loc, "SELECT id,kind,name,width_m,maintained,source,geom FROM firebreaks WHERE location_id=@l ORDER BY id", r =>
            new Firebreak(r.GetInt64(0), EnumText.Parse<FirebreakKind>(r.GetString(1)), r.Str(2), r.Dbl(3), r.GetBoolean(4), r.GetString(5), r.GetFieldValue<Geometry>(6)), ct);

    public Task ReplaceWaterwaysAsync(string loc, IEnumerable<Waterway> items, CancellationToken ct = default) =>
        ReplaceLayer("waterways", "kind,name,width_m,geom", loc, items, (w, x) => w.Put(EnumText.ToSnake(x.Kind), x.Name, x.WidthM, x.Geometry), ct);

    public async Task<IReadOnlyList<Waterway>> GetWaterwaysAsync(string loc, CancellationToken ct = default) =>
        await Read(loc, "SELECT id,kind,name,width_m,geom FROM waterways WHERE location_id=@l ORDER BY id", r =>
            new Waterway(r.GetInt64(0), EnumText.Parse<WaterwayKind>(r.GetString(1)), r.Str(2), r.Dbl(3), r.GetFieldValue<Geometry>(4)), ct);

    // ============================================================================================ imagens
    public async Task SaveImageryAsync(ImageryAsset a, CancellationToken ct = default)
    {
        await using var c = await _db.OpenConnectionAsync(ct);
        await c.ExecuteAsync(@"INSERT INTO imagery_assets(location_id,kind,source,zoom,path,west,south,east,north,attribution)
            VALUES (@LocationId,@Kind,@Source,@Zoom,@Path,@W,@S,@E,@N,@Attribution)
            ON CONFLICT (location_id,kind) DO UPDATE SET source=@Source,zoom=@Zoom,path=@Path,west=@W,south=@S,east=@E,north=@N,attribution=@Attribution",
            new { a.LocationId, a.Kind, a.Source, a.Zoom, a.Path, W = a.Bounds.West, S = a.Bounds.South, E = a.Bounds.East, N = a.Bounds.North, a.Attribution });
    }

    public async Task<IReadOnlyList<ImageryAsset>> GetImageryAsync(string loc, CancellationToken ct = default)
    {
        await using var c = await _db.OpenConnectionAsync(ct);
        var rows = await c.QueryAsync("SELECT * FROM imagery_assets WHERE location_id=@loc ORDER BY kind", new { loc });
        return rows.Select(r => new ImageryAsset(loc, (string)r.kind, (string)r.source, (int)r.zoom, (string)r.path,
            new GeoBounds((double)r.south, (double)r.west, (double)r.north, (double)r.east), (string)r.attribution)).ToList();
    }

    // ============================================================================================ ajudas
    static Point Pt(double lat, double lon) => Wgs84.Factory.CreatePoint(new Coordinate(lon, lat));

    static async IAsyncEnumerable<NpgsqlDataReader> Query(NpgsqlConnection c, string sql, string loc, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(sql, c);
        cmd.Parameters.AddWithValue("l", loc);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) yield return r;
    }

    async Task<IReadOnlyList<T>> Read<T>(string loc, string sql, Func<NpgsqlDataReader, T> map, CancellationToken ct)
    {
        await using var c = await _db.OpenConnectionAsync(ct);
        var list = new List<T>();
        await foreach (var r in Query(c, sql, loc, ct)) list.Add(map(r));
        return list;
    }

    /// <summary>Troca a camada inteira do local numa transação: apaga e volta a inserir com COPY binário.</summary>
    async Task ReplaceLayer<T>(string table, string columns, string loc, IEnumerable<T> rows, Func<NpgsqlBinaryImporter, T, Task> write, CancellationToken ct)
    {
        await using var c = await _db.OpenConnectionAsync(ct);
        await using var tx = await c.BeginTransactionAsync(ct);
        await c.ExecuteAsync($"DELETE FROM {table} WHERE location_id=@loc", new { loc }, tx);
        await Copy(c, table, "location_id," + columns, rows, async (w, row) => { await w.WriteAsync(loc, NpgsqlDbType.Text, ct); await write(w, row); }, ct);
        await tx.CommitAsync(ct);
    }

    static async Task Copy<T>(NpgsqlConnection c, string table, string columns, IEnumerable<T> rows, Func<NpgsqlBinaryImporter, T, Task> write, CancellationToken ct)
    {
        await using var w = await c.BeginBinaryImportAsync($"COPY {table}({columns}) FROM STDIN (FORMAT BINARY)", ct);
        foreach (var row in rows) { await w.StartRowAsync(ct); await write(w, row); }
        await w.CompleteAsync(ct);
    }
}
