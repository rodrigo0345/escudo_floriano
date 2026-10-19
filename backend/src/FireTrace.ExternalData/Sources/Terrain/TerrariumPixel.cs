namespace FireTrace.ExternalData.Sources.Terrain;

public static class TerrariumPixel
{
    /// <summary>Altitude em metros de um píxel Terrarium (R*256 + G + B/256 − 32768).</summary>
    public static float Elevation(byte r, byte g, byte b) => r * 256f + g + b / 256f - 32768f;
}
