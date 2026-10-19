using System.Runtime.InteropServices;

namespace FireTrace.ExternalData.Map;

/// <summary>Conversão das grelhas para os bytes que se guardam na base de dados (e de volta), em ordem de memória.</summary>
internal static class GridBytes
{
    public static byte[] Of<T>(T[] values) where T : unmanaged => MemoryMarshal.AsBytes(values.AsSpan()).ToArray();

    public static float[] ToFloats(byte[] bytes) => MemoryMarshal.Cast<byte, float>(bytes.AsSpan(0, bytes.Length / 4 * 4)).ToArray();
}
