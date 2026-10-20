using System.Runtime.CompilerServices;
using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Rules;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Routing;

/// <summary>
/// As velocidades numa via. A base é a típica da classe (FireTrace:Routing) vezes a fração que uma viatura atinge (FireTrace:Rules:Movement); depois contam, por troço:
/// o piso (caminho de terra por `tracktype`, mais lento para viaturas pesadas), o declive, as sirenes (só em piso pavimentado), o limite das viaturas pesadas,
/// o limite da própria viatura, as curvas (velocidade segura pela aceleração lateral) e o tempo perdido em cada cruzamento.
/// </summary>
public sealed class RoadSpeeds(RoutingSettings routing, Rules rules)
{
    readonly Dictionary<string, double> _factor = rules.Movement.RoadSpeedFactor.ToDictionary(f => f.Highway, f => f.Factor);
    readonly ConditionalWeakTable<RoadEdge, CurveProfile> _curves = new();

    /// <summary>Os segmentos de um troço (m) e a velocidade máxima (km/h) que a curva de cada um permite.</summary>
    sealed record CurveProfile(double[] SegmentM, double[] LimitKmh);

    public MovementRules Movement => rules.Movement;

    static string ClassOf(string highway) => highway.EndsWith("_link") ? highway[..^5] : highway;

    /// <summary>Velocidade efetiva (km/h) numa via pavimentada, para estimar tempos de chegada.</summary>
    public double Kmh(string highway)
    {
        var key = ClassOf(highway);
        return routing.RoadTypicalSpeedKmh.TryGetValue(key, out var kmh) && _factor.TryGetValue(key, out var factor) ? kmh * factor : routing.UnknownRoadSpeedKmh;
    }

    /// <summary>
    /// Velocidade efetiva numa via pavimentada com o limite conhecido (`maxspeed`): a mesma fração do limite que a classe atinge. Sem limite vale a típica da classe.
    /// Um limite de classe desconhecida usa a fração das vias sem classificação (`unclassified`).
    /// </summary>
    public double Kmh(string highway, double? maxSpeedKmh)
    {
        if (maxSpeedKmh is not { } limit) return Kmh(highway);
        return limit * (_factor.TryGetValue(ClassOf(highway), out var factor) ? factor : _factor.GetValueOrDefault("unclassified", 0.6));
    }

    /// <summary>Velocidade (km/h) num caminho de terra pela qualidade OSM (`grade1` quase pavimentado … `grade5` mato); sem classificação vale a das regras (`OffRoadSpeedKmh`).</summary>
    public double TrackKmh(string? trackType) => trackType is not null && routing.TrackTypeSpeedKmh.TryGetValue(trackType, out var kmh) ? kmh : rules.Movement.OffRoadSpeedKmh;

    /// <summary>Quanto uma viatura aproveita um piso de terra: as todo-o-terreno quase tudo, as cisternas pesadas bem menos.</summary>
    double UnpavedFactor(string? vehicleType) => vehicleType is not null && routing.UnpavedVehicleFactor.TryGetValue(vehicleType, out var f) ? f : routing.UnpavedVehicleFactor["default"];

    double HeavyCap(string highway) => routing.HeavyVehicleMaxKmh.TryGetValue(ClassOf(highway), out var cap) ? cap : routing.HeavyVehicleMaxKmh["default"];

    double IntersectionSeconds(string highway) => routing.IntersectionDelaySeconds.TryGetValue(ClassOf(highway), out var s) ? s : routing.IntersectionDelaySeconds["default"];

