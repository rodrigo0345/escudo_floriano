using SkiaSharp;

namespace FireTrace.ExternalData.Map;

public static class HeightmapPng
{
    /// <summary>Terrarium RGB (R*256+G+B/256−32768): PNG sem perdas que o cliente descodifica num canvas.</summary>
    public static byte[] Encode(RenderHeightmap h)
    {
        using var bmp = new SKBitmap(new SKImageInfo(h.Spec.Width, h.Spec.Height, SKColorType.Rgba8888, SKAlphaType.Opaque));
        var px = new byte[h.Elevation.Length * 4];
        for (int i = 0; i < h.Elevation.Length; i++)
        {
            double v = Math.Clamp(h.Elevation[i] + 32768.0, 0, 65535.99);
            px[i * 4] = (byte)Math.Floor(v / 256); px[i * 4 + 1] = (byte)Math.Floor(v % 256);
            px[i * 4 + 2] = (byte)Math.Floor((v - Math.Floor(v)) * 256); px[i * 4 + 3] = 255;
        }
        System.Runtime.InteropServices.Marshal.Copy(px, 0, bmp.GetPixels(), px.Length);
        using var data = SKImage.FromBitmap(bmp).Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }
}
