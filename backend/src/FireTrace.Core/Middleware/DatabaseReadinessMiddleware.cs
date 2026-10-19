using FireTrace.Core.Common;
using FireTrace.Core.Domain.Errors;

namespace FireTrace.Core.Middleware;

/// <summary>
/// What needs the database waits for it (503 until it is migrated); the documentation, health, capabilities and rules always answer.
/// The server starts listening before the database is ready, so a slow database never keeps the API down.
/// </summary>
public sealed class DatabaseReadinessMiddleware(RequestDelegate next, Readiness readiness)
{
    static readonly string[] AlwaysAvailable = { "/health", "/capabilities", "/rules", "/openapi.json" };

    public Task InvokeAsync(HttpContext ctx)
    {
        var path = ctx.Request.Path.Value ?? "";
        bool needsDatabase = path.StartsWith(ApiBase) && !AlwaysAvailable.Any(path.EndsWith);
        if (needsDatabase && !readiness.Database) throw new ServiceUnavailableException("A base de dados ainda não está pronta; tente daqui a pouco.");
        return next(ctx);
    }

    const string ApiBase = "/api/v1";
}
