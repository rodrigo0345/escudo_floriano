using FireTrace.Engine.Contracts;
using FireTrace.Engine.Weather;

namespace FireTrace.Engine.Native;

/// <summary>
/// Minimum-travel-time (fast marching / Dijkstra) spread of one fire: expands the front cell by cell, always from the cell that burns earliest, so
/// each cell closes with its final arrival minute — the same idea as the level-set of ELMFIRE, along the shortest path instead of a PDE.
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

    /// <param name="moisture">One row per minute (dt = 60 s) of dead fuel moisture for this member's weather.</param>
    public FireResult Solve(FireJob job, MemberWeather member, IReadOnlyList<DeadFuelMoisture.Row> moisture)
    {
        var grid = job.Spec;
        int n = grid.CellCount, w = grid.Width, h = grid.Height;
        var arrival = new float[n];
        Array.Fill(arrival, float.MaxValue);
        var intensity = new ushort[n];
        var flags = new byte[n];
        double MoistureAt(int minute) => moisture[Math.Clamp(minute, 0, moisture.Count - 1)].M1;

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
        while (frontier.TryDequeue(out int c, out float t))
        {
            if (closed[c]) continue;
            closed[c] = true;
            if (t > job.Minutes) continue;
            int x = c % w, y = c / w;
            var (windKmh, windFromDeg) = WindAt(member, job, x, y, t);
            double windFactor = model.WindFactor(windKmh), lb = model.EllipseRatio(windKmh);

            // a própria célula: intensidade, humidade (a face da encosta já conta) e se está em fogo de copas — calculado antes de expandir,
            // porque o copado a arder em c é o que acelera a entrada em `nc` a seguir (o fogo de copas propaga-se bem mais depressa que o de
            // superfície: menos abrigado do vento, combustível fino e contínuo no dossel).
            double moistureHere = model.MoistureFactor(MoistureAt((int)t), bands, n, c);
            double rosHere = model.BaseRos(bands, n, c) * model.ReferenceRosMPerMin * model.WindAtSurface(bands, n, c, windFactor) * moistureHere * adjustment[c];
            double intensityHere = model.FirelineIntensity(bands, n, c, rosHere);
            intensity[c] = (ushort)Math.Clamp(intensityHere, 0, ushort.MaxValue);
            bool crownHere = model.IsCrownFire(bands, n, c, intensityHere);
            if (crownHere) flags[c] = 1;
            double crownBoost = crownHere ? model.CrownFireBoost(bands, n, c) : 1;

            foreach (var (dx, dy, distCells) in Directions)
            {
                int nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                int nc = ny * w + nx;
                if (closed[nc]) continue;
                // a velocidade de entrar em `nc` depende do que está em `nc` (combustível, dossel, humidade pela face da encosta, barreiras/
                // riparian já no ajuste) — uma fonte rápida ao lado de uma faixa cortada ou de um rio não "empurra" o fogo para lá a essa
                // velocidade; é a célula de destino que decide se arde. `crownBoost` (de c, a fonte) acelera só se c já estiver em copas.
                double moistureFactor = model.MoistureFactor(MoistureAt((int)t), bands, n, nc);
                double ros0 = model.BaseRos(bands, n, nc) * model.ReferenceRosMPerMin * model.WindAtSurface(bands, n, nc, windFactor) * moistureFactor * adjustment[nc] * crownBoost;
                // firefighters (and drops, and finished lines) slow the fire only while they are working where it is entering, and direct attack fades with the flame intensity at the source cell
                ros0 *= suppression.Factor(nc, t, intensityHere);
                if (ros0 <= 1e-6) continue;
                double bearing = Math.Atan2(dx, -dy) * 180 / Math.PI; // direção desta ligação (0 = norte)
                double ros = ros0 * FireBehaviorModel.EllipseFactor(bearing, windFromDeg, lb) * model.SlopeFactor(bands, n, nc, bearing);
                if (ros <= 1e-6) continue;
                float arrive = t + (float)(distCells * grid.CellM / ros);
                if (arrive < arrival[nc]) { arrival[nc] = arrive; frontier.Enqueue(nc, arrive); }
            }
        }

        var ignitionMinutes = new int[n];
        for (int c = 0; c < n; c++) ignitionMinutes[c] = arrival[c] <= job.Minutes ? (int)Math.Round(arrival[c]) : -1;
        return new FireResult { Ignition = ignitionMinutes, IntensityKwm = intensity, Flags = flags };
    }

    /// <summary>O vento no minuto `t`: o campo convectivo do membro (já inclui o que o fogo induz), se houver, senão o vento ambiente.</summary>
    static (double WindKmh, double WindFromDeg) WindAt(MemberWeather member, FireJob job, int x, int y, float t)
    {
        if (member.Wind is { } field)
        {
            int bx = Math.Clamp((int)(x * job.Spec.CellM / field.CellM), 0, field.Cols - 1), by = Math.Clamp((int)(y * job.Spec.CellM / field.CellM), 0, field.Rows - 1);
            int i = by * field.Cols + bx;
            return (field.SpeedKmh[i], field.FromDeg[i]);
        }
        var weather = member.Weather.At(t);
        return (weather.WindKmh, weather.WindFromDeg);
    }
}
