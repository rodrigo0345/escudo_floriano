using FireTrace.Core.Configuration;
using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Weather;
using FireTrace.Core.Models.Fire;
using FireTrace.Core.Models.Map;
using FireTrace.Core.Services.Fire;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Controllers;

/// <summary>O que uma simulação deu: resumo, perímetros, impacto, estradas cortadas, acessos, fumo, meteorologia e as grelhas brutas.</summary>
[Route("/api/v1/simulations/{id}")]
public sealed class SimulationResultsController(FireResults results, SmokeService smoke, DefaultsSettings defaults) : ApiController
{
    [HttpGet("summary")]
    public async Task<ActionResult<SimulationSummary>> Summary(string id, [FromQuery] Query q, CancellationToken ct) =>
        Ok(await results.SummaryAsync(id, q.Int("step") ?? defaults.SummaryStepMinutes, q.Str("percentile"), ct));

    [HttpGet("perimeters")]
    public async Task<IActionResult> Perimeters(string id, [FromQuery] Query q, CancellationToken ct) =>
        Ok(await results.PerimetersAsync(id, q.Int("tMin"), q.Int("step"), q.Strings("percentile"), ct));

    [HttpGet("vectors")]
    public async Task<IActionResult> Vectors(string id, [FromQuery] Query q, CancellationToken ct) =>
        Ok(await results.VectorsAsync(id, q.RequiredInt("tMin"), q.Int("windowMin") ?? defaults.VectorWindowMinutes, ct));

    [HttpGet("impact")]
    public async Task<ActionResult<ImpactReport>> Impact(string id, [FromQuery] Query q, CancellationToken ct) =>
        Ok(await results.ImpactAsync(id, q.RequiredInt("tMin"), q.Str("percentile"), q.Bool("includeOpen") == true, ct));

    [HttpGet("road-status")]
    public async Task<ActionResult<RoadStatusTimeline>> RoadStatus(string id, [FromQuery] Query q, CancellationToken ct) =>
        Ok(await results.RoadStatusAsync(id, q.Strings("class"), q.Dbl("minProbability") ?? defaults.MinProbability, ct));

    [HttpGet("place-access")]
    public async Task<ActionResult<PlaceAccessTimeline>> PlaceAccess(string id, [FromQuery] Query q, CancellationToken ct) =>
        Ok(await results.PlaceAccessAsync(id, q.Str("origin") ?? defaults.PlaceAccessOrigin, q.Int("stepMin") ?? defaults.PlaceAccessStepMinutes, q.Str("percentile"), ct));

    [HttpGet("threatened")]
    public async Task<ActionResult<ThreatenedReport>> Threatened(string id, [FromQuery] Query q, CancellationToken ct) =>
        Ok(await results.ThreatenedAsync(id, q.Int("tMin"), q.Int("horizonMin") ?? defaults.ThreatenedHorizonMinutes, q.Dbl("minProbability") ?? defaults.MinProbability, ct));

    [HttpGet("arrival")]
    public async Task<ActionResult<ArrivalEntry>> Arrival(string id, [FromQuery] Query q, CancellationToken ct) =>
        Ok((await results.ArrivalAsync(id, new[] { new ArrivalPoint(null, q.RequiredLatLon()) }, ct)).Items[0]);

    [HttpPost("arrival")]
    public async Task<ActionResult<ArrivalResult>> ArrivalFor(string id, [FromBody] ArrivalRequest body, CancellationToken ct) => Ok(await results.ArrivalAsync(id, body.Points, ct));

    [HttpGet("smoke")]
    public async Task<ActionResult<Smoke>> Smoke(string id, [FromQuery] Query q, CancellationToken ct) => Ok(await smoke.SummaryAsync(id, q.RequiredInt("tMin"), ct));

    [HttpGet("weather")]
    public async Task<ActionResult<WeatherSeries>> Weather(string id, CancellationToken ct) => Ok(await results.WeatherAsync(id, ct));

    [HttpGet("grids/{grid}")]
    public async Task<IActionResult> Grid(string id, string grid, [FromQuery] Query q, CancellationToken ct)
    {
        var result = await results.GridAsync(id, grid, q.Str("member"), ct);
        return GridFile(new GridData(result.Bytes, result.Width, result.Height, result.CellM, result.DType));
    }

    /// <summary>O movimento dos meios (viaturas, água, cansaço) ainda não está implementado.</summary>
    [HttpGet("units")]
    public IActionResult Units(string id) => throw new UnsupportedException("units");

    [HttpGet("units/{unitId}/track")]
    public IActionResult UnitTrack(string id, string unitId) => throw new UnsupportedException("units");
}
