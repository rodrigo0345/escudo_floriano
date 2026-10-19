using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Interventions;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Services.Fire;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;
using NetTopologySuite.Geometries;

namespace FireTrace.Tests.Services;

public class InterventionTests
{
    static readonly GridSpec Spec = new(41.4, -8.3, 40, 40, 60);
    static TerrainGrids Terrain() { var n = 40 * 40; var land = new byte[n]; Array.Fill(land, LandCover.Eucalipto); return new TerrainGrids(Spec, new float[n], land, new ushort[n]); }

    [Fact]
    public void Firefighters_slow_the_fire_where_they_work_and_more_people_slow_it_more()
    {
        var g = Terrain(); var baseline = Enumerable.Repeat(1f, g.Spec.CellCount).ToArray();
        var where = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326).CreatePoint(new NetTopologySuite.Geometries.Coordinate(-8.3, 41.4));
        Intervention Crew(int people) => new CrewDeploymentIntervention { Start = new TimeSpec(OffsetMinutes: 0), Responsibility = Responsibility.Firefighting, Personnel = people, Geometry = where };

        int cell = g.Spec.CellAt(41.4, -8.3);
        var few = InterventionApplier.Apply(new[] { Crew(4) }, g, Array.Empty<Place>(), baseline, TestSettings.All.Rules.Suppression, TestSettings.All.Interventions).Adjustment[cell];
        var many = InterventionApplier.Apply(new[] { Crew(20) }, g, Array.Empty<Place>(), baseline, TestSettings.All.Rules.Suppression, TestSettings.All.Interventions).Adjustment[cell];
        Assert.True(few < 1f);
        Assert.True(many < few);
        Assert.Equal(1f, InterventionApplier.Apply(new[] { Crew(20) }, g, Array.Empty<Place>(), baseline, TestSettings.All.Rules.Suppression, TestSettings.All.Interventions).Adjustment[0]); // longe dali nada muda
    }
}
