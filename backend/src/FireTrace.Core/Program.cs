using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Hosting;
using FireTrace.Core.Middleware;
using FireTrace.Core.Serialization;
using FireTrace.ExternalData.Configuration;

var builder = WebApplication.CreateBuilder(args);
// third-party data has its own settings file (copied next to the executable from the ExternalData project)
builder.Configuration.AddJsonFile(Path.Combine(AppContext.BaseDirectory, ExternalDataOptions.FileName), optional: false);
builder.WebHost.UseUrls(builder.Configuration["FIRETRACE_URL"] ?? "http://localhost:8080");
builder.Services.AddFireTrace(builder.Configuration);
builder.Services.AddControllers(o => o.ModelBinderProviders.Insert(0, new QueryModelBinderProvider()))
    .AddJsonOptions(o => ApiJson.Configure(o.JsonSerializerOptions))
    .ConfigureApiBehaviorOptions(o => o.InvalidModelStateResponseFactory = context =>
        throw new BadHttpRequestException(string.Join("; ", context.ModelState.Values.SelectMany(v => v.Errors).Select(e => e.ErrorMessage)))); // malformed requests reach ProblemMiddleware

var app = builder.Build();
app.UseMiddleware<ProblemMiddleware>();
app.UseApiDocs();
app.UseMiddleware<DatabaseReadinessMiddleware>();
app.MapControllers();
app.Run();

/// <summary>Marks the API's assembly: the integration tests start the server from it.</summary>
public sealed class ApiAssembly;
