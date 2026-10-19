namespace FireTrace.Engine.Contracts;

/// <summary>The engine could not be reached or failed to run a job.</summary>
public sealed class EngineUnavailableException(string message) : Exception(message);
