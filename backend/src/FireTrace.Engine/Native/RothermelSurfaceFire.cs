using FireTrace.Engine.Weather;

namespace FireTrace.Engine.Native;

/// <summary>
/// Rothermel (1972) surface fire spread, with the Albini (1976) weighting by size class and the Behave-style combination of wind and slope vectors.
/// This is the same physics ELMFIRE runs, written as a pure function of the fuel model, the dead/live moisture and the midflame wind so the native engine
/// can be checked against the published equations. Everything inside is in Rothermel's US units (lb, ft, Btu, min); the public result is SI.
/// </summary>
public static class RothermelSurfaceFire
{
    const double ParticleDensityLbFt3 = 32.0;
    const double TotalMineralContent = 0.0555;
    const double EffectiveMineralContent = 0.01;
    const double FtMinToMMin = 0.3048;
    const double BtuFtSToKwm = 3.4615;
    const double DegreesToRadians = Math.PI / 180.0;

    /// <summary>
    /// The no-wind and maximum spread of one fuel bed. Moistures are fractions (0.06 = 6 %), wind is the midflame wind in ft/min, slope is rise/run,
    /// and the two directions are azimuths (0 = north): where the wind blows <b>to</b> and where the slope rises <b>to</b>.
    /// </summary>
    public static SurfaceFireBehavior Compute(FuelModelParameters fuel, double m1, double m10, double m100, double liveHerb, double liveWoody,
        double midflameWindFtMin, double slopeTan, double windToDeg, double upslopeDeg, double maxLengthToWidth = 8.0)
    {
        if (!fuel.Burnable || fuel.DepthFt <= 0 || fuel.Sav1h <= 0) return SurfaceFireBehavior.None;

        // ---------------------------------------------------------------- fuel bed: six classes, the live herbaceous one split when the model is dynamic
        var w = new double[6];
        var sigma = new double[6];
        var mf = new double[6];
        if (fuel.Dynamic)
        {
            // Albini/Pyretechnics: at 90 % live moisture the herbaceous fuel is fully green; below that it cures into the dead 1 h class.
            double green = Math.Clamp(liveHerb / 0.9 - 1.0 / 3.0, 0, 1), cured = 1 - green;
            w[0] = fuel.Load1h; w[1] = fuel.Load10h; w[2] = fuel.Load100h;
            w[3] = fuel.LoadLiveHerb * cured; w[4] = fuel.LoadLiveHerb * green; w[5] = fuel.LoadLiveWoody;
            sigma[0] = fuel.Sav1h; sigma[1] = fuel.Sav10h; sigma[2] = fuel.Sav100h;
            sigma[3] = fuel.SavLiveHerb; sigma[4] = fuel.SavLiveHerb; sigma[5] = fuel.SavLiveWoody;
            mf[0] = m1; mf[1] = m10; mf[2] = m100; mf[3] = m1; mf[4] = liveHerb; mf[5] = liveWoody;
        }
        else
        {
            w[0] = fuel.Load1h; w[1] = fuel.Load10h; w[2] = fuel.Load100h;
            w[3] = 0; w[4] = fuel.LoadLiveHerb; w[5] = fuel.LoadLiveWoody;
            sigma[0] = fuel.Sav1h; sigma[1] = fuel.Sav10h; sigma[2] = fuel.Sav100h;
            sigma[3] = fuel.SavLiveHerb; sigma[4] = fuel.SavLiveHerb; sigma[5] = fuel.SavLiveWoody;
            mf[0] = m1; mf[1] = m10; mf[2] = m100; mf[3] = m1; mf[4] = liveHerb; mf[5] = liveWoody;
        }

        double totalLoad = w[0] + w[1] + w[2] + w[3] + w[4] + w[5];
        if (totalLoad <= 1e-9) return SurfaceFireBehavior.None;

        // Live moisture of extinction: Rothermel eq. 88 as adjusted by Albini (1976), so the live fuel damping depends on how much dead fuel there is.
        double deadLoadingFactor = 0, liveLoadingFactor = 0, deadMoistureFactor = 0;
        for (int i = 0; i < 6; i++)
        {
            if (sigma[i] <= 0) continue;
            double factor = w[i] * Math.Exp(-138.0 / sigma[i]);
            if (i < 4) { deadLoadingFactor += factor; deadMoistureFactor += mf[i] * factor; }
            else liveLoadingFactor += factor;
        }
        double mxDead = fuel.MoistureOfExtinctionPct / 100.0;
        double mxLive = mxDead;
        if (deadLoadingFactor > 1e-9 && liveLoadingFactor > 1e-9)
        {
            double deadMoisture = deadMoistureFactor / deadLoadingFactor;
            double ratio = deadLoadingFactor / liveLoadingFactor;
            mxLive = Math.Max(mxDead, 2.9 * ratio * (1 - deadMoisture / mxDead) - 0.226);
        }
        var mx = new[] { mxDead, mxDead, mxDead, mxDead, mxLive, mxLive };

        // ---------------------------------------------------------------- size-class weighting f_ij, category weighting f_i and Albini's g_ij
        var area = new double[6];
        for (int i = 0; i < 6; i++) area[i] = sigma[i] > 0 ? sigma[i] * w[i] / ParticleDensityLbFt3 : 0;
        double areaDead = area[0] + area[1] + area[2] + area[3], areaLive = area[4] + area[5], areaTotal = areaDead + areaLive;
        if (areaTotal <= 1e-12) return SurfaceFireBehavior.None;

        var fij = new double[6];
        for (int i = 0; i < 4; i++) fij[i] = areaDead > 0 ? area[i] / areaDead : 0;
        for (int i = 4; i < 6; i++) fij[i] = areaLive > 0 ? area[i] / areaLive : 0;
        double fDead = areaDead / areaTotal, fLive = areaLive / areaTotal;

        var sizeClass = new int[6];
        for (int i = 0; i < 6; i++) sizeClass[i] = SizeClass(sigma[i]);
        var gij = new double[6];
        for (int i = 0; i < 6; i++)
        {
            double sum = 0;
            for (int j = 0; j < 6; j++)
                if ((j < 4) == (i < 4) && sizeClass[j] == sizeClass[i]) sum += fij[j];
            gij[i] = sum;
        }

        double sigmaPrime = fDead * Weighted(fij, sigma, 0, 4) + fLive * Weighted(fij, sigma, 4, 6);
        if (sigmaPrime <= 0) return SurfaceFireBehavior.None;

        double beta = totalLoad / ParticleDensityLbFt3 / fuel.DepthFt;
        double betaOpt = 3.348 * Math.Pow(sigmaPrime, -0.8189);
        if (betaOpt <= 0 || beta <= 0) return SurfaceFireBehavior.None;

        // ---------------------------------------------------------------- reaction intensity (Btu/ft²/min)
        double etaS = 0.174 * Math.Pow(EffectiveMineralContent, -0.19);
        double heatPerArea = 0;
        for (int category = 0; category < 2; category++)
        {
            int from = category == 0 ? 0 : 4, to = category == 0 ? 4 : 6;
            double mfCat = Weighted(fij, mf, from, to);
            double mxCat = Weighted(fij, mx, from, to);
            double etaM = MoistureDamping(mfCat, mxCat);
            double netLoad = 0;
            for (int i = from; i < to; i++) netLoad += gij[i] * w[i] * (1 - TotalMineralContent);
            heatPerArea += netLoad * fuel.HeatContentBtuLb * etaM * etaS;
        }
        double reactionIntensity = heatPerArea * OptimumReactionVelocity(sigmaPrime, beta, betaOpt);
        if (reactionIntensity <= 0 || !double.IsFinite(reactionIntensity)) return SurfaceFireBehavior.None;

        // ---------------------------------------------------------------- heat source, heat sink and the no-wind/no-slope spread rate
        double xi = Math.Exp((0.792 + 0.681 * Math.Sqrt(sigmaPrime)) * (beta + 0.1)) / (192.0 + 0.2595 * sigmaPrime);
        double rhoB = totalLoad / fuel.DepthFt;
        double heatSink = 0;
        for (int category = 0; category < 2; category++)
        {
            int from = category == 0 ? 0 : 4, to = category == 0 ? 4 : 6;
            double fCat = category == 0 ? fDead : fLive, sink = 0;
            for (int i = from; i < to; i++)
            {
                if (sigma[i] <= 0) continue;
                double epsilon = Math.Exp((category == 0 ? -138.0 : -500.0) / sigma[i]);
                double qIg = mf[i] > 0 ? 250.0 + 1116.0 * mf[i] : 0;
                sink += fij[i] * epsilon * qIg;
            }
            heatSink += fCat * sink;
        }
        heatSink *= rhoB;
        if (heatSink <= 0 || !double.IsFinite(heatSink)) return SurfaceFireBehavior.None;

        double r0 = reactionIntensity * xi / heatSink; // ft/min
        double residenceTime = 384.0 / sigmaPrime;      // min
        double flameDepth = r0 * residenceTime;         // ft
        double baseIntensity = reactionIntensity * flameDepth / 60.0; // Btu/ft/s

        // ---------------------------------------------------------------- wind and slope factors and their vector sum
        double b = 0.02526 * Math.Pow(sigmaPrime, 0.54);
        double c = 7.47 * Math.Exp(-0.133 * Math.Pow(sigmaPrime, 0.55));
        double e = 0.715 * Math.Exp(-3.59e-4 * sigmaPrime);
        double f = Math.Pow(beta / betaOpt, e);
        if (c <= 0 || f <= 0 || b <= 0) return new SurfaceFireBehavior(r0 * FtMinToMMin, r0 * FtMinToMMin, 0, 1, baseIntensity * BtuFtSToKwm, 0, FlameLength(baseIntensity * BtuFtSToKwm));

        double wind = Math.Max(0, midflameWindFtMin);
        double phiWind = c / f * Math.Pow(wind, b);
        double phiSlope = slopeTan > 0 ? 5.275 * Math.Pow(beta, -0.3) * slopeTan * slopeTan : 0;

        double windRad = windToDeg * DegreesToRadians, slopeRad = upslopeDeg * DegreesToRadians;
        double vx = phiWind * Math.Sin(windRad) + phiSlope * Math.Sin(slopeRad);
        double vy = phiWind * Math.Cos(windRad) + phiSlope * Math.Cos(slopeRad);
        double phi = Math.Sqrt(vx * vx + vy * vy);

        // Rothermel's effective wind is capped by 0.9 × reaction intensity; above that the model is outside its calibration.
        double maxWind = 0.9 * reactionIntensity;
        double effectiveWind = phi > 0 ? Math.Pow(phi * f / c, 1.0 / b) : 0;
        if (maxWind > 0 && effectiveWind > maxWind)
        {
            effectiveWind = maxWind;
            phi = c / f * Math.Pow(effectiveWind, b);
        }
        if (!double.IsFinite(phi) || phi < 0) phi = 0;

        double ros = r0 * (1 + phi);
        // If there is no wind and no slope the direction is undefined; north keeps the result deterministic.
        double direction = phi > 1e-9 ? Angles.Normalize(Math.Atan2(vx, vy) * 180 / Math.PI)
            : phiSlope > 1e-9 ? Angles.Normalize(upslopeDeg) : 0;
        double intensity = baseIntensity * (1 + phi) * BtuFtSToKwm;
        double lw = LengthToWidth(effectiveWind * FtMinToMMin, maxLengthToWidth);

        return new SurfaceFireBehavior(r0 * FtMinToMMin, ros * FtMinToMMin, direction, lw, intensity, effectiveWind * FtMinToMMin, FlameLength(intensity));
    }

