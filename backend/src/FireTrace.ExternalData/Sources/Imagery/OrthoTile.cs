namespace FireTrace.ExternalData.Sources.Imagery;

/// <summary>Um bloco JPEG do mosaico de ortofotos: a posição (coluna, linha) e o ficheiro gravado.</summary>
public sealed record OrthoTile(int Tx, int Ty, string Path);
