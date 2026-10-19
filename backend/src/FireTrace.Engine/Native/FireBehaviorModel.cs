using FireTrace.Engine.Configuration;
using FireTrace.Engine.Contracts;

namespace FireTrace.Engine.Native;

/// <summary>
/// The fire physics of the native engine, as pure functions of the landscape bands: a light Rothermel rate of spread (fuel x wind x slope x moisture),
/// the elliptical spread shape, Byram fireline intensity and a Van Wagner style crown-fire test. Nothing here reads or writes state.
/// </summary>
public sealed class FireBehaviorModel(NativeEngineSettings settings, FuelMoistureSettings moisture)
{
    public double ReferenceRosMPerMin => settings.ReferenceRosMPerMin;

    /// <summary>Velocidade de referência (fator, 1 = a de referência) por combustível: Scott &amp; Burgan grosso modo, da classe não combustível à folhada mais grossa.
    /// A diferenciação fina por espécie já vem em <c>job.Adjustment</c> (SpreadFactor); isto só separa "não arde" / "arde pouco" / "arde bem".</summary>
    static double FuelFactor(int fbfm40) => fbfm40 switch
    {
        < 100 => 0.0,                 // NB: não combustível (água, rocha, urbano)
        >= 100 and < 120 => 0.6,      // GR: pasto
        >= 140 and < 160 => 1.0,      // SH: mato
        >= 160 and < 180 => 0.8,      // TU: floresta com sub-bosque
        >= 180 and < 190 => 0.55,     // TL: folhada
        _ => 0.7,
    };

    public double BaseRos(short[] bands, int n, int c) => FuelFactor(LandscapeBands.At(bands, n, LandscapeBands.Fuel, c));

    /// <summary>
    /// Humidade do combustível fino na célula, corrigida pela face da encosta: uma encosta virada a sul (no hemisfério norte) apanha mais sol,
    /// seca mais depressa — menos humidade, mais fogo; uma virada a norte fica mais húmida. Acima do limite de extinção não sustenta chama.
    /// </summary>
    public double MoistureFactor(double m1Pct, short[] bands, int n, int c)
    {
        double slopeDeg = LandscapeBands.At(bands, n, LandscapeBands.Slope, c);
        if (slopeDeg >= 0.5 && settings.AspectMoistureSwingPct > 0)
        {
            double aspect = LandscapeBands.At(bands, n, LandscapeBands.Aspect, c);
            double southness = -Math.Cos(aspect * Math.PI / 180); // +1 virada a sul (seca), -1 virada a norte (húmida)
            m1Pct = Math.Max(0, m1Pct - settings.AspectMoistureSwingPct * southness);
        }
        return m1Pct >= moisture.MinDeadMoisturePct * 10 ? 0.05 : Math.Exp(-settings.MoistureDampingK * m1Pct);
    }

    /// <summary>Coeficiente de vento de Rothermel, forma simplificada U^b: o vento acelera a frente, mais depressa a baixas velocidades.</summary>
    public double WindFactor(double windKmh) => 1 + settings.WindCoefficientA * Math.Pow(Math.Max(windKmh, 0), settings.WindCoefficientB);

    /// <summary>
    /// O vento que chega ao combustível de superfície, descontado o abrigo do dossel: um copado fechado (alto CanopyCoverPct) trava o vento
    /// antes de chegar ao chão — sub-bosque mais calmo, frente mais lenta; terreno aberto sem copado dá o vento quase todo à superfície.
    /// </summary>
    public double WindAtSurface(short[] bands, int n, int c, double ambientWindFactor)
    {
        double cover = LandscapeBands.At(bands, n, LandscapeBands.CanopyCover, c) / 100.0;
        double shelter = 1 - settings.CanopyWindShelterFactor * cover;
        return 1 + (ambientWindFactor - 1) * Math.Max(0.1, shelter);
    }

