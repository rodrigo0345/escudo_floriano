using System.Globalization;
using FireTrace.ExternalData;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Ingest;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

// Carrega os dados do mapa de um local para o PostGIS. É a raiz de composição do CLI: lê os argumentos, monta os serviços e corre os passos.
//   ingest --location guimaraes-concelho [--only roads,water] [--skip imagery,ortho] [--list]
CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;

var command = IngestCommandLine.Parse(args);
var configuration = new ConfigurationBuilder()
    .AddJsonFile(Path.Combine(AppContext.BaseDirectory, ExternalDataOptions.FileName), optional: false)
    .AddEnvironmentVariables()
    .Build();
var paths = new ExternalDataPathsResolver().Resolve(ExternalDataOptions.FromConfiguration(configuration).ConnectionString, command.LocationsDir, command.DataDir);

await using var services = new ServiceCollection()
    .AddSingleton<IIngestLog, ConsoleIngestLog>()
    .AddExternalData(configuration, paths)
    .BuildServiceProvider();
var runner = services.GetRequiredService<IngestRunner>();

if (command.List) { foreach (var step in runner.Steps) Console.WriteLine(step.Name); return 0; }

var catalog = services.GetRequiredService<LocationCatalog>();
var locationsToIngest = string.IsNullOrEmpty(command.Location) || command.Location.Equals("all", StringComparison.OrdinalIgnoreCase)
    ? catalog.All
    : new[] { catalog.Find(command.Location) ?? throw new InvalidOperationException($"Local '{command.Location}' não encontrado em {paths.LocationsDir}") };

await services.GetRequiredService<SqlMigrator>().RunAsync(typeof(PostgisMapStore).Assembly);
foreach (var loc in locationsToIngest)
{
    await runner.RunAsync(loc, command.Only, command.Skip);
}
return 0;
