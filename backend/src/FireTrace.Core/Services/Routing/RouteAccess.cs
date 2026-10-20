using FireTrace.Core.Models.Routing;

namespace FireTrace.Core.Services.Routing;

/// <summary>Uma rota e a distância (m) que falta fazer a pé na origem e no destino, entre o ponto pedido e a estrada onde a viatura pára.</summary>
public sealed record RouteAccess(RoutePlan Plan, double OriginWalkM, double TargetWalkM)
{
    /// <summary>Tempo da rota por estrada mais o que se anda a pé nas pontas (a velocidade a pé vem das definições).</summary>
    public double? TotalMinutes(double walkKmh) => Plan.Found ? Math.Round((Plan.DurationMin ?? 0) + (OriginWalkM + TargetWalkM) / (walkKmh * 1000 / 60), 1) : null;
}
