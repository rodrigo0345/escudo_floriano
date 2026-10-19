namespace FireTrace.ExternalData.Map;

/// <param name="Capacity">Camas (lares, hospitais), alunos (escolas) ou pessoas abrigadas (abrigos).</param>
/// <param name="Vulnerable">Pessoas com dificuldade em sair sozinhas: prioridade nas evacuações.</param>
public sealed record Facility(long Id, FacilityKind Kind, string Name, double Lat, double Lon, string? Operator, string Source, double Confidence,
    int? Capacity = null, bool Vulnerable = false);
