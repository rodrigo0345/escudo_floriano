namespace FireTrace.Engine.Configuration;

/// <summary>
/// Efeito do fogo no vento: a coluna de convecção puxa ar para o fogo (velocidade de flutuabilidade (g·I/(ρ·cp·T))^(1/3)), que decai com a distância.
/// Corre-se o motor, calcula-se o vento induzido e volta a correr-se com esse vento (`Passes` vezes).
/// </summary>
public sealed record ConvectionSettings(bool Enabled, int Passes, double BlockM, double ActiveWindowMinutes, double InflowDecayM, double InflowRangeFactor, double InflowEfficiency,
    double GravityMs2, double HeatCapacityJm3, double MaxInducedKmh, double MaxInducedFraction, double MinInducedCapKmh, double MinIntensityKwm);
