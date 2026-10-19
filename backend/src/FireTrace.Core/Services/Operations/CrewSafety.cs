using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Fire;
using FireTrace.Core.Domain.Fuel;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Plans.Triggers;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Domain.Simulations;
using FireTrace.ExternalData.Map;
using FireTrace.Core.Repositories;
using FireTrace.ExternalData.Store;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Operations;

/// <summary>
/// As baixas: uma equipa que fica numa célula a arder (a caminho ou no local de trabalho) é apanhada pelo fogo e perde `casualtyPctPerMinuteInFire` por minuto.
/// O serviço só aplica a regra a um plano e a um resultado de fogo; quem decide onde pôr as equipas é quem faz o plano (o agente).
/// </summary>
public sealed class CrewSafety(IDocumentStore<Vehicle> vehicles, TargetResolver targets, IMapReader map, FuelCatalog fuels, Rules rules, LimitsSettings limits)
{
    /// <summary>As equipas do plano apanhadas pelo fogo de `run` (os meios aéreos não contam: não pisam o chão).</summary>
    public async Task<List<CrewExposure>> EvaluateAsync(Plan plan, FireRun run, CancellationToken ct = default)
    {
        var terrain = await map.GetTerrainAsync(run.LocationId, ct);
        var result = new List<CrewExposure>();

        foreach (var action in plan.Actions)
        {
            double start = action.Trigger is AtTimeTrigger t ? Math.Max(0, t.At.MinutesFrom(run.Start)) : 0;
            int duration = action.ExpectedDurationMinutes ?? limits.DefaultActionWindowMinutes;
            if (await targets.PositionAsync(PlanService.TargetOf(action), plan.LocationId, ct) is not { } site) continue;

            foreach (var r in (action.Resources ?? new()).Where(r => r.ResourceType == ResourceType.Vehicle))
            {
                if (await vehicles.GetAsync(r.ResourceId, ct) is not { } v || v.Type is VehicleType.Helicopter or VehicleType.Airtanker or VehicleType.Drone) continue;
                int people = r.Personnel ?? v.CrewCapacity;
                if (people <= 0) continue;

                double eta = r.EtaMinutes ?? 0;
                int first = -1, minutes = 0; LatLon? where = null;
                for (int m = (int)Math.Floor(start); m <= Math.Min(start + eta + duration, run.DurationMinutes); m++)
                {
                    var p = PositionAt(r.Route, eta, site, m - start);
                    int cell = run.Spec.CellAt(p.Lat, p.Lon);
                    if (cell < 0 || run.Ignition[cell] < 0 || m < run.Ignition[cell] || m >= run.Ignition[cell] + fuels.Get(terrain.LandCover[cell]).BurnMinutes) continue;
                    if (first < 0) { first = m; where = p; }
                    minutes++;
                }
                if (minutes == 0) continue;
                int casualties = (int)Math.Min(people, Math.Ceiling(people * Math.Min(1.0, minutes * rules.Crews.CasualtyPctPerMinuteInFire / 100)));
                result.Add(new CrewExposure(action.Id, v.Id, people, first, minutes, casualties, where));
            }
        }
        return result;
    }

    /// <summary>Onde a equipa está `minute` minutos depois de partir: ao longo da rota até chegar (em `eta` minutos) e no alvo depois disso.</summary>
    public static LatLon PositionAt(LineString? route, double eta, LatLon site, double minute)
    {
        if (route is null || route.NumPoints < 2 || eta <= 0 || minute >= eta) return site;
        var c = route.Coordinates;
        var legs = new double[c.Length - 1];
        for (int i = 1; i < c.Length; i++) legs[i - 1] = RoadGeometry.DistanceM(c[i - 1].Y, c[i - 1].X, c[i].Y, c[i].X);
        double target = Math.Max(0, minute) / eta * legs.Sum();
        for (int i = 0; i < legs.Length; i++)
        {
            if (target <= legs[i] || i == legs.Length - 1)
            {
                double f = legs[i] <= 0 ? 0 : Math.Min(1, target / legs[i]);
                return new LatLon(c[i].Y + (c[i + 1].Y - c[i].Y) * f, c[i].X + (c[i + 1].X - c[i].X) * f);
            }
            target -= legs[i];
        }
        return site;
    }
}
