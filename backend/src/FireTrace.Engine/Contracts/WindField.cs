namespace FireTrace.Engine.Contracts;

/// <summary>
/// O vento por bloco de terreno e por intervalo meteorológico (km/h e rumo de onde sopra), em vez de um só valor para o local todo.
/// Os valores estão em [intervalo][linha][coluna], linha 0 = norte.
/// </summary>
public sealed record WindField(int Cols, int Rows, double CellM, float[] SpeedKmh, float[] FromDeg);
