namespace FireTrace.ExternalData;

/// <summary>
/// Os argumentos do CLI `ingest`: <c>--location &lt;id&gt; [--only a,b] [--skip a,b] [--list] [--locations-dir &lt;pasta&gt;] [--data-dir &lt;pasta&gt;]</c>.
/// Cada opção é <c>--nome</c> seguida, se tiver valor, desse valor.
/// </summary>
public sealed record IngestCommandLine(string Location, IReadOnlySet<string> Only, IReadOnlySet<string> Skip, bool List, string LocationsDir, string DataDir)
{
    public static IngestCommandLine Parse(string[] args)
    {
        var options = args.Select((a, i) => (a, i)).Where(t => t.a.StartsWith("--")).ToDictionary(t => t.a[2..], t => t.i + 1 < args.Length && !args[t.i + 1].StartsWith("--") ? args[t.i + 1] : "");
        string Value(string key) => options.GetValueOrDefault(key, "");
        HashSet<string> Names(string key) => Value(key).Split(',', StringSplitOptions.RemoveEmptyEntries).ToHashSet();
        return new IngestCommandLine(Value("location"), Names("only"), Names("skip"), options.ContainsKey("list"), Value("locations-dir"), Value("data-dir"));
    }
}
