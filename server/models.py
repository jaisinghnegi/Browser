from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field

Id = Annotated[str, Field(pattern=r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')]


class PlannerRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    protocol: Annotated[int, Field(ge=1, le=1)]
    taskId: Id
    observationId: Id
    target: Id
    fieldKind: Literal['shipping-address']
    valueRef: Literal['ADDRESS_1']


class FillAction(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    action: Literal['fill']
    actionId: Id
    taskId: Id
    observationId: Id
    target: Id
    valueRef: Literal['ADDRESS_1']
