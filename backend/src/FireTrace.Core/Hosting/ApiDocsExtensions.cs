using Swashbuckle.AspNetCore.SwaggerUI;

namespace FireTrace.Core.Hosting;

public static class ApiDocsExtensions
{
    /// <summary>Interactive documentation of the published contract at `/swagger` (the UI is embedded in the server, so it needs no network).</summary>
    public static void UseApiDocs(this WebApplication app)
    {
        app.MapGet("/docs", () => Results.Redirect("/swagger"));
        app.UseSwaggerUI(o =>
        {
            o.RoutePrefix = "swagger";
            o.SwaggerEndpoint("/api/v1/openapi.json", "FireTrace API");
            o.DocumentTitle = "FireTrace — API";
            o.DocExpansion(DocExpansion.List);
            o.EnableDeepLinking();
            o.EnableFilter();
            o.EnableTryItOutByDefault();
            o.DisplayRequestDuration();
            o.DefaultModelsExpandDepth(-1);
        });
    }
}
