# Single stage: build and run from the SDK image.
# (We intentionally avoid a separate dotnet/aspnet runtime image because
#  Microsoft's registry frequently rate-limits that pull with HTTP 429.
#  The SDK image can run the app directly.)
FROM mcr.microsoft.com/dotnet/sdk:10.0
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
