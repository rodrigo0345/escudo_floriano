using FireTrace.Core.Domain.Common;
using FireTrace.Core.Models.Fire;
using FireTrace.Core.Serialization;
using FireTrace.Core.Services.Fire;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;

namespace FireTrace.Tests.Services;

public class FireAnalyticsTests
{
    [Fact]
    public void The_head_is_where_the_front_is_farthest_from_the_origin_not_the_fastest_flank_vector()
    {
        var origin = new LatLon(41.4, -8.3);
        var vectors = new List<FireVector>();
        for (int i = 0; i < 8; i++) vectors.Add(new FireVector(41.4 + (i - 4) * 0.0002, -8.3 + 0.03, 100, 20));   // a frente, 2,5 km a leste, com o rumo dos fortes
        for (int i = 0; i < 8; i++) vectors.Add(new FireVector(41.4 + 0.004, -8.3 + 0.004 * i / 8, 350, 45));     // flanco a norte, perto da origem, com vetores muito rápidos para o lado
        var head = FireAnalytics.Head(vectors, TestSettings.All.Analytics, origin)!.Value;
        Assert.InRange(head.BearingDeg, 80, 100);
        Assert.InRange(FireAnalytics.Head(vectors, TestSettings.All.Analytics)!.Value.BearingDeg, 330, 360); // sem origem, a velocidade engana
    }

    [Fact]
    public void Vectors_point_in_the_spread_direction_with_a_sensible_speed()
    {
        var spec = new GridSpec(41.4, -8.3, 60, 60, 60);
        var ign = Enumerable.Repeat(-1, 60 * 60).ToArray();
        for (int y = 0; y < 60; y++) for (int x = 10; x < 50; x++) ign[y * 60 + x] = (x - 10) / 2; // frente a avançar para leste, 2 células por minuto
        var vectors = FireAnalytics.Vectors(ign, spec, 15, TestSettings.All.Analytics, TestSettings.All.Defaults.VectorWindowMinutes);
        Assert.NotEmpty(vectors);
        Assert.All(vectors, v => Assert.InRange(v.BearingDeg, 80, 100));
        Assert.All(vectors, v => Assert.InRange(v.SpeedMPerMin, 90, 150)); // 2 células × 60 m
        Assert.InRange(FireAnalytics.Head(vectors, TestSettings.All.Analytics)!.Value.BearingDeg, 80, 100);
    }

    [Fact]
    public void The_burned_area_and_perimeter_grow_with_time()
    {
        var spec = new GridSpec(41.4, -8.3, 30, 30, 60);
        var ign = Enumerable.Repeat(-1, 900).ToArray();
        for (int y = 10; y < 20; y++) for (int x = 10; x < 20; x++) ign[y * 30 + x] = Math.Max(Math.Abs(x - 15), Math.Abs(y - 15));
        Assert.True(FireAnalytics.AreaHa(ign, spec, 5) > FireAnalytics.AreaHa(ign, spec, 1));
        Assert.Contains("MultiPolygon", System.Text.Json.JsonSerializer.Serialize(FireAnalytics.Perimeter(ign, spec, 3, TestSettings.All.Analytics), ApiJson.Options));
    }

    [Fact]
    public void Quantiles_summarise_the_ensemble()
    {
        var q = FireAnalytics.Quantiles(Enumerable.Range(1, 11).Select(i => (double)i * 10).ToList());
        Assert.Equal(60, q.P50); Assert.True(q.P10 < q.P50 && q.P50 < q.P90);
    }
}
