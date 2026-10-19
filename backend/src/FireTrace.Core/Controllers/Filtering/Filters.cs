namespace FireTrace.Core.Controllers.Filtering;

/// <summary>Predicates for list endpoints: each one only applies when its query parameter was given (`When(wanted, x => x.Prop)`), and `All` joins them.</summary>
public static class Filters
{
    public static Func<T, bool> All<T>(params Func<T, bool>[] conditions) => item => conditions.All(c => c(item));

    public static Func<T, bool> When<T, V>(HashSet<V> wanted, Func<T, V?> pick) where V : struct => item => wanted.Count == 0 || (pick(item) is { } v && wanted.Contains(v));
    public static Func<T, bool> When<T>(string? wanted, Func<T, string?> pick) => item => wanted is null || pick(item) == wanted;
    public static Func<T, bool> When<T>(bool? wanted, Func<T, bool> pick) => item => wanted is null || pick(item) == wanted;
}
