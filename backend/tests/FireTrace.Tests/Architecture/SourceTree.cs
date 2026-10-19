using System.Text.RegularExpressions;

namespace FireTrace.Tests.Architecture;

/// <summary>The backend's own source code, as the architecture tests read it.</summary>
static class SourceTree
{
    public static readonly string Root = FindRoot();

    static string FindRoot()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d is not null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "FireTrace.sln"))) return d.FullName;
        throw new InvalidOperationException("FireTrace.sln not found from " + AppContext.BaseDirectory);
    }

    public static readonly string[] Projects = { "FireTrace.Engine", "FireTrace.ExternalData", "FireTrace.Core" };

    /// <summary>Every `.cs` file of a source project (or of one folder inside it), without build output.</summary>
    public static IEnumerable<string> Files(string project, string folder = "") =>
        Directory.GetFiles(Path.Combine(Root, "src", project, folder), "*.cs", SearchOption.AllDirectories).Where(f => !Regex.IsMatch(f, @"[\\/](obj|bin)[\\/]"));

    public static string Relative(string file) => Path.GetRelativePath(Root, file);
}
