namespace FireTrace.Core.Common;

/// <summary>O que já está pronto: a base de dados migrada. Os pedidos que precisam dela respondem 503 até lá, mas a documentação e a saúde respondem sempre.</summary>
public sealed class Readiness
{
    volatile bool _database;
    public bool Database { get => _database; set => _database = value; }
    public string? Error { get; set; }
}
