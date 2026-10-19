namespace FireTrace.ExternalData.Map;

/// <summary>Troço entre dois cruzamentos. `Pts` = x,y alternados em coordenadas de célula; `OffRoad` = caminho florestal (só viaturas todo-o-terreno).</summary>
public sealed record RoadEdge(int Id, string Name, string Ref, string Highway, string A, string B, double[] Pts, int[] CellIdx, double LengthCells,
    bool OffRoad = false, string? TrackType = null, double? WidthM = null);
