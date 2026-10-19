namespace FireTrace.Engine.Contracts;

/// <summary>The raster every engine input and output is laid out on: `Width` x `Height` cells of `CellM` metres, row 0 = north.</summary>
public sealed record EngineGrid(int Width, int Height, double CellM)
{
    public int CellCount => Width * Height;

    public int Index(int x, int y) => y * Width + x;
}
