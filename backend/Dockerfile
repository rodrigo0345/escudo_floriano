# syntax=docker/dockerfile:1
# Build context is the repository root (the API serves ../api-spec/openapi.json):  docker build -f backend/Dockerfile --target api .

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY backend ./backend
RUN dotnet publish backend/src/FireTrace.Core -c Release -o /out/api \
 && dotnet publish backend/src/FireTrace.ExternalData -c Release -o /out/ingest

# ---- the API ---------------------------------------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS api
WORKDIR /app
COPY --from=build /out/api .
COPY api-spec ./api-spec
ENV FIRETRACE_URL=http://0.0.0.0:8080 \
    FIRETRACE_SPEC=/app/api-spec/openapi.json \
    FIRETRACE_LOCATIONS=/app/locations \
    FIRETRACE_DATA=/app/data
EXPOSE 8080
ENTRYPOINT ["dotnet", "FireTrace.Core.dll"]

# ---- the ingest command line (loads a location's third-party data into PostGIS / data folder) -------------------
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS ingest
WORKDIR /app
COPY --from=build /out/ingest .
ENV FIRETRACE_LOCATIONS=/app/locations \
    FIRETRACE_DATA=/app/data
ENTRYPOINT ["dotnet", "FireTrace.ExternalData.dll"]
