using FireTrace.Engine.Contracts;
using FireTrace.Engine.Weather;

namespace FireTrace.Engine.Native;

/// <summary>
/// Minimum-travel-time (fast marching / Dijkstra) spread of one fire: expands the front cell by cell, always from the cell that burns earliest, so
/// each cell closes with its final arrival minute — the same idea as the level-set of ELMFIRE, along the shortest path instead of a PDE.
/// The rate of each step comes from <see cref="FireBehaviorModel"/>: Rothermel in the destination cell, shaped by the ellipse of its wind and slope.
/// Pure: the same job and member always give the same result.
/// </summary>
public sealed class MinimumTravelTimeSolver(FireBehaviorModel model)
{
    /// <summary>
    /// Vizinhança a 8 direções (não 16: um salto mais largo, tipo cavalo do xadrez, passaria por cima de uma barreira com 1 célula de
    /// largura — rio, estrada, faixa cortada — sem nunca "pisar" a célula bloqueada entre as duas; 8 direções garantem que isso não acontece).
    /// </summary>
    static readonly (int Dx, int Dy, double Dist)[] Directions =
    {
        (1, 0, 1), (1, 1, 1.41421356), (0, 1, 1), (-1, 1, 1.41421356), (-1, 0, 1), (-1, -1, 1.41421356), (0, -1, 1), (1, -1, 1.41421356),
    };

    /// <param name="moisture">One row per minute (dt = 60 s) of dead and live fuel moisture for this member's weather.</param>
    public FireResult Solve(FireJob job, MemberWeather member, IReadOnlyList<DeadFuelMoisture.Row> moisture)
    {
        var grid = job.Spec;
        int n = grid.CellCount, w = grid.Width, h = grid.Height;
        var arrival = new float[n];
        Array.Fill(arrival, float.MaxValue);
        var intensity = new ushort[n];
        var flags = new byte[n];

        var frontier = new PriorityQueue<int, float>();
        if (job.BurnedAtStart is { } burned)
            for (int c = 0; c < n; c++)
                if (burned[c]) { arrival[c] = 0; frontier.Enqueue(c, 0); }
        foreach (var ignition in job.Ignitions)
        {
            int c = grid.Index(Math.Clamp(ignition.X, 0, w - 1), Math.Clamp(ignition.Y, 0, h - 1));
            float t = ignition.StartSeconds / 60f;
            if (t < arrival[c]) { arrival[c] = t; frontier.Enqueue(c, t); }
        }

        var suppression = SuppressionIndex.Of(job.Suppression, n);
        var closed = new bool[n];
        var adjustment = member.Adjustment ?? job.Adjustment; // o ajuste do membro já tem as barreiras galgadas pelo seu vento (ver BarrierSet)
        var bands = job.Landscape;
        double foliar = job.FuelMoisture?.Values?.FoliarPct ?? model.DefaultFoliarMoisturePct;

        // The weather and the moisture change slowly; a cell is recomputed at most once per bucket instead of once per incoming edge.
        var cache = new CellBehavior[n];
        var cacheBucket = new int[n];
        Array.Fill(cacheBucket, int.MinValue);
        int bucketMinutes = Math.Max(1, model.BehaviorBucketMinutes);

        CellBehavior At(int cell, int minute)
        {
            int bucket = minute / bucketMinutes;
            if (cacheBucket[cell] == bucket) return cache[cell];
            int m = Math.Clamp(minute, 0, moisture.Count - 1);
            var row = moisture[m];
            var wx = member.Weather.At(m);
            double windKmh = wx.WindKmh, fromDeg = wx.WindFromDeg;
            if (member.Wind is { } field)
            {
                int bx = Math.Clamp((int)((cell % w) * grid.CellM / field.CellM), 0, field.Cols - 1);
                int by = Math.Clamp((int)((cell / w) * grid.CellM / field.CellM), 0, field.Rows - 1);
                int i = by * field.Cols + bx;
                windKmh = field.SpeedKmh[i];
                fromDeg = field.FromDeg[i];
            }
            var behavior = model.Of(bands, n, cell, row, windKmh, fromDeg, wx.GustKmh, wx.PrecipitationMmH, foliar);
            cache[cell] = behavior;
            cacheBucket[cell] = bucket;
            return behavior;
        }

        while (frontier.TryDequeue(out int c, out float t))
        {
            if (closed[c]) continue;
            closed[c] = true;
            if (t > job.Minutes) continue;
            int x = c % w, y = c / w;
            int minute = Math.Clamp((int)t, 0, moisture.Count - 1);

            var here = At(c, minute);
            intensity[c] = (ushort)Math.Clamp(here.IntensityKwm, 0, ushort.MaxValue);
            if (here.Crown) flags[c] = 1;
            if (here.MaxRosMPerMin <= 1e-9) continue; // non-burnable or fully suppressed: nothing leaves this cell

            foreach (var (dx, dy, distCells) in Directions)
            {
                int nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                int nc = ny * w + nx;
                if (closed[nc]) continue;

                // The destination's own fuel, canopy, slope and moisture decide whether and how fast it burns; the source only supplies the flame intensity
                // that direct attack has to face. `crown` is already inside the destination's rate, so a crown fire enters a canopy at the crown rate.
                var dest = At(nc, minute);
                if (dest.MaxRosMPerMin <= 1e-9) continue;
                double bearing = Math.Atan2(dx, -dy) * 180 / Math.PI; // direção desta ligação (0 = norte)
                double ros = dest.MaxRosMPerMin * FireBehaviorModel.EllipseFactor(bearing, dest.DirectionDeg, dest.LengthToWidth) * adjustment[nc];
                ros *= suppression.Factor(nc, t, here.IntensityKwm);
                if (ros <= 1e-9) continue;
                float arrive = t + (float)(distCells * grid.CellM / ros);
                if (arrive <= job.Minutes && arrive < arrival[nc]) { arrival[nc] = arrive; frontier.Enqueue(nc, arrive); }
            }
        }

        var ignitionMinutes = new int[n];
        for (int c = 0; c < n; c++) ignitionMinutes[c] = arrival[c] <= job.Minutes ? (int)Math.Round(arrival[c]) : -1;
        return new FireResult { Ignition = ignitionMinutes, IntensityKwm = intensity, Flags = flags };
    }
}
