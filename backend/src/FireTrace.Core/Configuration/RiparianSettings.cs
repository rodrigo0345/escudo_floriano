namespace FireTrace.Core.Configuration;

/// <summary>A água fresca à volta de rios e lagos: o combustível ribeirinho está mais húmido e arde mais devagar, com efeito que decai com a distância.</summary>
public sealed record RiparianSettings(double Slowdown, double DecayM, double MaxDistanceM, string[] WaterwayKinds);
