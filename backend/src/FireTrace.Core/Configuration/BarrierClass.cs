namespace FireTrace.Core.Configuration;

/// <summary>Quanto uma via ou curso de água trava o fogo: o fator da velocidade onde trava, a probabilidade base de ser galgada e a sensibilidade dessa probabilidade ao vento.</summary>
public sealed record BarrierClass(double BlockFactor, double BaseBreach, double WindSensitivity);