    /// <summary>
    /// Quanto mais depressa o fogo de copas avança, vindo de uma célula já em copas: um dossel mais denso e contínuo (CanopyBulkDensity)
    /// sustenta uma corrida de copas mais forte — o combustível fino do dossel está exposto ao vento pleno, sem o abrigo da superfície.
    /// </summary>
    public double CrownFireBoost(short[] bands, int n, int c)
    {
        double bulk = LandscapeBands.At(bands, n, LandscapeBands.CanopyBulkDensity, c) / 100.0; // kg/m³
        return 1 + settings.CrownFireRosBoost * Math.Min(1, bulk / settings.CrownFireReferenceBulkDensity);
    }

    /// <summary>Razão comprimento/largura da elipse de propagação: cresce com o vento (frentes fracas quase circulares; fortes, muito alongadas).</summary>
    public double EllipseRatio(double windKmh) => Math.Clamp(1 + (settings.MaxEllipseRatio - 1) * (windKmh / settings.EllipseWindRefKmh), settings.MinEllipseRatio, settings.MaxEllipseRatio);

    /// <summary>
    /// Forma de Huygens: o fator de velocidade numa direção `bearing` relativo ao vento, para uma elipse de razão `lb` com o foco na ignição
    /// (fórmula padrão de excentricidade a partir de L/W, usada pelo FARSITE/FlamMap). 1 na direção do vento, menor nos flancos e na retaguarda.
    /// </summary>
    public static double EllipseFactor(double bearingDeg, double windFromDeg, double lb)
    {
        double toDeg = (windFromDeg + 180) % 360; // para onde o vento sopra
        double theta = (bearingDeg - toDeg) * Math.PI / 180;
        double ecc = Math.Sqrt(Math.Max(1 - 1 / (lb * lb), 0));
        return (1 - ecc) / (1 - ecc * Math.Cos(theta));
    }

    /// <summary>Fator de declive de Rothermel (forma simplificada, tan²): sobe a favor da inclinação na direção do passo, desce contra ela.</summary>
    public double SlopeFactor(short[] bands, int n, int c, double bearingDeg)
    {
        double slopeDeg = LandscapeBands.At(bands, n, LandscapeBands.Slope, c), aspect = LandscapeBands.At(bands, n, LandscapeBands.Aspect, c);
        if (slopeDeg < 0.5) return 1;
        double tan = Math.Tan(slopeDeg * Math.PI / 180);
        // aspect = para onde a encosta desce; mover-se nessa direção é descer (mais devagar), no sentido oposto é subir (mais depressa)
        double along = -Math.Cos((bearingDeg - aspect) * Math.PI / 180); // +1 a direito a subir, -1 a descer
        return Math.Max(0.15, 1 + settings.SlopeCoefficient * along * tan * tan);
    }

    /// <summary>Intensidade da frente (kW/m, Byram): proporcional à carga de combustível (copado, como proxy do total) e à velocidade.</summary>
    public double FirelineIntensity(short[] bands, int n, int c, double rosMPerMin)
    {
        double bulk = LandscapeBands.At(bands, n, LandscapeBands.CanopyBulkDensity, c) / 100.0, height = LandscapeBands.At(bands, n, LandscapeBands.CanopyHeight, c) / 10.0;
        double load = Math.Max(0.3, bulk * height * settings.CrownFuelLoadFactor + 0.3); // kg/m², copado mais um piso de combustível de superfície
        return settings.FirelineIntensityFactor * load * rosMPerMin / 60; // kW/m
    }

    /// <summary>Critério de fogo de copas (Van Wagner, simplificado): intensidade acima de um limiar que desce com a base do copado mais baixa.</summary>
    public bool IsCrownFire(short[] bands, int n, int c, double intensityKwm)
    {
        double baseHeight = LandscapeBands.At(bands, n, LandscapeBands.CanopyBase, c) / 10.0, cover = LandscapeBands.At(bands, n, LandscapeBands.CanopyCover, c);
        if (cover < 10 || baseHeight <= 0) return false;
        double threshold = settings.CrownFireIntensityThresholdKwm * (0.3 + baseHeight / 10.0);
        return intensityKwm >= threshold;
    }
}
