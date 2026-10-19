using FireTrace.Core.Configuration;
using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Domain.Weather;
using FireTrace.Core.Models.Weather;
using FireTrace.Core.Services.Weather;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Controllers;

/// <summary>Meteorologia real de um local e pré-visualização da meteorologia programada de um cenário.</summary>
[Route("/api/v1/weather")]
public sealed class WeatherController(WeatherService weather, DefaultsSettings defaults) : ApiController
{
    [HttpGet("series")]
    public async Task<ActionResult<WeatherSeries>> Series([FromQuery] Query q, CancellationToken ct) =>
        Ok(await weather.SeriesAsync(q.RequiredStr("locationId"), q.RequiredTime("from"), q.RequiredTime("to"), q.Int("stepMinutes") ?? defaults.SeriesStepMinutes, ct));

    [HttpPost("resolve")]
    public async Task<ActionResult<WeatherResolveResponse>> Resolve([FromBody] WeatherResolveRequest body, CancellationToken ct) => Ok(await weather.ResolveAsync(body, ct));
}
