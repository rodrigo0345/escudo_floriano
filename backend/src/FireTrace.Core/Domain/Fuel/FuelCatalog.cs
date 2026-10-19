namespace FireTrace.Core.Domain.Fuel;

/// <summary>As classes de vegetação configuradas, indexadas pelo id da grelha do mapa.</summary>
public sealed class FuelCatalog
{
    readonly FuelModel[] _models;

    public FuelCatalog(IEnumerable<FuelModel> models)
    {
        var list = models.OrderBy(m => m.Id).ToArray();
        if (list.Length == 0 || list[0].Id != 0 || list.Select((m, i) => m.Id == i).Contains(false)) throw new InvalidOperationException("FireTrace:Fuels tem de ter as classes 0..N seguidas.");
        _models = list;
    }

    public IReadOnlyList<FuelModel> All => _models;
    public int Count => _models.Length;
    public FuelModel Get(int id) => id >= 0 && id < _models.Length ? _models[id] : _models[0];
}
