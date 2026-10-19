namespace FireTrace.Engine;

/// <summary>
/// Where the engine keeps things on disk and what it talks to. The host decides all of it (from its own configuration and environment),
/// so nothing in this project reads environment variables.
/// </summary>
/// <param name="JobsDir">Folder shared with the ELMFIRE container (inputs and outputs of each job).</param>
/// <param name="RunsDir">Finished simulations by id.</param>
/// <param name="CacheDir">Engine results by job fingerprint, so an identical job is never simulated twice.</param>
/// <param name="ElmfireUrl">Address of the ELMFIRE service (used only when the provider is `elmfire`).</param>
/// <param name="Workers">How many ensemble members the native engine runs in parallel.</param>
public sealed record EnginePaths(string JobsDir, string RunsDir, string CacheDir, string ElmfireUrl, int Workers);
