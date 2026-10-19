using System.Text.RegularExpressions;

namespace FireTrace.Tests.Architecture;

/// <summary>Who may know whom. Inside Core: Domain ← Models ← Repositories/Services ← Controllers; across projects only Core looks at the others.</summary>
public class LayerRulesTests
{
    static IEnumerable<string> Violations(string project, string folder, params string[] forbiddenNamespaces) =>
        from file in SourceTree.Files(project, folder)
        let text = File.ReadAllText(file)
        from ns in forbiddenNamespaces
        where Regex.IsMatch(text, $@"\b{Regex.Escape(ns)}\b(?!\w)")
        select $"{SourceTree.Relative(file)} uses {ns}";

    [Theory]
    [InlineData("Domain", "FireTrace.Core.Models", "FireTrace.Core.Repositories", "FireTrace.Core.Services", "FireTrace.Core.Controllers", "FireTrace.Core.Hosting", "FireTrace.Core.Middleware")]
    [InlineData("Models", "FireTrace.Core.Repositories", "FireTrace.Core.Services", "FireTrace.Core.Controllers", "FireTrace.Core.Hosting", "FireTrace.Core.Middleware")]
    [InlineData("Repositories", "FireTrace.Core.Services", "FireTrace.Core.Controllers", "FireTrace.Core.Hosting", "FireTrace.Core.Middleware")]
    [InlineData("Services", "FireTrace.Core.Controllers", "FireTrace.Core.Hosting", "FireTrace.Core.Middleware")]
    public void Core_layers_only_depend_inwards(string folder, params string[] forbidden) =>
        Assert.Empty(Violations("FireTrace.Core", folder, forbidden));

    [Theory]
    [InlineData("FireTrace.Engine")]
    [InlineData("FireTrace.ExternalData")]
    public void The_engine_and_the_external_data_know_nothing_about_core(string project) =>
        Assert.Empty(Violations(project, "", "FireTrace.Core"));

    [Fact]
    public void The_engine_and_the_external_data_do_not_know_each_other()
    {
        Assert.Empty(Violations("FireTrace.Engine", "", "FireTrace.ExternalData"));
        Assert.Empty(Violations("FireTrace.ExternalData", "", "FireTrace.Engine"));
    }

    [Fact]
    public void Controllers_hold_no_logic_they_only_call_services()
    {
        var violations = from file in SourceTree.Files("FireTrace.Core", "Controllers")
                         from line in File.ReadLines(file)
                         where Regex.IsMatch(line, @"\bIDocumentStore<|\bNpgsql|\bIMapReader\b|\bIFireEngine\b")
                         select $"{SourceTree.Relative(file)}: {line.Trim()}";
        Assert.Empty(violations);
    }
}
