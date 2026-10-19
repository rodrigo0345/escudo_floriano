using System.Reflection;
using Dapper;
using Npgsql;

namespace FireTrace.ExternalData.Store;

/// <summary>
/// Aplica, por ordem, os ficheiros .sql embebidos num assembly e regista os já aplicados (cada projeto usa a sua própria tabela de registo).
/// Uma instância por base de dados: <c>new SqlMigrator(dataSource).RunAsync(assembly, registryTable)</c>.
/// </summary>
public sealed class SqlMigrator(NpgsqlDataSource source)
{
    public async Task RunAsync(Assembly assembly, string registryTable = "schema_migrations", CancellationToken ct = default)
    {
        await using var c = await source.OpenConnectionAsync(ct);
        await c.ExecuteAsync($"CREATE TABLE IF NOT EXISTS {registryTable} (name text PRIMARY KEY, applied timestamptz NOT NULL DEFAULT now())");
        foreach (var res in assembly.GetManifestResourceNames().Where(n => n.EndsWith(".sql")).OrderBy(Short))
        {
            string name = Short(res);
            // as primeiras versões registavam o nome completo do recurso (FireTrace.Data.Migrations.001_init.sql): continuam a contar como aplicadas
            var done = await c.ExecuteScalarAsync<int>($"SELECT count(*) FROM {registryTable} WHERE name = @name OR name LIKE '%.' || @name", new { name });
            if (done > 0) continue;
            using var r = new StreamReader(assembly.GetManifestResourceStream(res)!);
            await using var tx = await c.BeginTransactionAsync(ct);
            await c.ExecuteAsync(await r.ReadToEndAsync(), transaction: tx);
            await c.ExecuteAsync($"INSERT INTO {registryTable}(name) VALUES (@name)", new { name }, tx);
            await tx.CommitAsync(ct);
        }
    }

    static string Short(string resource) => resource[(resource.LastIndexOf("Migrations.", StringComparison.Ordinal) + "Migrations.".Length)..];
}
