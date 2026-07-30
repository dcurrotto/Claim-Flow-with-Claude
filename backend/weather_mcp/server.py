from typing import Any, Dict

import httpx
from mcp.server.fastmcp import FastMCP

GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# WMO weather codes relevant to P&C storm/weather-related loss claims.
_WEATHER_CODE_LABELS: Dict[int, str] = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    71: "Slight snowfall",
    73: "Moderate snowfall",
    75: "Heavy snowfall",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
}

mcp = FastMCP(
    "claim-flow-weather",
    instructions="Verifies weather conditions for a location and date, for cross-referencing P&C storm/weather claims.",
    stateless_http=True,
)


@mcp.tool()
async def geocode_location(location: str) -> Dict[str, Any]:
    """
    Resolve a place name to latitude/longitude coordinates.

    Pass a general locality (e.g. "Clearwater, FL"), not a full street
    address with house number and ZIP — the geocoder matches cities and
    towns, not individual addresses.

    Args:
        location: City and state/region, e.g. "Clearwater, FL"

    Returns:
        lat, lon, and the resolved place name — or an error if no match was found.
    """
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            GEOCODING_URL,
            params={"name": location, "count": 1, "language": "en", "format": "json"},
        )
        response.raise_for_status()
        data = response.json()

    results = data.get("results") or []
    if not results:
        return {"error": f"No location match found for '{location}'"}

    match = results[0]
    parts = [match.get("name"), match.get("admin1"), match.get("country")]
    return {
        "lat": match["latitude"],
        "lon": match["longitude"],
        "resolved_name": ", ".join(p for p in parts if p),
    }


@mcp.tool()
async def get_historical_weather(lat: float, lon: float, date: str) -> Dict[str, Any]:
    """
    Retrieve observed weather conditions for a specific coordinate and date.

    Args:
        lat: Latitude (from geocode_location)
        lon: Longitude (from geocode_location)
        date: Date of loss, format YYYY-MM-DD

    Returns:
        condition (human-readable), precipitation_mm, max_wind_kmh, temp_max_c,
        temp_min_c — or an error if the date/coordinates couldn't be resolved.
    """
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            ARCHIVE_URL,
            params={
                "latitude": lat,
                "longitude": lon,
                "start_date": date,
                "end_date": date,
                "daily": "weather_code,precipitation_sum,wind_speed_10m_max,temperature_2m_max,temperature_2m_min",
                "timezone": "auto",
            },
        )
        response.raise_for_status()
        data = response.json()

    daily = data.get("daily") or {}
    codes = daily.get("weather_code") or []
    if not codes:
        return {"error": f"No weather data available for {date} at ({lat}, {lon})"}

    code = codes[0]
    return {
        "date": date,
        "condition": _WEATHER_CODE_LABELS.get(code, f"Unknown (WMO code {code})"),
        "precipitation_mm": (daily.get("precipitation_sum") or [None])[0],
        "max_wind_kmh": (daily.get("wind_speed_10m_max") or [None])[0],
        "temp_max_c": (daily.get("temperature_2m_max") or [None])[0],
        "temp_min_c": (daily.get("temperature_2m_min") or [None])[0],
    }
