namespace FireTrace.Core.Models.Fire;

/// <summary>A visibilidade (m) e a sua classe (0 = limpo … 4 = denso) que uma concentração de partículas (µg/m³) dá.</summary>
public readonly record struct SmokeVisibility(double ConcentrationUgm3, double VisibilityM, int Class);
