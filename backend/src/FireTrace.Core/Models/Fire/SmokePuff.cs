namespace FireTrace.Core.Models.Fire;

/// <summary>
/// Uma nuvem de fumo: onde está agora (m, grelha local, y para sul), a massa de partículas (g), a altura de emissão, o caminho que já fez e a distância
/// entre nuvens consecutivas da mesma fonte (para as nuvens se sobreporem numa coluna contínua em vez de contas soltas).
/// </summary>
public readonly record struct SmokePuff(double X, double Y, double MassG, double HeightM, double PathM, double AgeMinutes, double SpacingM);
