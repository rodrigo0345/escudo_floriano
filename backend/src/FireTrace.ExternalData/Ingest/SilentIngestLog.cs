namespace FireTrace.ExternalData.Ingest;

/// <summary>O registo por omissão: não escreve nada.</summary>
public sealed class SilentIngestLog : IIngestLog
{
    public void Info(string message) { }
    public void Warn(string message) { }
}
