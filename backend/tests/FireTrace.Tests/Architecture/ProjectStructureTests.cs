using System.Text.RegularExpressions;

namespace FireTrace.Tests.Architecture;

/// <summary>The shape of the solution is a rule, not an intention: these tests fail if someone breaks it.</summary>
public class ProjectStructureTests
{
    static IEnumerable<string> ReferencesOf(string project) =>
        Regex.Matches(File.ReadAllText(Path.Combine(SourceTree.Root, "src", project, project + ".csproj")), @"ProjectReference Include=""[^""]*[\\/](FireTrace\.\w+)\.csproj""")
            .Select(m => m.Groups[1].Value).Order();

    [Fact]
    public void There_are_exactly_three_source_projects()
    {
        var projects = Directory.GetFiles(Path.Combine(SourceTree.Root, "src"), "*.csproj", SearchOption.AllDirectories).Select(Path.GetFileNameWithoutExtension).Order().ToArray();
        Assert.Equal(new[] { "FireTrace.Core", "FireTrace.Engine", "FireTrace.ExternalData" }, projects);
    }

    [Fact]
    public void The_engine_and_the_external_data_projects_depend_on_no_other_project()
    {
        Assert.Empty(ReferencesOf("FireTrace.Engine"));
        Assert.Empty(ReferencesOf("FireTrace.ExternalData"));
    }

    [Fact]
    public void Core_uses_the_engine_and_the_external_data_projects()
    {
        Assert.Equal(new[] { "FireTrace.Engine", "FireTrace.ExternalData" }, ReferencesOf("FireTrace.Core"));
    }

    /// <summary>One class, record, interface or enum per file, named after it: finding a type never means searching.</summary>
    [Fact]
    public void Every_file_declares_exactly_one_top_level_type_named_like_the_file()
    {
        var declaration = new Regex(@"^(public |internal )?((sealed|abstract|static|readonly|partial) )*(class|record( struct)?|struct|interface|enum) (\w+)", RegexOptions.Multiline);
        var violations = new List<string>();
        foreach (var file in SourceTree.Projects.SelectMany(p => SourceTree.Files(p)).Where(f => Path.GetFileName(f) != "Program.cs"))
        {
            var types = declaration.Matches(File.ReadAllText(file)).Select(m => m.Groups[6].Value).ToList();
            if (types.Count != 1 || types[0] != Path.GetFileNameWithoutExtension(file)) violations.Add($"{SourceTree.Relative(file)}: {string.Join(", ", types)}");
        }
        Assert.Empty(violations);
    }
}
