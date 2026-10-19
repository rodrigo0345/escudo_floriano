using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Domain.Simulations;
using FireTrace.Core.Models.Paging;
using FireTrace.Core.Services.Fire;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Controllers;

/// <summary>Pedir, consultar, cancelar e apagar simulações de fogo (os resultados estão em <see cref="SimulationResultsController"/>).</summary>
[Route("/api/v1/simulations")]
public sealed class SimulationsController(SimulationService simulations) : ApiController
{
    [HttpGet]
    public async Task<ActionResult<Page<Simulation>>> List([FromQuery] Query q, [FromQuery] PageQuery page, CancellationToken ct)
    {
        var statuses = q.Enums<SimulationStatus>("status");
        var kind = q.Str("kind");
        return Ok(await simulations.PageAsync(page, s => (q.Str("locationId") is not { } l || s.LocationId == l) && (q.Str("scenarioId") is not { } sc || s.ScenarioId == sc)
            && (q.Str("planId") is not { } p || s.PlanId == p) && (statuses.Count == 0 || statuses.Contains(s.Status)) && (kind is null || EnumText.ToSnake(s.Kind) == kind), ct));
    }

    /// <summary>Assíncrono: 202 com a simulação em fila; com `Prefer: wait=N` espera até N segundos e devolve 201 se terminar a tempo.</summary>
    [HttpPost]
    public async Task<ActionResult<Simulation>> Create([FromBody] SimulationRequest body, CancellationToken ct)
    {
        var simulation = await simulations.CreateAsync(body, ct: ct);
        var wait = Request.Headers["Prefer"].ToString().Split(',').Select(p => p.Trim()).FirstOrDefault(p => p.StartsWith("wait="));
        if (wait is not null && int.TryParse(wait[5..], out var seconds)) simulation = await simulations.WaitAsync(simulation.Id, seconds, ct);
        var finished = simulation.Status is not (SimulationStatus.Queued or SimulationStatus.Running);
        Response.Headers.Location = $"{Base}/simulations/{simulation.Id}";
        return StatusCode(finished ? StatusCodes.Status201Created : StatusCodes.Status202Accepted, simulation);
    }

    [HttpGet("{id}")]
    public async Task<ActionResult<Simulation>> Get(string id, CancellationToken ct) => Ok(await simulations.GetAsync(id, ct));

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        await simulations.DeleteAsync(id, ct);
        return NoContent();
    }

    [HttpPost("{id}/cancel")]
    public async Task<ActionResult<Simulation>> Cancel(string id, CancellationToken ct) => Ok(await simulations.CancelAsync(id, ct));
}
