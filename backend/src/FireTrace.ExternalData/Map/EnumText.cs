using System.Text.RegularExpressions;

namespace FireTrace.ExternalData.Map;

/// <summary>Enumerações como texto `snake_case` (base de dados e JSON usam o mesmo): FireStation ⇄ "fire_station".</summary>
public static partial class EnumText
{
    [GeneratedRegex("(?<!^)([A-Z])")]
    private static partial Regex Humps();

    public static string ToSnake<T>(T value) where T : struct, Enum => Humps().Replace(value.ToString(), "_$1").ToLowerInvariant();

    public static T Parse<T>(string text) where T : struct, Enum => ByText<T>.Values[Normalize(text)];

    public static bool TryParse<T>(string? text, out T value) where T : struct, Enum
    {
        value = default;
        return text is not null && ByText<T>.Values.TryGetValue(Normalize(text), out value);
    }

    static string Normalize(string text) => text.Trim().ToLowerInvariant();

    /// <summary>The text → value table of one enum type; the runtime builds it once per type and it never changes afterwards.</summary>
    static class ByText<T> where T : struct, Enum
    {
        public static readonly Dictionary<string, T> Values = Enum.GetValues<T>().ToDictionary(v => ToSnake(v), v => v);
    }
}