    static double Weighted(double[] weights, double[] values, int from, int to)
    {
        double sum = 0;
        for (int i = from; i < to; i++) sum += weights[i] * values[i];
        return sum;
    }

    static double MoistureDamping(double mf, double mx)
    {
        if (mx <= 0) return 0;
        double r = Math.Clamp(mf / mx, 0, 1);
        return 1 - 2.59 * r + 5.11 * r * r - 3.52 * r * r * r;
    }

    static double OptimumReactionVelocity(double sigma, double beta, double betaOpt)
    {
        double a = 133.0 * Math.Pow(sigma, -0.7913);
        double b = Math.Pow(sigma, 1.5);
        double c = beta / betaOpt;
        double max = b / (495.0 + 0.0594 * b);
        return c > 0 ? max * Math.Pow(c, a) * Math.Exp(a * (1 - c)) : 0;
    }

    static int SizeClass(double sigma) => sigma >= 1200 ? 1 : sigma >= 192 ? 2 : sigma >= 96 ? 3 : sigma >= 48 ? 4 : sigma >= 16 ? 5 : 6;

    /// <summary>Byram flame length (m) from fireline intensity (kW/m), the same fit Behave and ELMFIRE use.</summary>
    public static double FlameLength(double intensityKwm) => intensityKwm > 0 ? 0.07747042253266703 * Math.Pow(intensityKwm, 0.46) : 0;

    /// <summary>Behave's length-to-width ratio (Andrews 2012), capped; at zero wind it is 1 (a circle).</summary>
    public static double LengthToWidth(double effectiveWindMPerMin, double cap)
    {
        double mph = effectiveWindMPerMin * 60 / 1609.344;
        double lw = 0.936 * Math.Exp(0.1147 * mph) + 0.461 * Math.Exp(-0.0692 * mph) - 0.397;
        return Math.Clamp(lw, 1, cap <= 0 ? 8 : cap);
    }
}
