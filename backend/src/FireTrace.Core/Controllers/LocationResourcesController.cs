using FireTrace.Core.Models.Resources;
using FireTrace.Core.Services.Resources;

namespace FireTrace.Core.Controllers;

/// <summary>Os quadros de meios de um local: inventário e o que cada um está a fazer.</summary>
[Route("/api/v1/locations/{loc}")]
public sealed class LocationResourcesController(ResourceOverview overview) : ApiController
{
    [HttpGet("resources/summary")]
    public async Task<ActionResult<ResourceSummary>> Summary(string loc, CancellationToken ct) => Ok(await overview.SummaryAsync(loc, ct));

    [HttpGet("deployment")]
    public async Task<ActionResult<DeploymentOverview>> Deployment(string loc, CancellationToken ct) => Ok(await overview.DeploymentAsync(loc, ct));
}
