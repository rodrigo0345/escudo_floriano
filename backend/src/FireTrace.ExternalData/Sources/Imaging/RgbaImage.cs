using SkiaSharp;

namespace FireTrace.ExternalData.Sources.Imaging;

/// <summary>Uma imagem descodificada: 4 bytes por píxel (R, G, B, A), linha a linha.</summary>
public sealed record RgbaImage(int Width, int Height, byte[] Pixels)
{
    public static RgbaImage Decode(byte[] encoded, string invalidMessage = "Resposta não é uma imagem")
    {
        using var decoded = SKBitmap.Decode(encoded) ?? throw new IOException(invalidMessage);
        using var rgba = decoded.Copy(SKColorType.Rgba8888);
        return new RgbaImage(rgba.Width, rgba.Height, rgba.GetPixelSpan().ToArray());
    }
}
