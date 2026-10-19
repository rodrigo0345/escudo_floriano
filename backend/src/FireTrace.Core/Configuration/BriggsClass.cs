namespace FireTrace.Core.Configuration;

/// <summary>Coeficientes de Briggs (campo aberto): σy = AY·x·(1+BY·x)^−½ e σz = AZ·x·(1+BZ·x)^EZ, com x a distância percorrida (m).</summary>
public sealed record BriggsClass(double AY, double BY, double AZ, double BZ, double EZ);
