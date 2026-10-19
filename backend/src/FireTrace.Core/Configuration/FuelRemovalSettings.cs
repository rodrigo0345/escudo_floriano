namespace FireTrace.Core.Configuration;

/// <summary>Faixas de gestão de combustível: a largura por omissão, quanto cada tipo de corte trava a propagação e o combustível que fica.</summary>
public sealed record FuelRemovalSettings(double DefaultWidthM, double TreesSpreadFactor, double UnderstorySpreadFactor, int UnderstoryFuelModel, int NonBurnableFuelModel, double CrewRateMPerHourPerPerson);
