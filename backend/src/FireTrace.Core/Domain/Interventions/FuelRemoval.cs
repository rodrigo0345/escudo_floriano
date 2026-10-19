using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Interventions;

/// <summary>O que se tira numa faixa de gestão de combustível: o arvoredo, o sub-bosque ou tudo (solo mineral).</summary>
public enum FuelRemoval { Trees, Understory, All }
