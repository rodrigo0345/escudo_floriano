using FireTrace.Core.Repositories;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using FireTrace.Core.Common;

namespace FireTrace.Tests.Support;

/// <summary>A API inteira em memória: sem PostgreSQL e sem motor de fogo, com os documentos num dicionário.</summary>
public sealed class ApiFactory : WebApplicationFactory<ApiAssembly>
{
    readonly bool _databaseReady;
    public ApiFactory() : this(true) { }
    ApiFactory(bool databaseReady) => _databaseReady = databaseReady;
    public static ApiFactory WithoutDatabase() => new(false);

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.ConfigureServices(services =>
        {
            services.RemoveAll(typeof(IDocumentStore<>));
            services.AddSingleton(typeof(IDocumentStore<>), typeof(MemoryDocumentStore<>));
            services.RemoveAll<IHostedService>(); // sem migrações nem worker de simulações
            services.RemoveAll<Readiness>();
            services.AddSingleton(new Readiness { Database = _databaseReady });
        });
    }
}
