using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Routing;

/// <summary>
/// O declive (%) de cada troço <b>ao longo da via</b>: a subida entre células afastadas de uma janela, em média ao longo do troço (um pico isolado do modelo de terreno não corta a estrada). Não é o declive do terreno em cada célula
/// (uma estrada segue as curvas de nível, por isso esse declive exagera): é o que a viatura sente a subir.
/// </summary>
public static class RoadSlopes
{
    const int Window = 4;

    public static double[] Of(RoadNetwork net, TerrainGrids terrain) => net.Edges.Select(e => Of(e.CellIdx, net.Spec, terrain.Elevation)).ToArray();

    static double Of(int[] cells, GridSpec spec, float[] elevation)
    {
        double sum = 0; int n = 0;
        for (int i = 0; i + 1 < cells.Length; i++)
        {
            int j = Math.Min(cells.Length - 1, i + Window);
            double run = Math.Sqrt(Math.Pow(cells[j] % spec.Width - cells[i] % spec.Width, 2) + Math.Pow(cells[j] / spec.Width - cells[i] / spec.Width, 2)) * spec.CellM;
            if (run > 0) { sum += Math.Abs(elevation[cells[j]] - elevation[cells[i]]) / run * 100; n++; }
        }
        return n == 0 ? 0 : sum / n;
    }
}
