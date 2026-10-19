using FireTrace.Core.Domain.Common;
using Npgsql;

namespace FireTrace.Core.Services.Crud;

/// <summary>Sem regras especiais: só dá o prefixo dos ids (`veh-…`, `pla-…`).</summary>
public sealed class DefaultPolicy<T> : EntityPolicy<T> where T : Entity
{
    public DefaultPolicy() : base(typeof(T).Name[..3].ToLowerInvariant()) { }
}
