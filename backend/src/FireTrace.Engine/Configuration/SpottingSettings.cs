namespace FireTrace.Engine.Configuration;

/// <summary>
/// Projeção de faíscas do ELMFIRE: só a frente com intensidade acima de `CriticalFirelineIntensityKwm` projeta; `PignPct` é a probabilidade de uma faísca
/// pegar (entre Min e Max conforme a humidade); `EmberGenerationRate` quantas faíscas gera por área; `SurfaceFireSpottingPercent*` a fração do fogo de
/// superfície (não de copas) que projeta. São o que decide se o fogo salta estradas e rios e corre quilómetros a sotavento.
/// </summary>
public sealed record SpottingSettings(double CriticalFirelineIntensityKwm, double PignPct, double PignMinPct, double PignMaxPct, double EmberGenerationRate, double TauEmberGenSeconds,
    double EmberSamplingFactor, double SurfaceFireSpottingPercentMin, double SurfaceFireSpottingPercentMax, double MinSpottingDistanceM, double MaxSpottingDistanceM);
