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
using FireTrace.Core.Models.Fire;
using FireTrace.Core.Models.Meta;
using FireTrace.Core.Repositories;
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
            .AddSingleton<IEntityPolicy<PersonnelPool>, PersonnelPoolPolicy>().AddSingleton<IEntityPolicy<Equipment>, EquipmentPolicy>().AddSingleton<IEntityPolicy<Plan>, PlanPolicy>();

        services.AddSingleton<MetaService>().AddSingleton<WeatherService>();
        services.AddSingleton(new SmokePlume(s.Smoke)).AddSingleton<SmokeService>();
        services.AddSingleton<Population>().AddSingleton<MapQueries>().AddSingleton<RoadStatusResolver>().AddSingleton<RoadSpeeds>().AddSingleton<LandscapeBuilder>();
        services.AddSingleton<CrewSafety>().AddSingleton<PlanValidator>().AddSingleton<ResponsibilityRules>().AddSingleton<TargetResolver>().AddSingleton<DispatchService>().AddSingleton<PlanService>();
        services.AddSingleton<IResourceDispatcher, VehicleDispatcher>().AddSingleton<IResourceDispatcher, PersonnelDispatcher>().AddSingleton<IInterventionProvider, PlanInterventions>();
        services.AddSingleton<OwnerFilter>().AddSingleton<VehicleFilter>().AddSingleton<VehicleStateService>().AddSingleton<ResourceOverview>().AddSingleton<RoutingService>();
        return services.AddSingleton<ScenarioSeeder>().AddSingleton<ResourceSeeder>().AddSingleton<RoadCutsCache>().AddSingleton<SimulationQueue>().AddSingleton<SimulationService>().AddSingleton<FireResults>();
    }
}
