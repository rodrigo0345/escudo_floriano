using Npgsql;

namespace FireTrace.ExternalData.Store;

/// <summary>Creates the Npgsql data source every PostgreSQL consumer of this project shares (geometry types enabled).</summary>
public static class PostgisDataSource
{
    public static NpgsqlDataSource Create(string connectionString)
    {
        var builder = new NpgsqlDataSourceBuilder(connectionString);
        builder.UseNetTopologySuite();
        return builder.Build();
    }
}
