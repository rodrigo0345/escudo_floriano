namespace FireTrace.ExternalData.Map;

public sealed record GridBlob(int Width, int Height, double CellM, string DType, byte[] Data);
