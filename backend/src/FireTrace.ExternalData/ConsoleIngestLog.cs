using FireTrace.ExternalData.Ingest;

namespace FireTrace.ExternalData;

/// <summary>O registo do CLI `ingest`: escreve na consola. Só o arranque do CLI o usa.</summary>
public sealed class ConsoleIngestLog : IIngestLog
{
    public void Info(string message) => Console.WriteLine(message);

    public void Warn(string message) => Console.WriteLine(message);
}
