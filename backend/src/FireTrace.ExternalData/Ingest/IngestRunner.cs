using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;

namespace FireTrace.ExternalData.Ingest;

/// <summary>Carrega um local: regista-o na base de dados e corre os passos escolhidos, pela ordem de <see cref="IIngestStep.Order"/>.</summary>
public sealed class IngestRunner(IEnumerable<IIngestStep> steps, IMapWriter writer, IIngestLog log)
{
    public IReadOnlyList<IIngestStep> Steps { get; } = steps.OrderBy(s => s.Order).ToList();

    /// <param name="location">O local a carregar.</param>
    /// <param name="only">Só estes passos (todos se vazio).</param>
    /// <param name="skip">Estes passos ficam de fora.</param>
    public async Task RunAsync(LocationDefinition location, IReadOnlySet<string> only, IReadOnlySet<string> skip)
    {
        await writer.UpsertLocationAsync(location);
        var ctx = new IngestContext(location);
        log.Info($"Local {location.Id}: {ctx.Spec.Width}x{ctx.Spec.Height} células de {ctx.Spec.CellM} m, bbox {ctx.Spec.Bounds}");
        foreach (var step in Steps.Where(s => (only.Count == 0 || only.Contains(s.Name)) && !skip.Contains(s.Name)))
        {
            log.Info($"{step.Name}…");
            await step.RunAsync(ctx);
        }
        log.Info("concluído.");
    }
}
