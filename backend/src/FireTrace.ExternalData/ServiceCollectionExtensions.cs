using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Ingest;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Buildings;
using FireTrace.ExternalData.Sources.Http;
using FireTrace.ExternalData.Sources.Imagery;
using FireTrace.ExternalData.Sources.Imaging;
using FireTrace.ExternalData.Sources.Overpass;
using FireTrace.ExternalData.Sources.Places;
using FireTrace.ExternalData.Sources.Roads;
using FireTrace.ExternalData.Sources.Terrain;
using FireTrace.ExternalData.Sources.Vegetation;
using FireTrace.ExternalData.Sources.Water;
using FireTrace.ExternalData.Sources.Waterways;
using FireTrace.ExternalData.Store;
using FireTrace.ExternalData.Weather;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Npgsql;

namespace FireTrace.ExternalData;

public static class ServiceCollectionExtensions
{
    /// <summary>
    /// Regista tudo o que vem de serviços de terceiros: as opções (<c>FireTrace:ExternalData</c> em <paramref name="configuration"/>), a base de dados do mapa
    /// (<see cref="IMapReader"/> com cache e <see cref="IMapWriter"/>), o tempo (<see cref="IWeatherSource"/>), as fontes de dados e os passos do ingest
    /// (<see cref="IngestRunner"/>). Só <see cref="TimeProvider"/> e <see cref="IIngestLog"/> têm um valor por omissão (<c>TryAdd</c>): quem quiser outro regista-o antes.
    /// </summary>
    public static IServiceCollection AddExternalData(this IServiceCollection services, IConfiguration configuration, ExternalDataPaths paths)
    {
        var options = ExternalDataOptions.FromConfiguration(configuration);
        services.AddSingleton(options).AddSingleton(paths);
        services.AddSingleton(options.OpenMeteo).AddSingleton(options.Http).AddSingleton(options.Overpass).AddSingleton(options.Roads).AddSingleton(options.Places).AddSingleton(options.Water)
            .AddSingleton(options.Waterways).AddSingleton(options.Terrain).AddSingleton(options.Imagery).AddSingleton(options.Ortho).AddSingleton(options.LandCover);
        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<IIngestLog, SilentIngestLog>();

        AddStore(services, options, paths);
        AddWeather(services);
        AddSources(services);
        AddIngest(services);
        return services;
    }

    static void AddStore(IServiceCollection services, ExternalDataOptions options, ExternalDataPaths paths)
    {
        services.AddSingleton(_ => PostgisDataSource.Create(paths.ConnectionString));
        services.AddSingleton(_ => LocationCatalog.FromDirectory(paths.LocationsDir));
        services.AddSingleton<SqlMigrator>();
        services.AddSingleton(sp => new PostgisMapStore(sp.GetRequiredService<NpgsqlDataSource>(), sp.GetRequiredService<LocationCatalog>(), paths.DataDir));
        services.AddSingleton<IMapWriter>(sp => sp.GetRequiredService<PostgisMapStore>());
        services.AddKeyedSingleton<IMapReader>(ExternalDataServiceKeys.UncachedReader, (sp, _) => sp.GetRequiredService<PostgisMapStore>());
        services.AddSingleton<IMapReader>(sp => new CachedMapReader(sp.GetRequiredService<PostgisMapStore>(), TimeSpan.FromMinutes(options.CacheTtlMinutes), sp.GetRequiredService<TimeProvider>()));
    }

    static void AddWeather(IServiceCollection services) =>
        services.AddSingleton<IWeatherSource>(sp =>
        {
            var o = sp.GetRequiredService<OpenMeteoOptions>();
            return new OpenMeteoSource(CreateHttpClient(TimeSpan.FromSeconds(o.HttpTimeoutSeconds), o.UserAgent), sp.GetRequiredService<NpgsqlDataSource>(), o, sp.GetRequiredService<TimeProvider>());
        });

    static void AddSources(IServiceCollection services)
    {
        services.AddSingleton(sp => { var o = sp.GetRequiredService<HttpOptions>(); return new HttpFetcher(CreateHttpClient(TimeSpan.FromMinutes(o.TimeoutMinutes), o.UserAgent), o); });
        services.AddSingleton<ImageFileWriter>().AddSingleton<OverpassCache>().AddSingleton<OverpassClient>();
        services.AddSingleton<TerrariumSource>().AddSingleton<EoxImagerySource>().AddSingleton<DgtOrthoSource>();
        services.AddSingleton<WorldCoverSource>().AddSingleton<HrlSource>().AddSingleton<Sentinel2Source>().AddSingleton<SpeciesMapBuilder>();
        services.AddSingleton<OsmRoadsSource>().AddSingleton<OsmBuildingsSource>().AddSingleton<OsmPlacesSource>().AddSingleton<WaterSource>().AddSingleton<OsmWaterwaysSource>();
    }

    static void AddIngest(IServiceCollection services)
    {
        services.AddSingleton<IIngestStep, TerrainStep>().AddSingleton<IIngestStep, VegetationStep>().AddSingleton<IIngestStep, SatelliteStep>().AddSingleton<IIngestStep, OrthophotoStep>()
            .AddSingleton<IIngestStep, RoadsStep>().AddSingleton<IIngestStep, BuildingsStep>().AddSingleton<IIngestStep, PlacesStep>().AddSingleton<IIngestStep, WaterStep>()
            .AddSingleton<IIngestStep, WaterwaysStep>().AddSingleton<IIngestStep, FirebreaksStep>();
        services.AddSingleton<IngestRunner>();
    }

    static HttpClient CreateHttpClient(TimeSpan timeout, string userAgent)
    {
        var client = new HttpClient { Timeout = timeout };
        client.DefaultRequestHeaders.UserAgent.ParseAdd(userAgent);
        return client;
    }
}
