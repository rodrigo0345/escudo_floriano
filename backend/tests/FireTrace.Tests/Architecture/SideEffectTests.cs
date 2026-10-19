using System.Text.RegularExpressions;

namespace FireTrace.Tests.Architecture;

/// <summary>
/// The logic of the backend is made of functions of their inputs. Time, ids, randomness, environment, files and the console are reached only through
/// injected collaborators in the few adapters that are meant to touch the outside world.
/// </summary>
public class SideEffectTests
{
    static IEnumerable<string> AllSources() => SourceTree.Projects.SelectMany(p => SourceTree.Files(p));

    static IEnumerable<string> Matching(string pattern, IEnumerable<string> files) =>
        from file in files
        from line in File.ReadLines(file).Select((text, i) => (text, i))
        where !line.text.TrimStart().StartsWith("//") && Regex.IsMatch(line.text, pattern)
        select $"{SourceTree.Relative(file)}:{line.i + 1}: {line.text.Trim()}";

    static IEnumerable<string> Logic() =>
        new[] { "Domain", "Models", "Services", "Controllers", "Middleware" }.SelectMany(f => SourceTree.Files("FireTrace.Core", f));

    [Fact]
    public void Nothing_reads_the_clock_or_makes_up_ids_use_TimeProvider_and_IIdGenerator() =>
        Assert.Empty(Matching(@"DateTime(Offset)?\.(UtcNow|Now|Today)|\bGuid\.NewGuid|\bRandom\.Shared|new Random\(\)",
            AllSources().Where(f => !f.EndsWith("ShortGuidIdGenerator.cs") && !f.EndsWith("ServiceCollectionExtensions.cs") && !f.EndsWith("FileFireResultCache.cs"))));

    [Fact]
    public void The_logic_never_touches_files_the_environment_or_the_console() =>
        Assert.Empty(Matching(@"\b(File|Directory)\.\w+\(|\bEnvironment\.|\bConsole\.|\bProcess\.", Logic()));

    [Fact]
    public void There_is_no_static_mutable_state() =>
        Assert.Empty(Matching(@"static (readonly )?(Dictionary|ConcurrentDictionary|List|HashSet|Queue|ConditionalWeakTable|Lazy)<[^(]*(=|;)", AllSources().Where(f => Path.GetFileName(f) != "Program.cs")));

    [Fact]
    public void Configuration_is_read_through_typed_settings_with_no_inline_defaults() =>
        Assert.Empty(Matching(@"\.GetValue(<\w+>)?\(""FireTrace|config\[""FireTrace", AllSources()));
}