    /// <summary>Minutos que o perfil leva a percorrer o troço (os impedimentos de passagem já foram vistos por quem chama).</summary>
    public double Minutes(RoadEdge e, double cellM, double slopePercent, TravelProfile p)
    {
        var move = rules.Movement;
        bool unpaved = e.OffRoad || e.Highway == "track";
        double kmh = unpaved ? TrackKmh(e.TrackType) * UnpavedFactor(p.VehicleType) : Kmh(e.Highway, e.MaxSpeedKmh);
        if (unpaved && e.MaxSpeedKmh is { } posted) kmh = Math.Min(kmh, posted); // um limite assinalado num caminho de terra também vale
        if (slopePercent > move.SlopePenalty.StartsAtPercent) kmh *= Math.Max(0.2, 1 - move.SlopePenalty.SlowdownPerPercent * (slopePercent - move.SlopePenalty.StartsAtPercent));
        if (p.Emergency && !unpaved) kmh *= move.EmergencyVehicleFactor; // as sirenes abrem caminho no trânsito, não numa estrada de terra
        if (p.WeightT > routing.HeavyVehicleWeightT) kmh = Math.Min(kmh, Math.Min(HeavyCap(e.Highway), e.MaxSpeedKmh ?? double.MaxValue)); // os pesados não passam do limite da via
        if (p.MaxSpeedKmh is { } cap) kmh = Math.Min(kmh, cap);

        var curves = CurvesOf(e, cellM);
        double minutes = 0;
        for (int i = 0; i < curves.SegmentM.Length; i++) minutes += curves.SegmentM[i] / (Math.Min(kmh, curves.LimitKmh[i]) * 1000 / 60);
        return minutes + IntersectionSeconds(e.Highway) / 60;
    }

    CurveProfile CurvesOf(RoadEdge e, double cellM) => _curves.GetValue(e, edge => BuildCurves(edge, cellM));

    /// <summary>
    /// Os segmentos do troço e o limite de cada um nas curvas: em cada vértice com desvio, o raio é (comprimento à volta) / ângulo e a velocidade segura √(aceleração lateral × raio).
    /// Os vértices a menos de `CurveMinSegmentM` fundem-se para o ruído da digitalização não fazer curvas que não existem.
    /// </summary>
    CurveProfile BuildCurves(RoadEdge e, double cellM)
    {
        var pts = new List<(double X, double Y)> { (e.Pts[0], e.Pts[1]) };
        double Dist((double X, double Y) a, (double X, double Y) b) => double.Hypot(b.X - a.X, b.Y - a.Y) * cellM;
        for (int i = 2; i + 1 < e.Pts.Length; i += 2)
        {
            var q = (e.Pts[i], e.Pts[i + 1]);
            bool last = i + 3 >= e.Pts.Length;
            if (Dist(pts[^1], q) >= routing.CurveMinSegmentM) pts.Add(q);
            else if (last && pts.Count > 1) pts[^1] = q; // o fim do troço fica sempre, no lugar do último vértice se estiver colado
            else if (last) pts.Add(q);
        }
        if (pts.Count < 2) return new CurveProfile(new[] { e.LengthCells * cellM }, new[] { double.PositiveInfinity });

        var length = new double[pts.Count - 1];
        var limit = Enumerable.Repeat(double.PositiveInfinity, pts.Count - 1).ToArray();
        for (int k = 0; k < length.Length; k++) length[k] = Dist(pts[k], pts[k + 1]);
        for (int j = 1; j < pts.Count - 1; j++)
        {
            double ax = pts[j].X - pts[j - 1].X, ay = pts[j].Y - pts[j - 1].Y, bx = pts[j + 1].X - pts[j].X, by = pts[j + 1].Y - pts[j].Y;
            double norm = double.Hypot(ax, ay) * double.Hypot(bx, by);
            if (norm == 0) continue;
            double angle = Math.Acos(Math.Clamp((ax * bx + ay * by) / norm, -1, 1));
            if (angle < 0.08) continue; // menos de ~5°: reta
            double radius = (length[j - 1] + length[j]) / 2 / angle;
            double safe = Math.Max(routing.MinCurveSpeedKmh, Math.Sqrt(routing.LateralAccelMps2 * radius) * 3.6);
            limit[j - 1] = Math.Min(limit[j - 1], safe); limit[j] = Math.Min(limit[j], safe);
        }
        return new CurveProfile(length, limit);
    }

    public TravelProfile Profile(bool allowOffRoad = false, bool emergency = true, double? maxSpeedKmh = null, double? widthM = null, double? maxSlopePercent = null, string? vehicleType = null, double? weightT = null) =>
        new(this, allowOffRoad, emergency, maxSpeedKmh, widthM, maxSlopePercent, vehicleType, weightT);
}
