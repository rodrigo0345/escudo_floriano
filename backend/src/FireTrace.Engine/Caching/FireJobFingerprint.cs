using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using FireTrace.Engine.Contracts;
using FireTrace.Engine.Weather;

namespace FireTrace.Engine.Caching;

/// <summary>
/// A stable hash of everything that decides a job's result (landscape, adjustments, ignitions, weather per member, options), so the same job is recognised
/// and its result reused. The progress callback is not part of the job's identity. `scope` names the engine and its settings: another engine, another key.
/// </summary>
public static class FireJobFingerprint
{
    public static string Of(FireJob job, string scope)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Text(hash, scope);
        Number(hash, job.Spec.Width); Number(hash, job.Spec.Height); Number(hash, job.Spec.CellM);
        Bytes(hash, MemoryMarshal.AsBytes<short>(job.Landscape));
        Bytes(hash, MemoryMarshal.AsBytes<float>(job.Adjustment));
        foreach (var ignition in job.Ignitions) { Number(hash, ignition.X); Number(hash, ignition.Y); Number(hash, ignition.StartSeconds); }
        Number(hash, job.Minutes); Number(hash, job.SpinUpMinutes); Number(hash, job.Spotting ? 1 : 0);
        if (job.BurnedAtStart is { } burned) foreach (var cell in burned) Number(hash, cell ? 1 : 0);
        Moisture(hash, job.FuelMoisture);
        Suppression(hash, job.Suppression);
        foreach (var member in job.Members) Member(hash, member);
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    static void Member(IncrementalHash hash, MemberWeather member)
    {
        Text(hash, member.Name);
        foreach (var p in member.Weather.Points) { Number(hash, p.Minute); Number(hash, p.WindKmh); Number(hash, p.WindFromDeg); Number(hash, p.HumidityPct); Number(hash, p.TempC); Number(hash, p.GustKmh); Number(hash, p.PrecipitationMmH); Number(hash, p.CloudCoverPct); Number(hash, p.SolarRadiationWm2); }
        Number(hash, member.Weather.WindScale); Number(hash, member.Weather.DirOffsetDeg); Number(hash, member.Weather.MoistScale);
        if (member.Adjustment is { } adjustment) Bytes(hash, MemoryMarshal.AsBytes<float>(adjustment));
        if (member.Wind is { } wind)
        {
            Number(hash, wind.Cols); Number(hash, wind.Rows); Number(hash, wind.CellM);
            Bytes(hash, MemoryMarshal.AsBytes<float>(wind.SpeedKmh));
            Bytes(hash, MemoryMarshal.AsBytes<float>(wind.FromDeg));
        }
    }

    static void Suppression(IncrementalHash hash, SuppressionPlan? plan)
    {
        if (plan is null) return;
        Number(hash, plan.FullKwm); Number(hash, plan.NoneKwm); Number(hash, plan.MinFactor);
        foreach (var w in plan.Windows) { Bytes(hash, MemoryMarshal.AsBytes<int>(w.Cells)); Number(hash, w.FromMinute); Number(hash, w.UntilMinute); Number(hash, w.Effectiveness); Number(hash, w.Direct ? 1 : 0); }
    }

    static void Moisture(IncrementalHash hash, FuelMoistureSpec? spec)
    {
        if (spec is null) return;
        Text(hash, spec.Mode);
        Number(hash, spec.DeadBiasPct ?? double.NaN);
        var v = spec.Values;
        if (v is null) return;
        foreach (var value in new[] { v.Dead1hPct, v.Dead10hPct, v.Dead100hPct, v.LiveHerbaceousPct, v.LiveWoodyPct, v.FoliarPct }) Number(hash, value ?? double.NaN);
    }

    static void Text(IncrementalHash hash, string value) => Bytes(hash, Encoding.UTF8.GetBytes(value + "\0"));
    static void Number(IncrementalHash hash, double value) => Bytes(hash, BitConverter.GetBytes(value));
    static void Bytes(IncrementalHash hash, ReadOnlySpan<byte> bytes) => hash.AppendData(bytes);
}
