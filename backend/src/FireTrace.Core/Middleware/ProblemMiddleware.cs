using System.Text.Json;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Models.Errors;
using FireTrace.Core.Serialization;
using FireTrace.Engine.Contracts;

namespace FireTrace.Core.Middleware;

/// <summary>Transforma as exceções de negócio em respostas `application/problem+json` (RFC 9457).</summary>
public sealed class ProblemMiddleware(RequestDelegate next, ILogger<ProblemMiddleware> log)
{
    public async Task InvokeAsync(HttpContext ctx)
    {
        try { await next(ctx); }
        catch (Exception e) when (!ctx.Response.HasStarted)
        {
            var (status, code, title, errors) = e switch
            {
                ApiException a => (a.Status, a.Code, a.Message, (a as ValidationException)?.Issues),
                EngineUnavailableException => (503, "engine_unavailable", e.Message, null),
                JsonException or BadHttpRequestException => (400, "bad_request", "Pedido malformado: " + e.Message, null),
                HttpRequestException => (503, "dependency_unavailable", "Uma dependência externa não respondeu: " + e.Message, null),
                _ => (500, "internal_error", "Erro inesperado.", null),
            };
            if (status >= 500 && e is not ApiException) log.LogError(e, "Erro não tratado em {Path}", ctx.Request.Path);
            ctx.Response.StatusCode = status;
            ctx.Response.ContentType = "application/problem+json";
            await JsonSerializer.SerializeAsync(ctx.Response.Body, new Problem(title, status, code, ctx.Request.Path, errors, ctx.TraceIdentifier), ApiJson.Options);
        }
    }
}
