from mangum import Mangum

from weather_mcp.server import mcp

app = mcp.streamable_http_app()

# API Gateway routes this Lambda behind the /mcp-weather prefix (see
# infrastructure/template.yaml); strip it so the app's internal routing
# (rooted at /mcp) matches regardless of the external path.
handler = Mangum(app, api_gateway_base_path="/mcp-weather")
