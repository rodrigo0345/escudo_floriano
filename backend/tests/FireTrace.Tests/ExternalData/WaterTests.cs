using System.Globalization;
using System.Text.Json;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Sources.Water;
using Xunit;

namespace FireTrace.Tests.ExternalData;

public class WaterTests
{
    static readonly GridSpec Spec = new(41.4, -8.3, 60, 60, 60);
    static readonly WaterOptions Options = ExternalDataOptions.FromFile(Path.Combine(AppContext.BaseDirectory, ExternalDataOptions.FileName)).Water;

    static JsonElement J(string json) => JsonDocument.Parse(json).RootElement;
    static string Ll(double v) => v.ToString("0.000000", CultureInfo.InvariantCulture);

    /// <summary>Quadrado de lado `sideM` metros, centrado em (lat, lon).</summary>
    static string Square(double lat, double lon, double sideM)
    {
        double dLat = sideM / 2 / 110574, dLon = sideM / 2 / (111320 * Math.Cos(lat * Math.PI / 180));
        string P(double la, double lo) => $"{{\"lat\":{Ll(la)},\"lon\":{Ll(lo)}}}";
        return $"[{P(lat - dLat, lon - dLon)},{P(lat - dLat, lon + dLon)},{P(lat + dLat, lon + dLon)},{P(lat + dLat, lon - dLon)},{P(lat - dLat, lon - dLon)}]";
    }

    [Fact]
    public void Hydrant_keeps_type_and_diameter_and_is_truck_accessible()
    {
        var p = WaterPointParser.FromPoint(J("""{"type":"node","id":1,"lat":41.4,"lon":-8.3,"tags":{"emergency":"fire_hydrant","fire_hydrant:type":"pillar","fire_hydrant:diameter":"100","ref":"BI-12"}}"""), Spec, Options)!;
        Assert.Equal(WaterPointKind.Hydrant, p.Kind);
        Assert.Equal("pillar", p.HydrantType);
        Assert.Equal(100, p.DiameterMm);
        Assert.True(p.TruckAccessible);
        Assert.Contains("BI-12", p.Name);
        Assert.Equal("node/1", p.OsmId);
    }

    [Fact]
    public void Points_outside_the_grid_are_ignored()
    {
        Assert.Null(WaterPointParser.FromPoint(J("""{"type":"node","id":2,"lat":42.5,"lon":-8.3,"tags":{"emergency":"fire_hydrant"}}"""), Spec, Options));
    }

    [Fact]
    public void Tank_volume_in_cubic_metres_becomes_litres()
    {
        var p = WaterPointParser.FromPoint(J("""{"type":"node","id":3,"lat":41.4,"lon":-8.3,"tags":{"emergency":"water_tank","water_tank:volume":"30"}}"""), Spec, Options)!;
        Assert.Equal(WaterPointKind.Tank, p.Kind);
        Assert.Equal(30000, p.CapacityL);
        Assert.False(p.CapacityEstimated);
    }

    [Fact]
    public void Dry_hydrant_is_a_suction_point()
    {
        var p = WaterPointParser.FromPoint(J("""{"type":"node","id":4,"lat":41.4,"lon":-8.3,"tags":{"emergency":"suction_point"}}"""), Spec, Options)!;
        Assert.Equal(WaterPointKind.DryHydrant, p.Kind);
        Assert.True(p.TruckAccessible);
    }

