"""
Nexus Message Schema — Pydantic models for the standardized Nexus JSON format.

All agents MUST send messages in this exact format.
The 'from' and 'to' fields are NEVER hardcoded — they come from each agent's config.yaml.
"""
from typing import Optional, Any
from pydantic import BaseModel, Field


class NexusHeader(BaseModel):
    from_agent: str = Field(alias="from")
    to: str
    date: str
    unix: int
    msg_type: str = "chat"

    model_config = {"populate_by_name": True}


class NexusMCP(BaseModel):
    """Transparency layer: documents which external tool/server the agent is calling."""
    server: str
    command: str
    params: dict[str, Any] = {}


class NexusImage(BaseModel):
    b64: str
    meta: dict[str, Any] = {}


class NexusPayload(BaseModel):
    type: str
    data: list[Any] = []
    image: Optional[NexusImage] = None


class NexusContent(BaseModel):
    text: str = ""


class NexusMessage(BaseModel):
    header: NexusHeader
    content: NexusContent = NexusContent()
    mcp: Optional[NexusMCP] = None
    payload: Optional[NexusPayload] = None
