namespace FireTrace.Core.Domain.Errors;

/// <summary>A dependency the request needs (database, engine) is not ready; the client should try again shortly. The wire code stays `engine_unavailable` (see the contract's 503 response).</summary>
public sealed class ServiceUnavailableException(string message) : ApiException(message, "engine_unavailable", 503);
