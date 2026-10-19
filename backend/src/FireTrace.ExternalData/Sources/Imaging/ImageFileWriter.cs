using System.Runtime.InteropServices;
using SkiaSharp;

namespace FireTrace.ExternalData.Sources.Imaging;

/// <summary>Grava píxeis RGBA como JPEG ou PNG num ficheiro (cria a pasta se for preciso).</summary>
public sealed class ImageFileWriter
{
    public void SaveJpeg(byte[] rgba, int width, int height, int quality, string path) => Save(rgba, width, height, SKEncodedImageFormat.Jpeg, quality, path);

    /// <summary>PNG sem perdas.</summary>
    public void SavePng(byte[] rgba, int width, int height, string path) => Save(rgba, width, height, SKEncodedImageFormat.Png, 100, path);

    static void Save(byte[] rgba, int width, int height, SKEncodedImageFormat format, int quality, string path)
    {
        using var bitmap = new SKBitmap(new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Opaque));
        Marshal.Copy(rgba, 0, bitmap.GetPixels(), rgba.Length);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using var data = SKImage.FromBitmap(bitmap).Encode(format, quality);
        using var file = File.Create(path);
        data.SaveTo(file);
    }
}
