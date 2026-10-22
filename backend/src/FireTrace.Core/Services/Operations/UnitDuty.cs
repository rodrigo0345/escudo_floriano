using FireTrace.Core.Domain.Rules;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Operations;

/// <summary>
/// O que uma viatura terrestre faz no teatro de operações, desde que chega até ao fim da ação: trabalha **parada na estrada onde a rota acaba** (a equipa vai a pé
/// com as mangueiras até à frente), gasta água a `min(bomba, attackFlowLpm) × dutyCycle` e combustível a `workingLph`; sem água vai **por estrada** ao ponto de
/// água mais rápido de alcançar, enche (`capacidade / caudal do ponto + setupMinutes`) e volta ao mesmo sítio; com o depósito abaixo de `refuelBelowPct` vai abastecer ao
/// posto mais perto e volta; depois de `maxContinuousWorkMinutes` a trabalhar descansa. Sem viagem conhecida até à água, o reabastecimento é o genérico das regras
/// (`shuttleMinutes + setupMinutes`), sem sair do sítio. Puro e determinístico: o simulador de operações dá-lhe as viagens já calculadas.
/// </summary>
public static class UnitDuty
{
    public enum Phase { Working, Resting, ToWater, Filling, FromWater, ToFuel, Fueling, FromFuel }

    /// <summary>Ida (e volta pelo mesmo caminho) do sítio de trabalho a um lugar: o percurso por estrada, os minutos de cada sentido e o tempo parado lá.</summary>
    public sealed record Trip(RoutePath? Path, double Minutes, double StopMinutes, string? PlaceId, string? PlaceName, LatLon Place)
    {
        public double Km => (Path?.TotalM ?? 0) / 1000;
    }

    /// <summary>Um troço da vida da viatura no local, com a água, o combustível (L) e o tempo de trabalho desde o último descanso no início e no fim.</summary>
    public sealed record Segment(Phase Phase, double From, double To, double WaterFrom, double WaterTo, double FuelFrom, double FuelTo, double WorkedFrom, Trip? Trip);

    /// <summary>
    /// A viatura: água (`WaterLpm` a trabalhar; 0 se não usa água), a viagem à água (ou o tempo genérico sem ela), o combustível (`FuelPerKm` a andar, `FuelPerWorkMinute`
    /// a trabalhar) e, abaixo de `RefuelBelowL`, a viagem ao posto.
    /// </summary>
    public sealed record Inputs(double WaterCapacityL, double WaterLpm, Trip? Water, double GenericRefillMinutes, double FuelCapacityL, double FuelAtArrivalL, double FuelPerKm,
        double FuelPerWorkMinute, double RefuelBelowL, Trip? Fuel, double? WaterAtArrivalL = null);

    const double Eps = 1e-9;

