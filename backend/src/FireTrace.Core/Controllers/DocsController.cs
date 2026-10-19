using FireTrace.Core.Models.Errors;
using FireTrace.Core.Repositories;

namespace FireTrace.Core.Controllers;

/// <summary>The contract served as it was published (`api-spec/openapi.json`), always available: it does not depend on the database, the engine or the network.</summary>
[Route("/api/v1/openapi.json")]
public sealed class DocsController(IApiSpecRepository spec) : ApiController
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct) =>
        await spec.ReadAsync(ct) is { } bytes ? File(bytes, "application/json") : Problem("api-spec/openapi.json não encontrado", statusCode: StatusCodes.Status404NotFound);
}