    [Fact]
    public void Swimming_pool_capacity_is_an_estimate_and_tiny_pools_are_dropped()
    {
        JsonElement Pool(double side, int id)
        {
            double dLat = side / 2 / 110574, dLon = side / 2 / 83500;
            return JsonSerializer.SerializeToElement(new
            {
                type = "way", id,
                bounds = new { minlat = 41.4 - dLat, maxlat = 41.4 + dLat, minlon = -8.3 - dLon, maxlon = -8.3 + dLon },
                tags = new Dictionary<string, string> { ["leisure"] = "swimming_pool", ["access"] = "private" },
            });
        }
        var pool = WaterPointParser.FromPoint(Pool(8, 5), Spec, Options)!;
        Assert.Equal(WaterPointKind.SwimmingPool, pool.Kind);
        Assert.True(pool.CapacityEstimated);
        Assert.Equal("private", pool.Access);
        Assert.False(pool.HelicopterAccessible);
        Assert.Null(WaterPointParser.FromPoint(Pool(3, 6), Spec, Options)); // < 20 m²
    }

    [Fact]
    public void Pond_polygon_gets_area_capacity_estimate_and_helicopter_flag()
    {
        string Way(double side) => $$"""{"type":"way","id":7,"tags":{"natural":"water","water":"pond"},"geometry":{{Square(41.4, -8.3, side)}}}""";
        var big = WaterBodyParser.FromWaterWay(J(Way(100)), Spec, Options)!;
        Assert.Equal(WaterPointKind.Pond, big.Kind);
        Assert.InRange(big.AreaM2!.Value, 9000, 11000);
        Assert.True(big.CapacityEstimated);
        Assert.InRange(big.CapacityL!.Value, 13e6, 17e6); // área × 1,5 m
        Assert.True(big.HelicopterAccessible);
        Assert.InRange(big.Lat, 41.3995, 41.4005); // ponto dentro da água
        var small = WaterBodyParser.FromWaterWay(J(Way(15)), Spec, Options)!;
        Assert.False(small.HelicopterAccessible); // 225 m² < 400 m²
    }

    [Fact]
    public void Large_water_bodies_are_reservoirs_and_rivers_are_skipped()
    {
        var res = WaterBodyParser.FromWaterWay(J($$"""{"type":"way","id":8,"tags":{"natural":"water","water":"reservoir","name":"Albufeira X"},"geometry":{{Square(41.4, -8.3, 200)}}}"""), Spec, Options)!;
        Assert.Equal(WaterPointKind.Reservoir, res.Kind);
        Assert.Equal("Albufeira X", res.Name);
        Assert.Null(WaterBodyParser.FromWaterWay(J($$"""{"type":"way","id":9,"tags":{"natural":"water","water":"river"},"geometry":{{Square(41.4, -8.3, 200)}}}"""), Spec, Options));
        Assert.Null(WaterBodyParser.FromWaterWay(J($$"""{"type":"way","id":10,"tags":{"natural":"water","water":"pond"},"geometry":{{Square(41.4, -8.3, 5)}}}"""), Spec, Options)); // < 60 m²
    }

    [Fact]
    public void Truck_access_depends_on_distance_to_the_nearest_road()
    {
        // uma estrada reta de oeste para este pela linha central (y = 30)
        var net = new RoadNetwork(Spec, new[] { new RoadEdge(7, "EN", "", "primary", "a", "b", new[] { 0.0, 30, 59, 30 }, Array.Empty<int>(), 59) }, new Dictionary<string, RoadNode>());
        WaterPoint P(WaterPointKind k, double dyCells) { var (lat, lon) = Spec.ToLatLon(30, 30 + dyCells); return new WaterPoint(0, k, "p", lat, lon, null, null, false, null, null, null, null, false, false, null, null, "unknown", "osm", null); }
        var linked = WaterRoadLinker.LinkToRoads(new[] { P(WaterPointKind.Pond, 0.5), P(WaterPointKind.Pond, 3), P(WaterPointKind.Hydrant, 5) }, net, Options);
        Assert.True(linked[0].TruckAccessible);                  // 30 m da estrada
        Assert.Equal(7, linked[0].NearestRoadId);
        Assert.InRange(linked[0].RoadDistanceM!.Value, 25, 35);
        Assert.False(linked[1].TruckAccessible);                 // 180 m
        Assert.True(linked[2].TruckAccessible);                  // hidrantes são sempre acessíveis
    }
}