    public static IReadOnlyList<Segment> Plan(double arrive, double until, Inputs x, CrewRules crews)
    {
        var segments = new List<Segment>();
        double t = arrive, water = Math.Clamp(x.WaterAtArrivalL ?? x.WaterCapacityL, 0, x.WaterCapacityL), fuel = Math.Max(0, x.FuelAtArrivalL), worked = 0;
        bool usesWater = x.WaterCapacityL > 0 && x.WaterLpm > 0;
        double maxWork = Math.Max(1, crews.MaxContinuousWorkMinutes), rest = Math.Max(1, crews.MandatoryRestMinutes);

        void Go(Trip trip, Phase to, Phase stop, Phase back, bool refill)
        {
            double half = trip.Km * x.FuelPerKm;
            double waterBack = refill ? x.WaterCapacityL : water;
            double fuelThere = Math.Max(0, fuel - half), fuelFull = refill ? fuelThere : x.FuelCapacityL;
            segments.Add(new(to, t, t + trip.Minutes, water, water, fuel, fuelThere, worked, trip));
            t += trip.Minutes;
            segments.Add(new(stop, t, t + trip.StopMinutes, water, waterBack, fuelThere, fuelFull, worked, trip));
            t += trip.StopMinutes;
            segments.Add(new(back, t, t + trip.Minutes, waterBack, waterBack, fuelFull, Math.Max(0, fuelFull - half), worked, trip));
            t += trip.Minutes;
            water = waterBack; fuel = Math.Max(0, fuelFull - half);
        }

        for (int guard = 0; t < until - Eps && guard < 10_000; guard++)
        {
            if (x.Fuel is { } fuelTrip && x.FuelCapacityL > 0 && fuel <= x.RefuelBelowL + Eps) { Go(fuelTrip, Phase.ToFuel, Phase.Fueling, Phase.FromFuel, refill: false); continue; }
            if (worked >= maxWork - Eps) { segments.Add(new(Phase.Resting, t, t + rest, water, water, fuel, fuel, worked, null)); t += rest; worked = 0; continue; }
            if (usesWater && water <= Eps)
            {
                if (x.Water is { } waterTrip) Go(waterTrip, Phase.ToWater, Phase.Filling, Phase.FromWater, refill: true);
                else { segments.Add(new(Phase.Filling, t, t + x.GenericRefillMinutes, 0, x.WaterCapacityL, fuel, fuel, worked, null)); t += x.GenericRefillMinutes; water = x.WaterCapacityL; }
                continue;
            }

            double span = Math.Min(until - t, maxWork - worked);
            if (usesWater) span = Math.Min(span, water / x.WaterLpm);
            if (x.Fuel is not null && x.FuelPerWorkMinute > 0) span = Math.Min(span, Math.Max(0, (fuel - x.RefuelBelowL) / x.FuelPerWorkMinute));
            if (span <= Eps) { if (x.Fuel is null || x.FuelCapacityL <= 0) break; continue; }
            double waterAfter = usesWater ? Math.Max(0, water - x.WaterLpm * span) : water, fuelAfter = Math.Max(0, fuel - x.FuelPerWorkMinute * span);
            segments.Add(new(Phase.Working, t, t + span, water, waterAfter, fuel, fuelAfter, worked, null));
            t += span; worked += span; water = waterAfter; fuel = fuelAfter;
        }
        return segments;
    }

    /// <summary>O troço em que está ao minuto `m` (nulo antes do primeiro e depois do último).</summary>
    public static Segment? At(IReadOnlyList<Segment> segments, double m)
    {
        foreach (var s in segments) if (m >= s.From && m < s.To) return s;
        return null;
    }

    static double Fraction(Segment s, double m) => s.To - s.From <= Eps ? 1 : Math.Clamp((m - s.From) / (s.To - s.From), 0, 1);

    public static double WaterAt(Segment s, double m) => s.WaterFrom + (s.WaterTo - s.WaterFrom) * Fraction(s, m);

    public static double FuelAt(Segment s, double m) => s.FuelFrom + (s.FuelTo - s.FuelFrom) * Fraction(s, m);

    /// <summary>Minutos de trabalho desde o último descanso ao minuto `m` (para o cansaço).</summary>
    public static double WorkedAt(Segment s, double m) => s.WorkedFrom + (s.Phase == Phase.Working ? m - s.From : 0);

    /// <summary>Onde está: no sítio de trabalho, a caminho do ponto de água ou do posto (pelo percurso por estrada), lá parada, ou de volta.</summary>
    public static LatLon PositionAt(Segment s, double m, LatLon work)
    {
        if (s.Trip is not { } trip) return work;
        double minutes = s.To - s.From, elapsed = m - s.From;
        return s.Phase switch
        {
            Phase.ToWater or Phase.ToFuel => trip.Path is null ? Lerp(work, trip.Place, Fraction(s, m)) : CrewSafety.PositionOn(trip.Path, minutes, End(trip), elapsed),
            Phase.FromWater or Phase.FromFuel => trip.Path is null ? Lerp(trip.Place, work, Fraction(s, m)) : CrewSafety.PositionOn(trip.Path, minutes, End(trip), Math.Max(0, minutes - elapsed)),
            Phase.Filling or Phase.Fueling => End(trip),
            _ => work,
        };
    }

    /// <summary>Onde a viatura pára no lugar: no fim do percurso por estrada (o ponto de água pode estar uns metros fora dela).</summary>
    static LatLon End(Trip trip) => trip.Path is { } p ? new LatLon(p.Coordinates[^1].Y, p.Coordinates[^1].X) : trip.Place;

    static LatLon Lerp(LatLon a, LatLon b, double f) => new(a.Lat + (b.Lat - a.Lat) * f, a.Lon + (b.Lon - a.Lon) * f);
}
