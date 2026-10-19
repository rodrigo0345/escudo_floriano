using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Models.Meta;
using FireTrace.Core.Services.Meta;

namespace FireTrace.Core.Controllers;

/// <summary>Saúde do servidor, o que suporta agora e as regras do modelo.</summary>
[Route("/api/v1")]
public sealed class MetaController(MetaService meta) : ApiController
{
    [HttpGet("health")]
    public async Task<ActionResult<HealthReport>> Health(CancellationToken ct) => Ok(await meta.HealthAsync(ct));

    [HttpGet("capabilities")]
    public ActionResult<Capabilities> Capabilities() => Ok(meta.Capabilities());

    [HttpGet("rules")]
    public ActionResult<Rules> Rules() => Ok(meta.Rules());
}
