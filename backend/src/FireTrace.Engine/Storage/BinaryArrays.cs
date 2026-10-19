using System.Runtime.InteropServices;

namespace FireTrace.Engine.Storage;

/// <summary>Raw little-endian copies between primitive arrays and bytes: the one place the engine files and the run files get their binary layout.</summary>
public static class BinaryArrays
{
    public static byte[] ToBytes<T>(T[] values) where T : struct
    {
        var bytes = new byte[values.Length * Marshal.SizeOf<T>()];
        Buffer.BlockCopy(values, 0, bytes, 0, bytes.Length);
        return bytes;
    }

    public static T[] FromBytes<T>(byte[] bytes) where T : struct
    {
        var values = new T[bytes.Length / Marshal.SizeOf<T>()];
        Buffer.BlockCopy(bytes, 0, values, 0, values.Length * Marshal.SizeOf<T>());
        return values;
    }

    /// <summary>Minute-of-ignition grids are stored as Int16 (−1 = never burned), clamped to its range.</summary>
    public static byte[] PackMinutes(int[] minutes)
    {
        var bytes = new byte[minutes.Length * 2];
        for (int i = 0; i < minutes.Length; i++) BitConverter.TryWriteBytes(bytes.AsSpan(i * 2), (short)Math.Clamp(minutes[i], -1, short.MaxValue));
        return bytes;
    }

    public static int[] UnpackMinutes(byte[] bytes)
    {
        var minutes = new int[bytes.Length / 2];
        for (int i = 0; i < minutes.Length; i++) minutes[i] = BitConverter.ToInt16(bytes, i * 2);
        return minutes;
    }
}
