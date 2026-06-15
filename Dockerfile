# Base on Ubuntu from Docker Hub (reliable) and install .NET via the official
# install script. We deliberately avoid mcr.microsoft.com/dotnet/* images
# because Microsoft's container registry has been failing to serve them
# (HTTP 401/429). The install script pulls from a different, reliable CDN.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates libicu74 \
    && rm -rf /var/lib/apt/lists/*

# Install the .NET 10 SDK
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && chmod +x /tmp/dotnet-install.sh \
    && /tmp/dotnet-install.sh --channel 10.0 --install-dir /usr/share/dotnet \
    && rm /tmp/dotnet-install.sh
ENV DOTNET_ROOT=/usr/share/dotnet
ENV PATH="/usr/share/dotnet:${PATH}"
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1

WORKDIR /src
COPY *.csproj ./
RUN dotnet restore
COPY . ./
RUN dotnet publish -c Release -o /app

WORKDIR /app
# PORT is supplied by the hosting platform at runtime.
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "RunFromStalin.dll"]
