using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Interventions;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Models.Fire;
using FireTrace.Core.Services.Map;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Fire;

/// <summary>
/// Traduz decisões em efeito no fogo: bombeiros a trabalhar numa zona travam a propagação ali (a eficácia vem das `Rules`: pessoas, água e viaturas),
/// linhas de contenção e largadas aéreas reduzem-na nas células que cobrem, e a proteção de edifícios reduz os edifícios contados como afetados.
/// Na primeira versão o efeito vale desde o início da simulação (a hora de início de cada intervenção ainda não é respeitada).
/// </summary>
public static class InterventionApplier
{
    public static InterventionEffect Apply(IEnumerable<Intervention> interventions, TerrainGrids g, IReadOnlyList<Place> places, float[] baseAdjustment, SuppressionRules rules, InterventionSettings settings)
    {
        var adj = (float[])baseAdjustment.Clone();
        float[]? buildings = null;
        var treatments = new List<FuelTreatment>();
        float floor = (float)settings.MinSpreadFactor;

        void Slow(IEnumerable<int> cells, double effectiveness) { foreach (var c in cells) adj[c] = Math.Max(floor, adj[c] * (float)(1 - Math.Clamp(effectiveness, 0, 0.98))); }
        void Protect(IEnumerable<int> cells, double effectiveness)
        {
            buildings ??= Enumerable.Repeat(1f, g.Spec.CellCount).ToArray();
            foreach (var c in cells) buildings[c] *= (float)(1 - Math.Clamp(effectiveness, 0, 1));
        }

        foreach (var i in interventions)
            switch (i)
            {
                case FireLineIntervention f: Slow(Zones.CellsOf(g.Spec, f.Geometry, 0), f.Effectiveness); break;
                case FuelRemovalIntervention r:
                    var cut = TreatedCells(r, g.Spec, settings.FuelRemoval).ToList();
                    treatments.Add(new FuelTreatment(cut, r.Removal));
                    Slow(cut, 1 - SpreadFactor(r.Removal, settings.FuelRemoval));
                    break;
                case AerialDropIntervention a: Slow(Zones.CellsOf(g.Spec, a.Geometry, a.Geometry is Polygon or MultiPolygon ? 0 : settings.AerialLineBufferM), a.Effectiveness); break;
                case CrewDeploymentIntervention c when c.Responsibility is Responsibility.Firefighting:
                    Slow(Zones.CellsOf(g.Spec, c.Geometry, rules.ZoneRadiusM), c.Effectiveness ?? CrewEffectiveness(c, rules)); break;
                case CrewDeploymentIntervention c when c.Responsibility is Responsibility.StructureProtection:
                    Protect(Zones.CellsOf(g.Spec, c.Geometry, rules.ZoneRadiusM), c.Effectiveness ?? CrewEffectiveness(c, rules)); break;
                case StructureProtectionIntervention s:
                    var zone = s.Geometry is not null ? Zones.CellsOf(g.Spec, s.Geometry, 0)
                        : places.FirstOrDefault(p => MapIds.Place(p.Id) == s.PlaceId) is { } p ? Zones.CellsOf(g.Spec, new GeometryFactory().CreatePoint(new Coordinate(p.Lon, p.Lat)), settings.StructureProtectionRadiusM) : Array.Empty<int>();
                    Protect(zone, s.Effectiveness); break;
            }
        return new InterventionEffect(adj, buildings, treatments);
    }

    /// <summary>As células da faixa cortada: uma linha alarga-se à largura pedida (pelo menos uma célula e meia, para não deixar frestas) e fica 4-conexa.</summary>
    public static IEnumerable<int> TreatedCells(FuelRemovalIntervention r, GridSpec spec, FuelRemovalSettings settings) =>
        r.Geometry is Polygon or MultiPolygon ? Zones.CellsOf(spec, r.Geometry, 0)
            : Zones.Connected(Zones.CellsOf(spec, r.Geometry, Math.Max(r.WidthM ?? settings.DefaultWidthM, spec.CellM * 1.5) / 2), spec.Width);

    /// <summary>Fração da propagação que resta numa faixa onde se cortou `removal` (a faixa sem combustível já não arde, trava-se pelo combustível).</summary>
    public static double SpreadFactor(FuelRemoval removal, FuelRemovalSettings s) => removal switch
    {
        FuelRemoval.Trees => s.TreesSpreadFactor,
        FuelRemoval.Understory => s.UnderstorySpreadFactor,
        _ => 1.0,
    };

    /// <summary>Eficácia de uma equipa: uma base mais o que as pessoas e a água acrescentam, até ao máximo das regras.</summary>
    public static double CrewEffectiveness(CrewDeploymentIntervention c, SuppressionRules r) =>
        Math.Min(r.MaxEffectiveness, r.BaseEffectiveness + r.PerCrewEquivalent * c.Personnel / r.PersonsPerCrewEquivalent + r.WaterBonusPerThousandL * (c.WaterL ?? 0) / 1000);
}
