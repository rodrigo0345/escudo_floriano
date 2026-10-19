using NetTopologySuite.Geometries;
using Npgsql;
using NpgsqlTypes;

namespace FireTrace.ExternalData.Store;

/// <summary>Escrita e leitura de valores (possivelmente nulos) em COPY binário e em leitores, sem repetir o tipo Npgsql em cada coluna.</summary>
static class RowExtensions
{
    public static async Task Put(this NpgsqlBinaryImporter w, params object?[] values)
    {
        foreach (var v in values)
        {
            switch (v)
            {
                case null: await w.WriteNullAsync(); break;
                case string s: await w.WriteAsync(s, NpgsqlDbType.Text); break;
                case int i: await w.WriteAsync(i, NpgsqlDbType.Integer); break;
                case long l: await w.WriteAsync(l, NpgsqlDbType.Bigint); break;
                case double d: await w.WriteAsync(d, NpgsqlDbType.Double); break;
                case bool b: await w.WriteAsync(b, NpgsqlDbType.Boolean); break;
                case Geometry g: await w.WriteAsync(g, NpgsqlDbType.Geometry); break;
                default: throw new NotSupportedException($"Tipo não suportado em COPY: {v.GetType()}");
            }
        }
    }

    public static string? Str(this NpgsqlDataReader r, int i) => r.IsDBNull(i) ? null : r.GetString(i);
    public static double? Dbl(this NpgsqlDataReader r, int i) => r.IsDBNull(i) ? null : r.GetDouble(i);
    public static int? Int(this NpgsqlDataReader r, int i) => r.IsDBNull(i) ? null : r.GetInt32(i);
}
