using System.Text.Json;
using FireTrace.Engine.Caching;
using FireTrace.Engine.Configuration;
using FireTrace.Engine.Contracts;
using FireTrace.Engine.Coupling;
using FireTrace.Engine.Elmfire;
using FireTrace.Engine.Native;
using FireTrace.Engine.Storage;
using Microsoft.Extensions.DependencyInjection;

namespace FireTrace.Engine;

public static class ServiceCollectionExtensions
{
    /// <summary>
    /// Registers the fire engine and the run store. The engine is the chosen provider (`native` or `elmfire`), wrapped by the result cache and
    /// then by the fire/wind coupling: coupling(cache(provider)).
    /// </summary>
    public static IServiceCollection AddFireEngine(this IServiceCollection services, EngineSettings engine, NativeEngineSettings native, FuelMoistureSettings moisture,
        ConvectionSettings convection, RunStoreSettings runStore, EnginePaths paths)
    {
        services.AddSingleton<IRunStore>(_ => new FileRunStore(paths.RunsDir, runStore));
        services.AddSingleton<IFireResultCache>(_ => new FileFireResultCache(paths.CacheDir));
        services.AddSingleton<IFireEngine>(sp =>
        {
            bool elmfire = engine.Provider == "elmfire";
            IFireEngine provider = elmfire ? CreateElmfire(engine, moisture, paths) : new NativeFireEngine(native, moisture, paths.Workers);
            var scope = $"{engine.Provider}:{JsonSerializer.Serialize(elmfire ? (object)engine : native)}:{JsonSerializer.Serialize(moisture)}";
            return new CoupledFireEngine(new CachedFireEngine(provider, sp.GetRequiredService<IFireResultCache>(), scope), convection, engine);
        });
        return services;
    }

    static ElmfireEngine CreateElmfire(EngineSettings engine, FuelMoistureSettings moisture, EnginePaths paths)
    {
        var options = new ElmfireOptions(paths.JobsDir, paths.ElmfireUrl, engine.MetIntervalSeconds, engine.HttpTimeoutMinutes, engine.HealthTimeoutSeconds, engine.ProgressPollSeconds, engine.Spotting);
        var client = new ElmfireClient(new HttpClient { Timeout = TimeSpan.FromMinutes(engine.HttpTimeoutMinutes) }, options);
        return new ElmfireEngine(client, new ElmfireJobFiles(options, moisture), options, () => Guid.NewGuid().ToString("N"));
    }
}
