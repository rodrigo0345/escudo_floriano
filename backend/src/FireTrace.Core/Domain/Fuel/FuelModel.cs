namespace FireTrace.Core.Domain.Fuel;

/// <summary>
/// Classe de vegetação do mapa → combustível do motor ELMFIRE (modelos Scott &amp; Burgan 40, "fbfm40") e estrutura do copado. Os valores vêm de
/// `appsettings.json` (FireTrace:Fuels): a física (Rothermel, Van Wagner, faíscas) é toda do ELMFIRE, aqui só se traduz o mapa de espécies.
/// </summary>
/// <param name="Id">O id guardado na grelha "landcover" do mapa.</param>
/// <param name="Key"></param>
/// <param name="Label"></param>
/// <param name="Fbfm40">Código Scott &amp; Burgan (91–99 = não combustível; 101+ pastagem; 141+ mato; 161+ mato sob copado; 181+ folhada).</param>
/// <param name="CanopyCoverPct">Cobertura do copado (%).</param>
/// <param name="CanopyHeightM">Altura do copado (m).</param>
/// <param name="CanopyBaseHeightM">Altura da base da copa (m).</param>
/// <param name="CanopyBulkDensity">Densidade do copado (kg/m³).</param>
/// <param name="SpreadFactor">Calibração local da velocidade de propagação desta vegetação sobre o que o ELMFIRE dá com o modelo Scott &amp; Burgan (1 = sem alteração).</param>
/// <param name="BurnMinutes">Tempo aproximado em que a célula está em chamas (para visualização e fecho de estradas).</param>
public sealed record FuelModel(byte Id, string Key, string Label, int Fbfm40, int CanopyCoverPct, double CanopyHeightM, double CanopyBaseHeightM, double CanopyBulkDensity, double SpreadFactor, int BurnMinutes, string Color);
