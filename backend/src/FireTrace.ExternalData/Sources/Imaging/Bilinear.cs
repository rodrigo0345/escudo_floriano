namespace FireTrace.ExternalData.Sources.Imaging;

/// <summary>Interpolação bilinear entre os quatro valores à volta de (ix + fx, iy + fy) de uma grelha com <c>channels</c> valores por píxel.</summary>
public static class Bilinear
{
    public static double Sample(byte[] data, int width, int channels, int ix, int iy, double fx, double fy, int channel) =>
        data[(iy * width + ix) * channels + channel] * (1 - fx) * (1 - fy) + data[(iy * width + ix + 1) * channels + channel] * fx * (1 - fy)
        + data[((iy + 1) * width + ix) * channels + channel] * (1 - fx) * fy + data[((iy + 1) * width + ix + 1) * channels + channel] * fx * fy;

    public static double Sample(float[] data, int width, int ix, int iy, double fx, double fy) =>
        data[iy * width + ix] * (1 - fx) * (1 - fy) + data[iy * width + ix + 1] * fx * (1 - fy)
        + data[(iy + 1) * width + ix] * (1 - fx) * fy + data[(iy + 1) * width + ix + 1] * fx * fy;
}
