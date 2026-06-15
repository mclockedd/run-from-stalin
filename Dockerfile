# ---- build ----
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY *.csproj ./
RUN dotnet restore
COPY . ./
RUN dotnet publish -c Release -o /app

# ---- run ----
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app ./
# PORT is supplied by the hosting platform at runtime.
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "RunFromStalin.dll"]
