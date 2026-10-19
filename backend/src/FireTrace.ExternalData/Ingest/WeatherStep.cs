using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Weather;

namespace FireTrace.ExternalData.Ingest;

/// <summary>Meteorologia horária real (Open-Meteo ERA5 para histórico, previsão para presente/futuro).</summary>
public sealed class WeatherStep(IWeatherSource weatherSource, TimeProvider clock, IIngestLog log) : IIngestStep
{
    public string Name => "weather";
    public int Order => 95;

    public async Task RunAsync(IngestContext ctx)
    {
        var point = (ctx.Location.WeatherPoint.Lat != 0 || ctx.Location.WeatherPoint.Lon != 0)
            ? ctx.Location.WeatherPoint
            : ctx.Location.Center;
        int totalHours = 0;

        // 1. Incidentes de referência definidos no local (para permitir replaying sem latência)
        foreach (var incident in ctx.Location.Incidents)
        {
            try
            {
                var from = incident.Start.AddHours(-6);
                var to = incident.Start.AddMinutes(incident.DurationMinutes).AddHours(6);
                var obs = await weatherSource.GetHourlyAsync(ctx.Id, point, from, to);
                totalHours += obs.Count;
            }
            catch (Exception ex)
            {
                log.Warn($"  aviso ao obter meteorologia para incidente {incident.Id}: {ex.Message}");
            }
        }

        // 2. Meteorologia recente e previsão (últimos 3 dias + próximos 7 dias)
        try
        {
            var now = clock.GetUtcNow();
            var from = now.AddDays(-3);
            var to = now.AddDays(7);
            var obs = await weatherSource.GetHourlyAsync(ctx.Id, point, from, to);
            totalHours += obs.Count;
        }
        catch (Exception ex)
        {
            log.Warn($"  aviso ao obter previsão meteorológica: {ex.Message}");
        }

        log.Info($"  {totalHours} horas de meteorologia pré-carregadas");
    }
}
