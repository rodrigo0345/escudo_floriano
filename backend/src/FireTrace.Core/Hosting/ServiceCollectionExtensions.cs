using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Threading.RateLimiting;
using FireTrace.Core.Common;
using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Fuel;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Domain.RoadClosures;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Domain.Scenarios;
using FireTrace.Core.Domain.Simulations;
using FireTrace.Core.Models.Errors;
using FireTrace.Core.Models.Fire;
using FireTrace.Core.Models.Meta;
using FireTrace.Core.Repositories;
using FireTrace.Core.Serialization;
using FireTrace.Core.Services.Crud;
using FireTrace.Core.Services.Fire;
using FireTrace.Core.Services.Map;
using FireTrace.Core.Services.Meta;
using FireTrace.Core.Services.Operations;
using FireTrace.Core.Services.Policies;
using FireTrace.Core.Services.Resources;
using FireTrace.Core.Services.Routing;
using FireTrace.Core.Services.Weather;
using FireTrace.Engine.Weather;
using FireTrace.Engine;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData;
using FireTrace.ExternalData.Ingest;
using Microsoft.AspNetCore.RateLimiting;

namespace FireTrace.Core.Hosting;

/// <summary>
/// The composition root: the one place that knows which implementation serves each interface. It reads the host's environment
/// (`ENGINE_URL`, `FIRETRACE_JOBS`, `FIRETRACE_SPEC`...) through <see cref="IConfiguration"/> and hands plain values to everything else.
/// </summary>
public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddFireTrace(this IServiceCollection services, IConfiguration config)
    {
        var settings = FireTraceSettings.FromConfiguration(config);
        var resolver = new ExternalDataPathsResolver();
        var paths = resolver.Resolve(ExternalDataOptions.FromConfiguration(config).ConnectionString);

        services.AddSingleton<TimeProvider>(TimeProvider.System).AddSingleton<IIdGenerator, ShortGuidIdGenerator>().AddSingleton<Readiness>().AddSingleton<IIngestLog, ConsoleIngestLog>();
        return services
            .AddFireTraceSettings(settings)
            .AddRateLimiting(settings.Limits)
            .AddExternalData(config, paths)
            .AddFireEngine(settings.Engine, settings.NativeEngine, settings.FuelMoisture, settings.Convection, settings.RunStore, EnginePathsFor(config, settings, paths))
            .AddRepositories(SpecPath(config, resolver))
            .AddServices(settings)
            .AddHostedService<SimulationWorker>()
            .AddHostedService<Bootstrap>();
    }

    static EnginePaths EnginePathsFor(IConfiguration config, FireTraceSettings settings, ExternalDataPaths paths) => new(
        JobsDir: config["FIRETRACE_JOBS"] ?? Path.Combine(paths.DataDir, "jobs"),
        RunsDir: Path.Combine(paths.DataDir, "runs"),
        CacheDir: Path.Combine(paths.DataDir, "engine-cache"),
        ElmfireUrl: config["ENGINE_URL"] ?? settings.Engine.Url,
        Workers: Environment.ProcessorCount);

    static string SpecPath(IConfiguration config, ExternalDataPathsResolver resolver) =>
        config["FIRETRACE_SPEC"] ?? Path.Combine(resolver.ResolveFolder("api-spec", "", "FIRETRACE_SPEC_DIR", "openapi.json"), "openapi.json");

    /// <summary>Every group of settings is registered on its own, so a service asks only for the group it uses.</summary>
    static IServiceCollection AddFireTraceSettings(this IServiceCollection services, FireTraceSettings s) => services
        .AddSingleton(s).AddSingleton(s.Limits).AddSingleton(s.Defaults).AddSingleton(s.Engine).AddSingleton(s.Simulation).AddSingleton(s.Weather).AddSingleton(s.Landscape)
        .AddSingleton(s.FuelMoisture).AddSingleton(s.Interventions).AddSingleton(s.Analytics).AddSingleton(s.Smoke).AddSingleton(s.Routing).AddSingleton(s.Map).AddSingleton(s.Dispatch)
        .AddSingleton(s.RunStore).AddSingleton(s.Database).AddSingleton(s.Rules).AddSingleton(s.NativeEngine).AddSingleton(s.Convection).AddSingleton(new FuelCatalog(s.Fuels));

    static IServiceCollection AddRepositories(this IServiceCollection services, string specPath) => services
        .AddSingleton(typeof(IDocumentStore<>), typeof(PgDocumentStore<>))
        .AddSingleton<IFireRunRepository, FireRunRepository>()
        .AddSingleton<IApiSpecRepository>(_ => new FileApiSpecRepository(specPath));

    static IServiceCollection AddServices(this IServiceCollection services, FireTraceSettings s)
    {
        // resources: one generic service for all of them; the rules specific to a type are registered after the generic policy
        services.AddSingleton(typeof(IEntityPolicy<>), typeof(DefaultPolicy<>)).AddSingleton(typeof(CrudService<>));
        services.AddSingleton<IEntityPolicy<Scenario>, ScenarioPolicy>().AddSingleton<IEntityPolicy<RoadClosure>, RoadClosurePolicy>();
        services.AddSingleton<IEntityPolicy<Organization>, OrganizationPolicy>().AddSingleton<IEntityPolicy<Station>, StationPolicy>().AddSingleton<IEntityPolicy<Vehicle>, VehiclePolicy>()
            .AddSingleton<IEntityPolicy<PersonnelPool>, PersonnelPoolPolicy>().AddSingleton<IEntityPolicy<Equipment>, EquipmentPolicy>().AddSingleton<IEntityPolicy<Plan>, PlanPolicy>()
            .AddSingleton<IEntityPolicy<PlanRequest>, PlanRequestPolicy>();

        services.AddSingleton<MetaService>().AddSingleton<WeatherService>();
        services.AddSingleton(new SmokePlume(s.Smoke)).AddSingleton<SmokeService>();
        services.AddSingleton<Population>().AddSingleton<MapQueries>().AddSingleton<RoadStatusResolver>().AddSingleton<RoadSpeeds>().AddSingleton<LandscapeBuilder>();
        services.AddSingleton<CrewSafety>().AddSingleton<PlanValidator>().AddSingleton<ResponsibilityRules>().AddSingleton<TargetResolver>().AddSingleton<DispatchService>().AddSingleton<PlanService>()
            .AddSingleton<PlanRequestService>();
        services.AddSingleton<IResourceDispatcher, VehicleDispatcher>().AddSingleton<IResourceDispatcher, PersonnelDispatcher>().AddSingleton<IInterventionProvider, PlanInterventions>();
        services.AddSingleton<OwnerFilter>().AddSingleton<VehicleFilter>().AddSingleton<VehicleStateService>().AddSingleton<ResourceOverview>().AddSingleton<RoutingService>().AddSingleton<ArrivalEstimator>().AddSingleton<PlanRouter>()
            .AddSingleton<OperationSimulator>();
        return services.AddSingleton<ScenarioSeeder>().AddSingleton<ResourceSeeder>().AddSingleton<RoadCutsCache>().AddSingleton<SimulationQueue>().AddSingleton<SimulationService>().AddSingleton<FireResults>();
    }

    static IServiceCollection AddRateLimiting(this IServiceCollection services, LimitsSettings limits) =>
        services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            options.OnRejected = async (context, token) =>
            {
                context.HttpContext.Response.StatusCode = StatusCodes.Status429TooManyRequests;
                context.HttpContext.Response.ContentType = "application/problem+json";
                if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
                    context.HttpContext.Response.Headers.RetryAfter = ((int)Math.Max(1, Math.Ceiling(retryAfter.TotalSeconds))).ToString(CultureInfo.InvariantCulture);
                else
                    context.HttpContext.Response.Headers.RetryAfter = limits.RateLimitWindowSeconds.ToString(CultureInfo.InvariantCulture);

                var problem = new Problem(
                    "Demasiados pedidos: por favor aguarde antes de tentar novamente.",
                    StatusCodes.Status429TooManyRequests,
                    "rate_limited",
                    context.HttpContext.Request.Path,
                    null,
                    context.HttpContext.TraceIdentifier);
                await JsonSerializer.SerializeAsync(context.HttpContext.Response.Body, problem, ApiJson.Options, token);
            };

            options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
            {
                var remote = ctx.Connection.RemoteIpAddress;
                // `StringValues.ToString()` joins every header line with commas: reading only the first line
                // (`FirstOrDefault()`) would let a client that sends two X-Forwarded-For lines control
                // the entry our proxy's `$proxy_add_x_forwarded_for` did not write.
                var forwarded = ctx.Request.Headers["X-Forwarded-For"].ToString();
                var hasForwardedFor = forwarded.Length > 0;
                // Três classes de chamador:
                // 1. Utilizador real, através do nginx (IP privado + X-Forwarded-For): limita-se POR UTILIZADOR,
                //    pela ÚLTIMA entrada da lista — a que o nosso próprio proxy acrescentou
                //    (`$proxy_add_x_forwarded_for`); as anteriores vêm do cliente e são forjáveis.
                // 2. Serviço interno (a rede do compose — os agentes): IP privado sem proxy à frente; chama em rajada
                //    durante um ciclo de planeamento e esgotaria a janela de Internet, ficando depois preso em 429
                //    nos seus próprios polls. Partição própria e generosa (RateLimitInternalPermitLimit).
                // 3. Todo o resto (Internet direta, loopback): a janela apertada, pela própria origem; quem não está
                //    atrás do nosso proxy não consegue forjar X-Forwarded-For para ganhar uma partição nova.
                bool internalLimit;
                string clientIp;
                if (remote is not null && IsPrivateAddress(remote) && hasForwardedFor)
                {
                    clientIp = forwarded.Split(',').Select(p => p.Trim()).LastOrDefault(p => p.Length > 0) ?? "client";
                    internalLimit = false;
                }
                else
                {
                    // Sem peer direto (TestServer, unix socket): o X-Forwarded-For é tudo o que há — última entrada.
                    // Com peer público, o XFF é ignorado: não se forja a partição.
                    clientIp = remote?.ToString()
                        ?? (hasForwardedFor ? forwarded.Split(',').Select(p => p.Trim()).LastOrDefault(p => p.Length > 0) ?? "client" : "client");
                    internalLimit = IsInternalServiceClient(remote, hasForwardedFor);
                }
                // An unset `RateLimitInternalPermitLimit` binds to 0: fall back to the public window instead of
                // rejecting every internal call (a config typo must not take the agents offline).
                var internalPermits = limits.RateLimitInternalPermitLimit > 0 ? limits.RateLimitInternalPermitLimit : limits.RateLimitPermitLimit;
                return RateLimitPartition.GetFixedWindowLimiter(clientIp, _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = internalLimit ? internalPermits : limits.RateLimitPermitLimit,
                    Window = TimeSpan.FromSeconds(limits.RateLimitWindowSeconds),
                    QueueLimit = 0,
                    QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                });
            });

            options.AddConcurrencyLimiter("planning", o =>
            {
                o.PermitLimit = 1;
                o.QueueLimit = limits.PlanningQueueLimit;
                o.QueueProcessingOrder = QueueProcessingOrder.OldestFirst;
            });
        });

    /// <summary>Endereço privado (RFC 1918 / ULA fc00::/7), loopback incluído — reconhece o proxy à frente.</summary>
    static bool IsPrivateAddress(IPAddress ip)
    {
        if (IPAddress.IsLoopback(ip)) return true;
        // Docker/Kestrel can surface an IPv4 peer as an IPv4-mapped IPv6 address (`::ffff:172.18.0.5`);
        // unwrap it, or the internal agents would be mistaken for Internet traffic.
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (ip.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = ip.GetAddressBytes();
            return b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168);
        }
        if (ip.AddressFamily == AddressFamily.InterNetworkV6)
        {
            var b = ip.GetAddressBytes();
            return b[0] is 0xfc or 0xfd; // unique local addresses (fc00::/7)
        }
        return false;
    }

    /// <summary>Serviço interno (a rede do compose): IP privado NÃO-loopback, sem proxy à frente. O TestServer
    /// (loopback) e os clientes externos ficam de fora — o limite apertado é para quem vem da Internet.</summary>
    static bool IsInternalServiceClient(IPAddress? remote, bool hasForwardedFor)
    {
        if (remote is null || hasForwardedFor) return false;
        // normalize like `IsPrivateAddress`: `::ffff:127.0.0.1` is not `IsLoopback` as IPv6,
        // and a mapped loopback must stay on the tight limit, as the TestServer does.
        var ip = remote.IsIPv4MappedToIPv6 ? remote.MapToIPv4() : remote;
        return !IPAddress.IsLoopback(ip) && IsPrivateAddress(ip);
    }
}
